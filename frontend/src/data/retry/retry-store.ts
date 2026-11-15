/**
 * 重试批次的本地持久化：与 entries 分开存，避免污染通用 CRUD 台账。
 * 存储与时钟都可注入，核心引擎因此可以在 Node 下用假时钟做确定性测试。
 */
import {
  RETRY_BATCH_SCHEMA_VERSION,
  RETRY_BATCH_STORAGE_KEY,
} from './types'
import type { FailureAttempt, RetryBatch } from './types'

export type Clock = () => number

export const defaultClock: Clock = () => Date.now()

export type RetryStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type PersistedPayload = {
  schemaVersion: number
  batches: RetryBatch[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 中断恢复：进程/页面关掉时停在 running 的批次，重新加载后一律退回 waiting，
 *  保留最后一次尝试与原定的下一次尝试时间，不重算退避、不跳过等待。 */
function recoverInterrupted(batches: RetryBatch[], now: number): RetryBatch[] {
  return batches.map((batch) => {
    if (batch.status !== 'running') {
      return batch
    }
    const nextAttemptAt =
      batch.nextAttemptAt ?? (batch.lastAttemptAt ?? now) + batch.currentWaitSeconds * 1000
    return {
      ...batch,
      status: 'waiting',
      nextAttemptAt,
      noNextAttemptReason: '',
      note: `退避等待在执行中断后恢复，沿用最后一次尝试后的退避窗口（原定 ${formatTime(
        nextAttemptAt,
      )} 到期），不跳过等待`,
      updatedAt: now,
    }
  })
}

function normalizeAttempt(raw: Partial<FailureAttempt>, index: number): FailureAttempt {
  return {
    seq: Number(raw.seq) || index + 1,
    at: Number(raw.at) || 0,
    exceptionCode: String(raw.exceptionCode ?? ''),
    exceptionName: String(raw.exceptionName ?? raw.exceptionCode ?? ''),
    retryable: Boolean(raw.retryable),
    classificationReason: String(raw.classificationReason ?? '历史记录，按当前异常清单重新解释'),
    legacy: raw.legacy !== false,
    source: String(raw.source ?? '历史失败记录'),
  }
}

/** 宽容读取：老数据缺字段、类型不对都补齐，不丢历史尝试，顺序保持原样。 */
export function normalizeBatch(raw: Partial<RetryBatch>, now: number): RetryBatch {
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.map((item, index) => normalizeAttempt(item, index))
    : []
  const status = raw.status === 'running' ? 'waiting' : raw.status ?? 'waiting'
  return {
    id: String(raw.id ?? `BATCH-${raw.jobKey ?? 'UNKNOWN'}-${now}`),
    jobKey: String(raw.jobKey ?? ''),
    strategyCode: String(raw.strategyCode ?? ''),
    status: status as RetryBatch['status'],
    attempts,
    mergedFailureCount: Number(raw.mergedFailureCount) || attempts.length || 0,
    retryCount: Number(raw.retryCount) || 0,
    maxRetries: Number(raw.maxRetries) || 3,
    backoffAlgorithm: String(raw.backoffAlgorithm ?? '指数退避'),
    initialWaitSeconds: Number(raw.initialWaitSeconds) || 1,
    maxWaitSeconds: Number(raw.maxWaitSeconds) || 60,
    currentWaitSeconds: Number(raw.currentWaitSeconds) || 0,
    lastAttemptAt: raw.lastAttemptAt == null ? null : Number(raw.lastAttemptAt),
    nextAttemptAt: raw.nextAttemptAt == null ? null : Number(raw.nextAttemptAt),
    noNextAttemptReason: String(raw.noNextAttemptReason ?? ''),
    dumpTarget: String(raw.dumpTarget ?? '失败转存区'),
    dumpCount: Number(raw.dumpCount) || 0,
    dumpedAt: raw.dumpedAt == null ? null : Number(raw.dumpedAt),
    recoveredAt: raw.recoveredAt == null ? null : Number(raw.recoveredAt),
    version: Number(raw.version) || 1,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    note: String(raw.note ?? ''),
  }
}

export function loadBatches(storage: RetryStorage | undefined, clock: Clock): RetryBatch[] {
  const now = clock()
  if (!storage) {
    return []
  }
  const raw = storage.getItem(RETRY_BATCH_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as PersistedPayload | RetryBatch[]
    const list = Array.isArray(parsed) ? parsed : parsed.batches ?? []
    const normalized = list.map((item) => normalizeBatch(item, now))
    return recoverInterrupted(normalized, now)
  } catch {
    // 存储损坏：保守起见不自动清空，返回空台账并由调用方重新播种，避免脏数据反复报错
    return []
  }
}

export function persistBatches(
  storage: RetryStorage | undefined,
  batches: RetryBatch[],
): void {
  if (!storage) {
    return
  }
  const payload: PersistedPayload = {
    schemaVersion: RETRY_BATCH_SCHEMA_VERSION,
    batches: clone(batches),
  }
  storage.setItem(RETRY_BATCH_STORAGE_KEY, JSON.stringify(payload))
}

export function formatTime(timestamp: number | null): string {
  if (timestamp == null) {
    return '无'
  }
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
