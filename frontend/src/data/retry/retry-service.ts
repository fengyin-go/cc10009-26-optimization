/**
 * 浏览器侧重试服务：单例引擎 + 一次性存量迁移 + 页面可直接调用的动作封装。
 * 页面组件不直接操作引擎，业务判断仍收口在数据/服务层（与 README 约定一致）。
 */
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { migrateLegacyFailures, MIGRATION_MARK_KEY } from './migration'
import { RetryBatchEngine } from './retry-engine'
import type { EngineResult, RetryExecutor } from './retry-engine'
import type { JobRetryView, RetryBatch } from './types'

let engine: RetryBatchEngine | null = null

function browserStorage(): Storage | undefined {
  return typeof window !== 'undefined' && window.localStorage ? window.localStorage : undefined
}

export function retryEngine(): RetryBatchEngine {
  if (engine) {
    return engine
  }
  engine = new RetryBatchEngine(browserStorage())
  // 首次使用时把 spider 台账里的历史失败迁成批次（只迁一次）
  migrateLegacyFailures(engine, listRows('spider'), browserStorage())
  return engine
}

/** 测试或「重置演示数据」时重建引擎。 */
export function resetRetryEngine(): void {
  const storage = browserStorage()
  storage?.removeItem(MIGRATION_MARK_KEY)
  engine = new RetryBatchEngine(storage)
  engine.reset()
  migrateLegacyFailures(engine, listRows('spider'), storage)
}

export function listRetryBatches(): RetryBatch[] {
  return retryEngine().listBatches()
}

export function getRetryBatch(batchId: string): RetryBatch | undefined {
  return retryEngine().getBatch(batchId)
}

export function reportJobFailure(
  jobKey: string,
  exceptionCode: string,
  source = '采集失败上报',
): EngineResult {
  return retryEngine().reportFailure({ jobKey, exceptionCode, source })
}

/** 演示用执行器：识别服务中断（页面开关或批次异常）时让重试事务失败，其余视为成功。 */
let recognitionServiceDown = false

export function setRecognitionServiceDown(down: boolean): void {
  recognitionServiceDown = down
}

export function isRecognitionServiceDown(): boolean {
  return recognitionServiceDown
}

const demoExecutor: RetryExecutor = (batch) => {
  const latest = batch.attempts[batch.attempts.length - 1]
  if (recognitionServiceDown || latest?.exceptionCode === 'RECOGNITION_SERVICE_DOWN') {
    throw new Error('RECOGNITION_SERVICE_DOWN')
  }
}

export async function runDueRetry(batchId: string): Promise<EngineResult> {
  return retryEngine().executeRetry(batchId, demoExecutor)
}

export function jobRetryView(jobKey: string): JobRetryView {
  return retryEngine().jobView(jobKey)
}

export function allJobRetryViews(): JobRetryView[] {
  return listRows('spider').map((row) => retryEngine().jobView(String(row['作业编号'] ?? '')))
}

/** spider 台账行叠加重试相位，供采集任务/监控页面渲染同步状态。 */
export function spiderRowWithRetry(row: EntryRow): {
  row: EntryRow
  retry: JobRetryView
} {
  const jobKey = String(row['作业编号'] ?? '')
  return { row, retry: retryEngine().jobView(jobKey) }
}
