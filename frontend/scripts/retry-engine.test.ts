/**
 * 重试批次引擎的确定性验证：假时钟 + 内存存储，不依赖浏览器。
 * 用 esbuild 打包后在 Node 下运行（npm run test:retry）。
 */
import { classifyException } from '../src/data/retry/exception-catalog'
import { migrateLegacyFailures } from '../src/data/retry/migration'
import { RetryBatchEngine, setPolicyRowsLoader, computeBackoffSeconds } from '../src/data/retry/retry-engine'
import type { RetryStorage } from '../src/data/retry/retry-store'
import type { EntryRow } from '../src/data/types'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

function section(name: string): void {
  console.log(`\n${name}`)
}

class MemoryStorage implements RetryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) as string : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  get raw(): Record<string, string> {
    return Object.fromEntries(this.map)
  }
}

function makePolicyRows(): EntryRow[] {
  return [
    {
      id: 1,
      status: '已启用',
      pending: false,
      abnormal: false,
      策略编号: 'RETR-0001',
      关联任务: 'JOB-A',
      最大重试次数: 3,
      退避算法: '指数退避',
      初始等待秒: 2,
      最大等待秒: 60,
      可重试异常: 'NETWORK_TIMEOUT',
      失败转存: 'dead-letter://JOB-A',
    },
    {
      id: 2,
      status: '已启用',
      pending: false,
      abnormal: false,
      策略编号: 'RETR-0002',
      关联任务: 'JOB-B',
      最大重试次数: 2,
      退避算法: '指数退避',
      初始等待秒: 5,
      最大等待秒: 120,
      可重试异常: 'NETWORK_TIMEOUT',
      失败转存: 'dead-letter://JOB-B',
    },
    {
      id: 3,
      status: '已启用',
      pending: false,
      abnormal: false,
      策略编号: 'RETR-0003',
      关联任务: 'JOB-C',
      最大重试次数: 3,
      退避算法: '指数退避',
      初始等待秒: 2,
      最大等待秒: 60,
      可重试异常: 'NETWORK_TIMEOUT',
      失败转存: 'dead-letter://JOB-C',
    },
  ]
}

function makeLegacyRows(): EntryRow[] {
  return [
    {
      id: 10,
      status: '已失败',
      pending: true,
      abnormal: true,
      作业编号: 'JOB-LEGACY-1',
      失败异常: 'NETWORK_TIMEOUT',
    },
    {
      id: 11,
      status: '已失败',
      pending: true,
      abnormal: true,
      作业编号: 'JOB-LEGACY-2',
      失败异常: 'AUTH_FAILED',
    },
  ]
}

async function main(): Promise<void> {
  setPolicyRowsLoader(() => makePolicyRows())

  // ---------- 1. 异常分类口径 ----------
  section('1. 异常分类：清单优先、冲突按不可重试、未知保守兜底')
  assert(classifyException('NETWORK_TIMEOUT').kind === 'retryable', 'NETWORK_TIMEOUT 可重试')
  assert(classifyException('AUTH_FAILED').kind === 'non-retryable', 'AUTH_FAILED 不可重试')
  assert(classifyException('RECOGNITION_SERVICE_DOWN').kind === 'non-retryable', '识别服务中断不可重试')
  assert(classifyException('WEIRD_NEW_ERROR').kind === 'non-retryable', '未知异常保守视为不可重试')
  assert(classifyException('WEIRD_NEW_ERROR', true).reason.includes('清单未登记'), '老记录标记不覆盖清单口径')
  assert(classifyException('网络连接超时').kind === 'retryable', '按中文名称也能命中清单（存量兼容）')
  assert(classifyException('').reason.includes('为空'), '空异常有可解释原因')

  // ---------- 2. 退避计算 ----------
  section('2. 指数退避计算')
  const policy = {
    rowId: 1, code: 'P', jobKey: 'JOB-A', maxRetries: 3, backoffAlgorithm: '指数退避',
    initialWaitSeconds: 2, maxWaitSeconds: 60, retryableExceptionsText: '', dumpTarget: 'x', enabled: true,
  }
  assert(computeBackoffSeconds(policy, 0) === 2, '第 0 次失败后等待 2 秒')
  assert(computeBackoffSeconds(policy, 1) === 4, '第 1 次失败后等待 4 秒')
  assert(computeBackoffSeconds(policy, 2) === 8, '第 2 次失败后等待 8 秒')
  assert(computeBackoffSeconds(policy, 10) === 60, '退避受最大等待秒封顶')

  // ---------- 3. 批次合并：等待窗口内共享一个计划批次、只算一次退避 ----------
  section('3. 并发重复失败：共享计划批次、只计算一次退避')
  let now = 1_000_000
  const storage = new MemoryStorage()
  const engine = new RetryBatchEngine(storage, () => now)

  const first = engine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'NETWORK_TIMEOUT' })
  assert(first.ok, '首次失败创建计划批次')
  const batchId = first.data.id
  const firstNextAt = first.data.nextAttemptAt as number
  assert(first.data.status === 'waiting', '批次进入等待退避')
  assert(first.data.currentWaitSeconds === 2, '首轮退避 2 秒')

  // 窗口未到期前连续两次失败上报（模拟并发/重复触发）
  now += 500
  const second = engine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'RATE_LIMITED' })
  now += 500
  const third = engine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'PROXY_FAILURE' })
  assert(second.data.id === batchId && third.data.id === batchId, '重复失败并入同一批次，没有新建批次')
  assert(second.data.nextAttemptAt === firstNextAt && third.data.nextAttemptAt === firstNextAt, '退避时间未被重算（只计算一次）')
  assert(third.data.mergedFailureCount === 3, '合并失败数累计为 3')
  assert(third.data.attempts.length === 3 && third.data.attempts[2].seq === 3, '三次失败尝试按顺序保留')

  // 并发重入：锁占用期间的触发直接共享计划，不产生额外写入
  class LockedEngine extends RetryBatchEngine {
    holdLock(jobKey: string): void {
      ;(this as unknown as { locks: Set<string> }).locks.add(jobKey)
    }
  }
  const lockEngine = new LockedEngine(new MemoryStorage(), () => now)
  const lockedFirst = lockEngine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'NETWORK_TIMEOUT' })
  lockEngine.holdLock('JOB-A')
  const lockedSecond = lockEngine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'NETWORK_TIMEOUT' })
  assert(lockedSecond.data?.id === lockedFirst.data.id, '并发触发复用同一批次')
  assert(lockedSecond.data?.nextAttemptAt === lockedFirst.data.nextAttemptAt, '并发触发不重算退避')
  assert(lockedSecond.message.includes('共享已排定的退避计划'), '并发触发返回共享计划说明')

  // ---------- 4. 窗口未到期不能重试 ----------
  section('4. 退避窗口未到期：拒绝重试，不跳过等待')
  const early = await engine.executeRetry(batchId, () => undefined)
  assert(!early.ok && early.message.includes('不能跳过等待'), '提前重试被拒绝并给出剩余等待说明')
  assert(engine.getBatch(batchId)?.status === 'waiting', '拒绝后批次仍是等待态')

  // ---------- 5. 事务失败退回等待，从最后一次尝试继续 ----------
  section('5. 重试事务失败：退回 waiting，退避从最后一次尝试继续')
  now = firstNextAt // 窗口到期
  const txFail = await engine.executeRetry(batchId, () => {
    throw new Error('RATE_LIMITED')
  })
  assert(!txFail.ok, '执行器抛错表示事务失败')
  const afterFail = engine.getBatch(batchId) as NonNullable<ReturnType<typeof engine.getBatch>>
  assert(afterFail.status === 'waiting', '事务失败后退回等待状态')
  assert(afterFail.retryCount === 1, '重试次数 +1')
  assert(afterFail.attempts.length === 4, '失败尝试追加且历史保留')
  assert(afterFail.currentWaitSeconds === 4, '第二轮退避按 2^(1)=4 秒')
  assert(
    afterFail.nextAttemptAt === (afterFail.lastAttemptAt as number) + 4000,
    '下一次尝试从最后一次尝试时间起算',
  )

  // ---------- 6. 成功恢复，保留全部失败尝试 ----------
  section('6. 到期重试成功：recovered 且历史失败尝试原样保留')
  now = afterFail.nextAttemptAt as number
  const ok = await engine.executeRetry(batchId, () => undefined)
  assert(ok.ok && ok.data.status === 'recovered', '重试成功，批次恢复')
  const recovered = engine.getBatch(batchId) as NonNullable<ReturnType<typeof engine.getBatch>>
  assert(recovered.attempts.length === 4, '恢复后 4 次失败尝试全部保留')
  assert(recovered.attempts.map((a) => a.seq).join(',') === '1,2,3,4', '尝试顺序保持 1→4')
  assert(recovered.nextAttemptAt === null && !recovered.noNextAttemptReason, '恢复后无下一次尝试且无错误原因')

  // 恢复后再上报失败：应开新批次，历史批次不被污染
  const again = engine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'NETWORK_TIMEOUT' })
  assert(again.data.id !== batchId, '恢复后再次失败开启新批次')

  // ---------- 7. 达到最大重试次数后只转存一次 ----------
  section('7. 最大重试次数：达上限后只转存一次')
  const b = engine.reportFailure({ jobKey: 'JOB-B', exceptionCode: 'NETWORK_TIMEOUT' })
  const bId = b.data.id
  assert(b.data.currentWaitSeconds === 5, 'JOB-B 首轮退避 5 秒')
  // maxRetries=2：第 1、2 次重试都失败 → 第二次失败后达上限转存
  now = b.data.nextAttemptAt as number
  const r1 = await engine.executeRetry(bId, () => { throw new Error('NETWORK_TIMEOUT') })
  assert(r1.data.status === 'waiting' && r1.data.retryCount === 1, '第 1 次重试失败，退回等待')
  now = r1.data.nextAttemptAt as number
  const r2 = await engine.executeRetry(bId, () => { throw new Error('NETWORK_TIMEOUT') })
  assert(r2.data.status === 'dumped', '第 2 次重试失败达上限，批次转存')
  const dumped = engine.getBatch(bId) as NonNullable<ReturnType<typeof engine.getBatch>>
  assert(dumped.dumpCount === 1, '只转存一次（dumpCount=1）')
  assert(dumped.nextAttemptAt === null && dumped.noNextAttemptReason.includes('最大重试次数'), '暂无下一次尝试且原因明确')
  // 再触发失败与重试，都不能产生第二次转存
  const mergeAfterDump = engine.reportFailure({ jobKey: 'JOB-B', exceptionCode: 'NETWORK_TIMEOUT' })
  const reRetry = await engine.executeRetry(bId, () => undefined)
  const dumpedAgain = engine.getBatch(bId) as NonNullable<ReturnType<typeof engine.getBatch>>
  assert(dumpedAgain.dumpCount === 1, '转存后重复触发不产生第二次转存')
  assert(!reRetry.ok && reRetry.message.includes('已转存'), '已转存批次拒绝再次重试并说明原因')
  assert(mergeAfterDump.ok && mergeAfterDump.data.id === bId && mergeAfterDump.data.status === 'dumped',
    '转存后失败上报只在原批次留痕，不产生新的在途批次')

  // ---------- 8. 不可重试异常直接转存 ----------
  section('8. 不可重试异常：不排退避，直接转存一次')
  const nr = engine.reportFailure({ jobKey: 'JOB-C', exceptionCode: 'AUTH_FAILED' })
  assert(nr.data.status === 'dumped', '不可重试异常直接进入转存')
  assert(nr.data.dumpCount === 1 && nr.data.nextAttemptAt === null, '只转存一次且无下一次尝试')
  const nrAgain = engine.reportFailure({ jobKey: 'JOB-C', exceptionCode: 'AUTH_FAILED' })
  assert(nrAgain.data.id === nr.data.id && nrAgain.data.dumpCount === 1, '不可重试重复上报仍只转存一次')

  // ---------- 9. 中断恢复：running 重新加载后退回 waiting ----------
  section('9. 中断恢复：running 落盘后重新加载，退回 waiting 且沿用最后尝试')
  const c = engine.reportFailure({ jobKey: 'JOB-A', exceptionCode: 'NETWORK_TIMEOUT' })
  const cId = c.data.id
  const scheduledAt = c.data.nextAttemptAt as number
  now = scheduledAt
  // 不 await：模拟执行到一半页面关闭；先让 running 落盘
  const pending = engine.executeRetry(cId, () => new Promise<void>(() => undefined))
  assert(engine.getBatch(cId)?.status === 'running', '执行中批次为 running 并已落盘')
  const reloaded = new RetryBatchEngine(storage, () => now + 1000)
  const recoveredBatch = reloaded.getBatch(cId) as NonNullable<ReturnType<typeof reloaded.getBatch>>
  assert(recoveredBatch.status === 'waiting', '中断恢复后 running 退回 waiting')
  assert(recoveredBatch.nextAttemptAt === scheduledAt, '沿用原定退避窗口，不重算、不跳过等待')
  assert(recoveredBatch.attempts.length === c.data.attempts.length, '中断不丢历史尝试')
  // 清理悬挂 Promise（Node 下不 await 也会被进程退出回收）
  void pending

  // ---------- 10. 存量迁移 ----------
  section('10. 存量兼容：历史失败记录迁移，顺序保留且只迁一次')
  const migrationStorage = new MemoryStorage()
  const migrationEngine = new RetryBatchEngine(migrationStorage, () => Date.now())
  const summary = migrateLegacyFailures(migrationEngine, makeLegacyRows(), migrationStorage as unknown as Storage)
  assert(summary.migrated === 2, `迁移 2 条历史失败（实际 ${summary.migrated}）`)
  assert(summary.waiting === 1 && summary.dumped === 1, '可重试记录进入等待、不可重试记录直接转存')
  const legacyBatch = migrationEngine.getActiveBatch('JOB-LEGACY-1')
  assert(legacyBatch?.attempts[0].legacy === true, '历史尝试带 legacy 标记')
  const summary2 = migrateLegacyFailures(migrationEngine, makeLegacyRows(), migrationStorage as unknown as Storage)
  assert(summary2.migrated === 0, '迁移只执行一次，重复调用跳过')

  // ---------- 11. 持久化往返与宽容读取 ----------
  section('11. 持久化：刷新后批次仍在，脏数据不致命')
  const reloaded2 = new RetryBatchEngine(storage, () => now)
  assert(reloaded2.listBatches().length === engine.listBatches().length, '重新加载后批次数量一致')
  const dirty = new MemoryStorage()
  dirty.setItem(Object.keys(storage.raw)[0] ?? 'x', '{not-json')
  const tolerant = new RetryBatchEngine(dirty, () => now)
  assert(tolerant.listBatches().length === 0, '存储损坏时宽容返回空台账，不抛异常')

  // ---------- 12. 作业台账视图 ----------
  section('12. 采集作业视图：等待/转存相位与解释')
  const view = engine.jobView('JOB-B')
  assert(view.phase === 'dumped' && view.statusLabel === '已失败转存', 'JOB-B 视图显示已转存')
  assert(view.nextAttemptHint.includes('暂无下一次尝试'), '转存视图明确暂无下一次尝试的原因')
  const idleView = engine.jobView('JOB-NEVER-FAILED')
  assert(idleView.phase === 'idle' && idleView.nextAttemptHint.includes('暂无失败记录'), '无失败作业有空态说明')

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
