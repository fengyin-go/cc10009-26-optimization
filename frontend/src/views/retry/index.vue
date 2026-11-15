<template>
  <section class="page" data-module="retry">
    <header class="page-head">
      <div>
        <h2>失败重试管理</h2>
        <p class="page-desc">
          同一关联任务在退避窗口内共享一个计划批次：重复失败只并入不重算退避，达到最大重试次数后只转存一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记重试策略</button>
        <button class="btn" type="button" @click="exportRows">导出失败重试清单</button>
        <button class="btn ghost" type="button" @click="resetDemo">重置演示台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="batch-panel">
      <h3>重试批次台账（失败记录 → 重试批次 → 采集作业）</h3>
      <p v-if="!batches.length" class="empty-state">
        暂无重试批次：当前没有失败记录。采集作业上报失败后，会按关联任务在这里生成计划批次。
      </p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>关联任务</th>
            <th>批次状态</th>
            <th>合并失败数</th>
            <th>重试/上限</th>
            <th>退避等待</th>
            <th>下一次尝试</th>
            <th>失败转存</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.id }}</td>
            <td>{{ batch.jobKey }}</td>
            <td>
              <span :class="['batch-status', `status-${batch.status}`]">{{ statusLabel(batch.status) }}</span>
            </td>
            <td>{{ batch.mergedFailureCount }}（并发共享同一批次）</td>
            <td>{{ batch.retryCount }} / {{ batch.maxRetries }}</td>
            <td>{{ batch.currentWaitSeconds }} 秒（{{ batch.backoffAlgorithm }}）</td>
            <td>
              <template v-if="batch.nextAttemptAt">
                {{ formatClock(batch.nextAttemptAt) }}
                <span v-if="batch.status === 'waiting'" class="muted">
                  （剩余 {{ remainSeconds(batch.nextAttemptAt) }} 秒，不能跳过等待）
                </span>
              </template>
              <span v-else class="error-text">{{ batch.noNextAttemptReason || '暂无下一次尝试' }}</span>
            </td>
            <td>
              <template v-if="batch.dumpCount > 0">
                已转存 ×{{ batch.dumpCount }} → {{ batch.dumpTarget }}
              </template>
              <template v-else>
                <span class="muted">未转存（{{ batch.dumpTarget }}）</span>
              </template>
            </td>
            <td class="row-actions">
              <button
                v-if="batch.status === 'waiting'"
                class="link"
                type="button"
                @click="execute(batch.id)"
              >
                到期重试
              </button>
              <button class="link" type="button" @click="selectedId = batch.id">
                查看失败尝试
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="selectedBatch" class="batch-panel">
      <h3>批次 {{ selectedBatch.id }} 的历史失败尝试（按原顺序保留）</h3>
      <p v-if="!selectedBatch.attempts.length" class="empty-state">
        该批次没有失败尝试明细，可能是迁移时原始记录缺失；异常说明：{{ selectedBatch.note || '无' }}
      </p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>顺序</th>
            <th>时间</th>
            <th>异常</th>
            <th>清单口径</th>
            <th>判定说明</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="attempt in selectedBatch.attempts" :key="`${attempt.seq}-${attempt.at}`">
            <td>#{{ attempt.seq }}{{ attempt.legacy ? '（历史）' : '' }}</td>
            <td>{{ formatClock(attempt.at) }}</td>
            <td>{{ attempt.exceptionName }}</td>
            <td :class="attempt.retryable ? 'ok-text' : 'error-text'">
              {{ attempt.retryable ? '可重试' : '不可重试' }}
            </td>
            <td>{{ attempt.classificationReason }}</td>
            <td>{{ attempt.source }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">批次备注：{{ selectedBatch.note || '无' }}</p>
    </section>

    <section class="batch-panel">
      <h3>异常判定口径（冲突时以已知异常清单为准）</h3>
      <div class="catalog-grid">
        <div>
          <h4 class="ok-text">可重试异常清单</h4>
          <ul class="catalog-list">
            <li v-for="item in catalog.retryable" :key="item.code">
              <code>{{ item.code }}</code> {{ item.name }}
            </li>
          </ul>
        </div>
        <div>
          <h4 class="error-text">不可重试异常清单</h4>
          <ul class="catalog-list">
            <li v-for="item in catalog.nonRetryable" :key="item.code">
              <code>{{ item.code }}</code> {{ item.name }}
            </li>
          </ul>
        </div>
      </div>
      <p class="muted small">
        未登记异常按保守口径视为不可重试；同一异常同时出现在两张清单时按不可重试处理并在尝试明细中写明原因。
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ batches.length }} 个重试批次，数据保存在本机浏览器</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import { exceptionCatalogSnapshot } from '@/data/retry/exception-catalog'
import {
  getRetryBatch,
  listRetryBatches,
  resetRetryEngine,
  runDueRetry,
} from '@/data/retry/retry-service'
import type { RetryBatch, RetryBatchStatus } from '@/data/retry/types'

const meta = moduleMeta('retry')
const catalog = exceptionCatalogSnapshot()

const batches = ref<RetryBatch[]>([])
const selectedId = ref<string | null>(null)
const errorMessage = ref('')
let timer: number | undefined

const STATUS_LABELS: Record<RetryBatchStatus, string> = {
  waiting: '正在等待退避',
  running: '重试执行中',
  recovered: '已恢复（保留失败尝试）',
  dumped: '已失败转存',
}

const stats = computed(() => [
  { label: '重试批次总数', value: batches.value.length },
  { label: '等待退避批次', value: batches.value.filter((b) => b.status === 'waiting').length },
  { label: '已转存批次', value: batches.value.filter((b) => b.status === 'dumped').length },
  { label: '已恢复批次', value: batches.value.filter((b) => b.status === 'recovered').length },
])

const statusSummary = computed(() =>
  (Object.keys(STATUS_LABELS) as RetryBatchStatus[]).map((status) => ({
    status: STATUS_LABELS[status],
    count: batches.value.filter((batch) => batch.status === status).length,
  })),
)

const selectedBatch = computed(() =>
  selectedId.value ? getRetryBatch(selectedId.value) ?? null : null,
)

function statusLabel(status: RetryBatchStatus): string {
  return STATUS_LABELS[status]
}

function formatClock(timestamp: number | null): string {
  if (timestamp == null) {
    return '—'
  }
  return new Date(timestamp).toLocaleTimeString()
}

function remainSeconds(nextAttemptAt: number): string {
  return Math.max(0, Math.ceil((nextAttemptAt - Date.now()) / 1000)).toFixed(0)
}

function reload() {
  batches.value = listRetryBatches()
}

async function execute(batchId: string) {
  errorMessage.value = ''
  const result = await runDueRetry(batchId)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function resetDemo() {
  resetRetryEngine()
  selectedId.value = null
  errorMessage.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '重试策略登记入口尚未接入审批流，可在通用台账维护策略字段'
}

onMounted(() => {
  reload()
  // 每秒刷新剩余等待秒，退避窗口是否到期由引擎按时间戳判定，页面只负责展示
  timer = window.setInterval(reload, 1000)
})

onUnmounted(() => {
  if (timer) {
    window.clearInterval(timer)
  }
})
</script>

<style scoped>
.batch-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.batch-panel h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.batch-status {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.status-waiting { background: #fef3c7; color: #92400e; }
.status-running { background: #dbeafe; color: #1e40af; }
.status-recovered { background: #dcfce7; color: #166534; }
.status-dumped { background: #fee2e2; color: #991b1b; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.ok-text { color: #166534; }
.catalog-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.catalog-list {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.catalog-list code {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
