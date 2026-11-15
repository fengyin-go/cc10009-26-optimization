/**
 * 重试策略读取：把通用台账里的 retry 行（字段可能是占位文本）归一化成可计算的策略。
 * 解析不到数字时用领域默认值兜底，保证存量策略不用手工修数据也能参与退避计算。
 */
import type { EntryRow } from '@/data/types'

import type { RetryPolicy } from './types'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_WAIT = 2
const DEFAULT_MAX_WAIT = 60

function parseNumber(value: string | number | boolean | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const matched = String(value ?? '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return fallback
  }
  const parsed = Number(matched[0])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function toPolicy(row: EntryRow): RetryPolicy {
  const enabled = String(row.status) === '已启用'
  return {
    rowId: Number(row.id),
    code: String(row['策略编号'] ?? `RETR-${row.id}`),
    jobKey: String(row['关联任务'] ?? ''),
    maxRetries: parseNumber(row['最大重试次数'], DEFAULT_MAX_RETRIES),
    backoffAlgorithm: String(row['退避算法'] ?? '指数退避'),
    initialWaitSeconds: parseNumber(row['初始等待秒'], DEFAULT_INITIAL_WAIT),
    maxWaitSeconds: parseNumber(row['最大等待秒'], DEFAULT_MAX_WAIT),
    retryableExceptionsText: String(row['可重试异常'] ?? ''),
    dumpTarget: String(row['失败转存'] || '失败转存区'),
    enabled,
  }
}

/** 同一关联任务可能登记多条策略：已启用优先，其次取编号最小的，保证口径稳定。 */
export function pickPolicy(rows: EntryRow[], jobKey: string): RetryPolicy | null {
  const policies = rows
    .map(toPolicy)
    .filter((policy) => policy.jobKey === jobKey)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.rowId - b.rowId)
  return policies[0] ?? null
}

export const POLICY_DEFAULTS = {
  maxRetries: DEFAULT_MAX_RETRIES,
  initialWaitSeconds: DEFAULT_INITIAL_WAIT,
  maxWaitSeconds: DEFAULT_MAX_WAIT,
}
