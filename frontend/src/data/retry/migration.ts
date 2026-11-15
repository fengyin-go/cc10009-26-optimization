/**
 * 存量兼容：把老版本遗留的失败记录迁移成重试批次。
 *
 * 兼容口径（自行设计，保证老数据不丢、顺序不变）：
 * 1. 数据来源：spider 台账里 status=已失败、带「失败异常」字段的作业；
 * 2. 已经存在批次（同 jobKey 任意批次）的作业不重复迁移，迁移只做一次；
 * 3. 历史失败按台账顺序逐条上报，attempts 顺序与老记录一致，并打 legacy 标记；
 * 4. 迁移时间用「当前时间 - 偏移」构造，使可重试老记录正好处于退避等待中，
 *    不可重试老记录直接转存一次，页面上即可看到「正在等待 / 已转存」两种存量形态；
 * 5. 迁移进度单独持久化，重置模块后允许重新迁移。
 */
import type { EntryRow } from '@/data/types'

import { RetryBatchEngine } from './retry-engine'

export const MIGRATION_MARK_KEY = 'scraper-config-studio:retry-migration'

export type MigrationSummary = {
  migrated: number
  waiting: number
  dumped: number
  skipped: number
  details: string[]
}

type MigrationMark = {
  done: boolean
  jobKeys: string[]
  at: number
}

export function readMigrationMark(storage: Storage | undefined): MigrationMark | null {
  if (!storage) {
    return null
  }
  const raw = storage.getItem(MIGRATION_MARK_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as MigrationMark
  } catch {
    return null
  }
}

function writeMigrationMark(storage: Storage | undefined, mark: MigrationMark): void {
  if (storage) {
    storage.setItem(MIGRATION_MARK_KEY, JSON.stringify(mark))
  }
}

/**
 * 执行一次性迁移。
 * @param legacyRows spider 台账行
 * @param offsetSeconds 可重试记录的失败时间相对当前时间往前推多少秒（小于首个退避窗口，保证仍在等待）
 */
export function migrateLegacyFailures(
  engine: RetryBatchEngine,
  legacyRows: EntryRow[],
  storage: Storage | undefined,
  offsetSeconds = 1,
): MigrationSummary {
  const mark = readMigrationMark(storage)
  const summary: MigrationSummary = {
    migrated: 0,
    waiting: 0,
    dumped: 0,
    skipped: 0,
    details: [],
  }
  if (mark?.done) {
    summary.details.push('历史失败记录已迁移过，本次跳过')
    return summary
  }

  const done: string[] = []
  legacyRows
    .filter((row) => String(row.status) === '已失败')
    .forEach((row, index) => {
      const jobKey = String(row['作业编号'] ?? '')
      const exceptionCode = String(row['失败异常'] ?? 'NETWORK_TIMEOUT')
      if (!jobKey) {
        summary.skipped += 1
        return
      }
      if (engine.getBatch(`BATCH-${jobKey}`) || engine.jobView(jobKey).phase !== 'idle') {
        summary.skipped += 1
        summary.details.push(`${jobKey} 已有重试批次，迁移跳过`)
        return
      }
      const result = engine.reportFailure({
        jobKey,
        exceptionCode,
        legacy: true,
        source: '历史失败记录迁移',
        at: Date.now() - (offsetSeconds + index) * 1000,
      })
      done.push(jobKey)
      if (result.ok) {
        summary.migrated += 1
        if (result.data.status === 'dumped') {
          summary.dumped += 1
        } else {
          summary.waiting += 1
        }
        summary.details.push(
          `${jobKey} 迁移为批次 ${result.data.id}（${result.data.status === 'dumped' ? '已转存' : '等待退避'}）`,
        )
      } else {
        summary.skipped += 1
        summary.details.push(`${jobKey} 迁移失败：${result.message}`)
      }
    })

  writeMigrationMark(storage, { done: true, jobKeys: done, at: Date.now() })
  return summary
}
