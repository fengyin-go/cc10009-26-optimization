/**
 * 重试批次引擎：失败记录 → 重试批次 → 采集作业 三条链路的核心编排。
 *
 * 关键不变量（对应需求）：
 * 1. 同一关联任务在等待窗口内只共享一个计划批次：reportFailure 命中 waiting/running 批次时只并入，
 *    不新建批次、不重算退避（退避只在真正产生新一轮失败的那次触发时计算一次）；
 * 2. 并发触发同一批次只计算一次退避：批次上有进程内锁，第二个触发拿到的是已排好的 nextAttemptAt；
 * 3. 退避窗口未到期不能重试：executeRetry 直接拒绝，不跳过等待；
 * 4. 达到最大重试次数后只转存一次：dumpCount 作为幂等闸门；
 * 5. 事务失败退回 waiting：executeRetry 注入的执行器抛错时，批次回到 waiting 并保留最后尝试；
 * 6. 中断恢复从最后一次尝试继续：加载时 running 批次统一回退 waiting（见 retry-store）；
 * 7. 历史失败尝试按原顺序保留：attempts 只追加，恢复/转存都不清空；
 * 8. 可重试/不可重试冲突以已知异常清单为准（见 exception-catalog）。
 */
import { listRows } from '@/data/local-store'
import { classifyException } from './exception-catalog'
import { POLICY_DEFAULTS, pickPolicy } from './policy'
import {
  defaultClock,
  loadBatches,
  persistBatches,
  type Clock,
  type RetryStorage,
} from './retry-store'
import type {
  FailureAttempt,
  JobRetryView,
  RetryBatch,
  RetryBatchStatus,
  RetryPolicy,
} from './types'

export type ReportFailureInput = {
  jobKey: string
  exceptionCode: string
  /** 老失败记录自带的可重试标记，仅留档，清单优先 */
  legacyRetryable?: boolean
  source?: string
  /** 迁移历史失败记录时使用，引擎不会为其重算退避 */
  legacy?: boolean
  at?: number
}

export type EngineResult<T = RetryBatch> = { ok: true; data: T; message: string } | {
  ok: false
  message: string
  /** 拒绝时仍返回当前批次快照，便于页面解释空态 */
  data?: RetryBatch
}

/** 重试执行器：由上层注入（模拟真实采集调用），抛错即视为本次重试事务失败。 */
export type RetryExecutor = (batch: RetryBatch) => void | Promise<void>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 指数退避：min(初始等待 * 2^已重试次数, 最大等待)。同一批次的一轮失败只调用一次。 */
export function computeBackoffSeconds(policy: RetryPolicy, retryCount: number): number {
  const base = Math.max(policy.initialWaitSeconds, 1)
  const raw = base * Math.pow(2, Math.max(retryCount, 0))
  return Math.min(Math.round(raw), Math.max(policy.maxWaitSeconds, base))
}

export class RetryBatchEngine {
  private batches: RetryBatch[]
  private readonly storage: RetryStorage | undefined
  private readonly clock: Clock
  /** 批次级互斥：同一批次并发触发时，后来的调用并入已排好的计划，不重复算退避 */
  private readonly locks = new Set<string>()

  constructor(storage?: RetryStorage, clock: Clock = defaultClock) {
    this.storage = storage
    this.clock = clock
    this.batches = loadBatches(storage, clock)
  }

  private now(): number {
    return this.clock()
  }

  private save(): void {
    persistBatches(this.storage, this.batches)
  }

  private findIndex(jobKey: string): number {
    return this.batches.findIndex(
      (batch) => batch.jobKey === jobKey && (batch.status === 'waiting' || batch.status === 'running'),
    )
  }

  listBatches(): RetryBatch[] {
    return clone(this.batches).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getBatch(batchId: string): RetryBatch | undefined {
    const batch = this.batches.find((item) => item.id === batchId)
    return batch ? clone(batch) : undefined
  }

  getActiveBatch(jobKey: string): RetryBatch | undefined {
    const index = this.findIndex(jobKey)
    return index >= 0 ? clone(this.batches[index]) : undefined
  }

  private resolvePolicy(jobKey: string): RetryPolicy {
    const rows = this.policyRows()
    return (
      pickPolicy(rows, jobKey) ?? {
        rowId: 0,
        code: '',
        jobKey,
        maxRetries: POLICY_DEFAULTS.maxRetries,
        backoffAlgorithm: '指数退避',
        initialWaitSeconds: POLICY_DEFAULTS.initialWaitSeconds,
        maxWaitSeconds: POLICY_DEFAULTS.maxWaitSeconds,
        retryableExceptionsText: '',
        dumpTarget: '失败转存区',
        enabled: false,
      }
    )
  }

  /** 策略来源可在测试里覆写；默认读通用台账的 retry 行。 */
  protected policyRows() {
    return policyRowsLoaderFn()
  }

  private buildAttempt(input: ReportFailureInput, seq: number): FailureAttempt {
    const classification = classifyException(input.exceptionCode, input.legacyRetryable)
    return {
      seq,
      at: input.at ?? this.now(),
      exceptionCode: input.exceptionCode,
      exceptionName: classification.matchedName,
      retryable: classification.kind === 'retryable',
      classificationReason: classification.reason,
      legacy: input.legacy === true,
      source: input.source ?? '采集失败上报',
    }
  }

  /**
   * 上报一次采集失败。
   * 并发语义：waiting/running 批次存在时并入（mergedFailureCount+1、attempts 追加），
   * 只有首次失败或需要开启新一轮退避时才计算退避。
   */
  reportFailure(input: ReportFailureInput): EngineResult {
    if (!input.jobKey) {
      return { ok: false, message: '上报失败缺少关联任务，无法归并重试批次' }
    }
    if (this.locks.has(input.jobKey)) {
      const active = this.getActiveBatch(input.jobKey)
      return {
        ok: true,
        data: active as RetryBatch,
        message: '同一关联任务的失败上报正在合并中，本次触发共享已排定的退避计划，不重复计算等待',
      }
    }
    this.locks.add(input.jobKey)
    try {
      const now = this.now()
      const index = this.findIndex(input.jobKey)
      const attempt = this.buildAttempt(input, index >= 0 ? this.batches[index].attempts.length + 1 : 1)

      // 命中在途批次：只合并，不新建、不重算退避
      if (index >= 0) {
        const batch = clone(this.batches[index])
        batch.attempts.push(attempt)
        batch.mergedFailureCount += 1
        batch.updatedAt = now
        if (batch.status === 'running') {
          batch.note = '执行窗口内再次收到失败上报，已并入当前重试批次'
        } else {
          batch.note = `退避等待窗口内收到重复失败，已并入计划批次（累计合并 ${batch.mergedFailureCount} 条），沿用原退避时间`
        }
        this.batches[index] = batch
        this.save()
        return {
          ok: true,
          data: clone(batch),
          message: `失败已并入批次 ${batch.id}，等待窗口内共享同一退避计划`,
        }
      }

      // 已转存批次：失败只留痕并幂等拦截，绝不开新的在途计划、不产生第二次转存
      const dumpedIndex = this.batches.findIndex(
        (batch) => batch.jobKey === input.jobKey && batch.status === 'dumped',
      )
      if (dumpedIndex >= 0) {
        const batch = clone(this.batches[dumpedIndex])
        batch.attempts.push(attempt)
        batch.mergedFailureCount += 1
        batch.updatedAt = now
        batch.note = `批次已转存（${batch.dumpTarget}），新失败仅留痕；转存仍只执行一次，不再安排重试`
        this.batches[dumpedIndex] = batch
        this.save()
        return {
          ok: true,
          data: clone(batch),
          message: `批次已转存，本次失败只登记不重试：${batch.noNextAttemptReason}`,
        }
      }

      // 已恢复批次属于历史：新一轮失败允许开启新批次（见下方创建逻辑）
      // 没有在途批次：新建计划批次（或接续已收口批次的历史，开新批次）
      const policy = this.resolvePolicy(input.jobKey)
      const isLegacy = input.legacy === true
      const batch: RetryBatch = {
        id: `BATCH-${input.jobKey}-${now}`,
        jobKey: input.jobKey,
        strategyCode: policy.code,
        status: 'waiting',
        attempts: [attempt],
        mergedFailureCount: 1,
        retryCount: 0,
        maxRetries: policy.maxRetries,
        backoffAlgorithm: policy.backoffAlgorithm,
        initialWaitSeconds: policy.initialWaitSeconds,
        maxWaitSeconds: policy.maxWaitSeconds,
        currentWaitSeconds: 0,
        lastAttemptAt: attempt.at,
        nextAttemptAt: null,
        noNextAttemptReason: '',
        dumpTarget: policy.dumpTarget,
        dumpCount: 0,
        dumpedAt: null,
        recoveredAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        note: isLegacy ? '由历史失败记录迁移生成' : '',
      }

      if (!attempt.retryable) {
        // 不可重试：不排退避，直接进入转存流程（只转存一次）
        this.dumpOnce(batch, attempt.classificationReason, now)
        this.batches.push(batch)
        this.save()
        return {
          ok: true,
          data: clone(batch),
          message: `异常不可重试，批次已转存至${batch.dumpTarget}（仅转存一次）`,
        }
      }

      // 可重试：这是本轮唯一一次退避计算
      batch.currentWaitSeconds = computeBackoffSeconds(policy, batch.retryCount)
      batch.nextAttemptAt = attempt.at + batch.currentWaitSeconds * 1000
      batch.note = isLegacy
        ? `${batch.note}；历史记录按策略补排首次退避`
        : `已按${batch.backoffAlgorithm}排定首次退避 ${batch.currentWaitSeconds} 秒`
      this.batches.push(batch)
      this.save()
      return {
        ok: true,
        data: clone(batch),
        message: `已创建计划批次，退避 ${batch.currentWaitSeconds} 秒后允许重试`,
      }
    } finally {
      this.locks.delete(input.jobKey)
    }
  }

  /** 转存幂等闸门：dumpCount 只允许 0→1，重复触发不再产生转存。返回是否真的执行了转存。 */
  private dumpOnce(batch: RetryBatch, reason: string, now: number): boolean {
    if (batch.dumpCount > 0) {
      batch.note = `转存已执行过（${batch.dumpTarget}），重复触发被幂等拦截`
      return false
    }
    batch.status = 'dumped'
    batch.dumpCount = 1
    batch.dumpedAt = now
    batch.nextAttemptAt = null
    batch.noNextAttemptReason = reason
    batch.updatedAt = now
    batch.note = reason
    return true
  }

  /**
   * 到期执行一次重试。
   * - 窗口未到期：拒绝，不跳过等待；
   * - 执行器抛错（事务失败）：退回 waiting，从最后一次尝试继续，退避重新排一轮；
   * - 执行器成功：recovered，历史尝试全部保留；
   * - 失败后达到上限：只转存一次。
   */
  async executeRetry(batchId: string, executor: RetryExecutor): Promise<EngineResult> {
    const index = this.batches.findIndex((item) => item.id === batchId)
    if (index < 0) {
      return { ok: false, message: `没有找到重试批次 ${batchId}` }
    }
    const now = this.now()
    const batch = clone(this.batches[index])

    if (batch.status === 'dumped') {
      return {
        ok: false,
        data: batch,
        message: `批次已转存至${batch.dumpTarget}，暂无下一次尝试：${batch.noNextAttemptReason}`,
      }
    }
    if (batch.status === 'recovered') {
      return { ok: false, data: batch, message: '批次已成功恢复，无需再次重试' }
    }
    if (batch.status === 'running') {
      return { ok: false, data: batch, message: '批次正在执行重试，请勿并发触发' }
    }
    if (batch.nextAttemptAt != null && now < batch.nextAttemptAt) {
      const remainMs = batch.nextAttemptAt - now
      return {
        ok: false,
        data: batch,
        message: `退避窗口尚未到期，还需等待 ${(remainMs / 1000).toFixed(1)} 秒，不能跳过等待直接重试`,
      }
    }

    // 进入事务：先占 running 并落盘，中断后加载时可识别并退回 waiting
    const policy = this.resolvePolicy(batch.jobKey)
    batch.status = 'running'
    batch.version += 1
    batch.updatedAt = now
    batch.note = '重试事务执行中，若中断将在下次加载时退回等待并保留最后一次尝试'
    this.batches[index] = batch
    this.save()

    try {
      await executor(clone(batch))
    } catch (error) {
      // 事务失败：退回 waiting，记录一次新的失败尝试，退避从最后一次尝试继续排
      const failureMessage = error instanceof Error ? error.message : String(error)
      const rollback = clone(this.batches[index])
      const attempt: FailureAttempt = {
        seq: rollback.attempts.length + 1,
        at: this.now(),
        exceptionCode: failureMessage,
        exceptionName: classifyException(failureMessage).matchedName,
        retryable: classifyException(failureMessage).kind === 'retryable',
        classificationReason: `重试事务失败：${classifyException(failureMessage).reason}`,
        legacy: false,
        source: '重试执行器',
      }
      rollback.attempts.push(attempt)
      rollback.mergedFailureCount += 1
      rollback.retryCount += 1
      rollback.lastAttemptAt = attempt.at
      rollback.status = 'waiting'
      rollback.updatedAt = this.now()

      let rolledBackToDump = false
      if (!attempt.retryable || rollback.retryCount >= rollback.maxRetries) {
        const reason = !attempt.retryable
          ? attempt.classificationReason
          : `已达最大重试次数 ${rollback.maxRetries}，不再安排下一次尝试`
        rolledBackToDump = this.dumpOnce(rollback, reason, this.now())
      } else {
        rollback.currentWaitSeconds = computeBackoffSeconds(policy, rollback.retryCount)
        rollback.nextAttemptAt = attempt.at + rollback.currentWaitSeconds * 1000
        rollback.noNextAttemptReason = ''
        rollback.note = `事务失败已退回等待，按第 ${rollback.retryCount} 次重试后的退避窗口继续，未跳过等待`
      }
      this.batches[index] = rollback
      this.save()
      return {
        ok: false,
        data: clone(rollback),
        message: rolledBackToDump
          ? `重试事务失败且${rollback.noNextAttemptReason}，已转存一次`
          : '重试事务失败，已退回退避等待，从最后一次尝试继续',
      }
    }

    // 成功恢复：保留全部历史失败尝试
    const recovered = clone(this.batches[index])
    recovered.status = 'recovered'
    recovered.recoveredAt = this.now()
    recovered.nextAttemptAt = null
    recovered.noNextAttemptReason = ''
    recovered.updatedAt = this.now()
    recovered.note = `重试成功，已恢复采集；${recovered.attempts.length} 次历史失败尝试按原顺序保留`
    this.batches[index] = recovered
    this.save()
    return { ok: true, data: clone(recovered), message: '重试成功，采集作业已恢复，历史失败尝试已保留' }
  }

  /** 供页面/测试驱动：把一次「采集失败重试后又失败」的结果显式上报（非异常路径用）。 */
  recordRetryOutcome(batchId: string, success: boolean, exceptionCode?: string): EngineResult {
    const index = this.batches.findIndex((item) => item.id === batchId)
    if (index < 0) {
      return { ok: false, message: `没有找到重试批次 ${batchId}` }
    }
    if (success) {
      const batch = clone(this.batches[index])
      batch.status = 'recovered'
      batch.recoveredAt = this.now()
      batch.nextAttemptAt = null
      batch.noNextAttemptReason = ''
      batch.updatedAt = this.now()
      batch.note = `重试成功，已恢复采集；${batch.attempts.length} 次历史失败尝试按原顺序保留`
      this.batches[index] = batch
      this.save()
      return { ok: true, data: clone(batch), message: '采集已恢复' }
    }
    // 失败：复用上报合并 + 退避/转存判定
    const current = this.batches[index]
    return this.reportFailure({
      jobKey: current.jobKey,
      exceptionCode: exceptionCode ?? 'NETWORK_TIMEOUT',
      source: '重试结果回写',
    })
  }

  /** 采集作业台账视图：其它页面同步等待/转存状态都走这里。 */
  jobView(jobKey: string): JobRetryView {
    const batch = this.batches
      .filter((item) => item.jobKey === jobKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]

    if (!batch) {
      return {
        jobKey,
        phase: 'idle',
        statusLabel: '无在途重试',
        batchId: null,
        retryCount: 0,
        maxRetries: 0,
        mergedFailureCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        nextAttemptHint: '该作业暂无失败记录，没有下一次尝试',
        dumpTarget: '',
        dumpCount: 0,
        latestException: '',
      }
    }

    const latest = batch.attempts[batch.attempts.length - 1]
    const labelMap: Record<RetryBatchStatus, string> = {
      waiting: '正在等待退避',
      running: '重试执行中',
      recovered: '已恢复（保留失败尝试）',
      dumped: '已失败转存',
    }
    const hintMap: Record<RetryBatchStatus, string> = {
      waiting:
        batch.nextAttemptAt == null
          ? `暂无下一次尝试：${batch.noNextAttemptReason || '退避计划缺失'}`
          : `下一次尝试 ${new Date(batch.nextAttemptAt).toLocaleTimeString()} 到期（等待 ${batch.currentWaitSeconds} 秒）`,
      running: '重试事务执行中，中断后会退回等待并从最后一次尝试恢复',
      recovered: '已成功恢复，历史失败尝试按原顺序保留，无需再次尝试',
      dumped: `暂无下一次尝试：${batch.noNextAttemptReason || '已达到重试上限'}；批次已转存至${batch.dumpTarget}`,
    }

    return {
      jobKey,
      phase: batch.status,
      statusLabel: labelMap[batch.status],
      batchId: batch.id,
      retryCount: batch.retryCount,
      maxRetries: batch.maxRetries,
      mergedFailureCount: batch.mergedFailureCount,
      lastAttemptAt: batch.lastAttemptAt,
      nextAttemptAt: batch.nextAttemptAt,
      nextAttemptHint: hintMap[batch.status],
      dumpTarget: batch.dumpTarget,
      dumpCount: batch.dumpCount,
      latestException: latest
        ? `${latest.exceptionName}（第 ${latest.seq} 次，${latest.classificationReason}）`
        : '',
    }
  }

  /** 清空并重播种（演示/测试用）。 */
  replaceAll(batches: RetryBatch[]): void {
    this.batches = clone(batches)
    this.save()
  }

  reset(): void {
    this.batches = []
    this.locks.clear()
    this.save()
  }
}

/** 隔离 localStorage 依赖：测试里覆写这个 loader 注入内存台账。 */
let policyRowsLoaderFn: () => import('@/data/types').EntryRow[] = () => listRows('retry')

export function setPolicyRowsLoader(loader: () => import('@/data/types').EntryRow[]): void {
  policyRowsLoaderFn = loader
}
