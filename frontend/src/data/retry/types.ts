/**
 * 失败重试领域模型：失败记录 -> 重试批次 -> 采集作业，三条链路共用的结构。
 * 纯前端持久化到 localStorage，结构与后端实体保持一致，接回后端时只换存储实现。
 */

/** 一次具体的失败尝试，按发生顺序追加，历史尝试不重排、不覆盖。 */
export type FailureAttempt = {
  /** 批次内序号，从 1 开始；批次合并后多条失败共享同一批次，各自保留尝试序号 */
  seq: number
  /** 发生时间（毫秒时间戳） */
  at: number
  /** 入参原始异常码/名称，原样保留 */
  exceptionCode: string
  /** 清单标准化后的异常名称 */
  exceptionName: string
  /** 清单口径判定结果 */
  retryable: boolean
  /** 判定说明，页面可直接展示 */
  classificationReason: string
  /** 该次尝试是否来自老数据迁移，迁移记录排在最前且顺序保持不变 */
  legacy: boolean
  /** 触发来源，便于排查并发重复触发 */
  source: string
}

/** 重试批次生命周期状态。 */
export type RetryBatchStatus =
  /** 退避等待中：窗口未到期，任何触发都只能并入本批次，不能立刻重试 */
  | 'waiting'
  /** 正在执行一次重试（事务进行中） */
  | 'running'
  /** 重试成功，批次收口，历史失败尝试全部保留 */
  | 'recovered'
  /** 达到最大重试次数或命中不可重试异常，已失败转存（只转存一次） */
  | 'dumped'

/** 同一关联任务在等待窗口内只允许存在一个计划批次。 */
export type RetryBatch = {
  id: string
  /** 关联采集作业（关联任务），合并键 */
  jobKey: string
  /** 采用的重试策略编号，可空（老数据迁移时可能找不到策略） */
  strategyCode: string
  status: RetryBatchStatus
  /** 历史失败尝试，严格按发生顺序追加 */
  attempts: FailureAttempt[]
  /** 已合并进本批次的失败记录条数（并发重复触发只增这个计数，不重复算退避） */
  mergedFailureCount: number
  /** 已经执行过的重试次数（不含首次失败） */
  retryCount: number
  /** 最大重试次数，来自重试策略 */
  maxRetries: number
  /** 退避算法 */
  backoffAlgorithm: string
  /** 初始等待秒 */
  initialWaitSeconds: number
  /** 退避上限秒 */
  maxWaitSeconds: number
  /** 当前这一轮退避的等待秒数（同一批次并发触发只计算一次，后续触发沿用） */
  currentWaitSeconds: number
  /** 最近一次失败尝试时间，退避计时从这里开始 */
  lastAttemptAt: number | null
  /** 下一次允许重试的时间点；为空表示暂无下一次尝试（附 noNextAttemptReason） */
  nextAttemptAt: number | null
  /** 暂无下一次尝试的明确原因 */
  noNextAttemptReason: string
  /** 失败转存目标（来自策略「失败转存」字段） */
  dumpTarget: string
  /** 转存次数，用它保证「达到上限后只转存一次」 */
  dumpCount: number
  /** 转存时间 */
  dumpedAt: number | null
  /** 恢复（重试成功）时间 */
  recoveredAt: number | null
  /** 乐观锁版本号，并发触发/事务失败回退时做并发控制 */
  version: number
  /** 创建时间 */
  createdAt: number
  /** 最近更新时间 */
  updatedAt: number
  /** 备注，例如识别服务中断、中断恢复说明 */
  note: string
}

/** 重试策略的归一化视图，兼容 seed 里非数字的占位字段。 */
export type RetryPolicy = {
  rowId: number
  code: string
  jobKey: string
  maxRetries: number
  backoffAlgorithm: string
  initialWaitSeconds: number
  maxWaitSeconds: number
  /** 策略登记的可重试异常原文（仅留档，判定仍以已知异常清单为准） */
  retryableExceptionsText: string
  dumpTarget: string
  enabled: boolean
}

/** 采集作业的重试台账视图，供 spider/monitor 等页面同步等待/转存状态。 */
export type JobRetryView = {
  jobKey: string
  /** 页面主状态：等待退避 / 重试执行中 / 已恢复 / 已转存 / 无在途批次 */
  phase: 'idle' | 'waiting' | 'running' | 'recovered' | 'dumped'
  statusLabel: string
  batchId: string | null
  retryCount: number
  maxRetries: number
  mergedFailureCount: number
  lastAttemptAt: number | null
  nextAttemptAt: number | null
  /** 下一次尝试的解释；不能重试时写明原因 */
  nextAttemptHint: string
  dumpTarget: string
  dumpCount: number
  /** 最近一次异常说明 */
  latestException: string
}

export const RETRY_BATCH_STORAGE_KEY = 'scraper-config-studio:retry-batches'
export const RETRY_BATCH_SCHEMA_VERSION = 1
