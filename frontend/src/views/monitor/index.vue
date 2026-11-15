<template>
  <section class="page" data-module="monitor">
    <header class="page-head">
      <div>
        <h2>采集监控管理</h2>
        <p class="page-desc">
          监控台账与重试批次实时同步：退避等待、识别服务中断或批次失败都保留可解释的空态与异常说明，暂无下一次尝试时明确原因。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监控指标</button>
        <button class="btn" type="button" @click="exportRows">导出采集监控清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="batch-panel">
      <h3>采集批次重试台账（与失败重试页同源同步）</h3>
      <p v-if="!jobViews.length" class="empty-state">
        暂无可监控的采集作业：没有登记采集作业或作业尚未产生失败记录，因此没有等待/转存状态可展示。
      </p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>关联任务</th>
            <th>运行状态</th>
            <th>重试进度</th>
            <th>下一次尝试 / 异常说明</th>
            <th>失败转存</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="view in jobViews" :key="view.jobKey">
            <td>{{ view.jobKey }}</td>
            <td>
              <span :class="['batch-status', `phase-${view.phase}`]">{{ view.statusLabel }}</span>
            </td>
            <td>{{ view.retryCount }} / {{ view.maxRetries || '—' }}（合并 {{ view.mergedFailureCount }} 条失败）</td>
            <td class="small">
              <template v-if="view.phase === 'idle'">
                <span class="muted">{{ view.nextAttemptHint }}</span>
              </template>
              <template v-else-if="view.nextAttemptAt">
                {{ new Date(view.nextAttemptAt).toLocaleTimeString() }} 到期
                <span v-if="view.phase === 'waiting'" class="muted">（退避等待中，不可跳过）</span>
              </template>
              <template v-else>
                <span class="error-text">{{ view.nextAttemptHint }}</span>
              </template>
              <div v-if="view.latestException" class="muted">{{ view.latestException }}</div>
            </td>
            <td>
              <span v-if="view.dumpCount > 0" class="error-text">
                已转存 ×{{ view.dumpCount }} → {{ view.dumpTarget }}
              </span>
              <span v-else class="muted">未转存</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无采集监控数据，可先登记监控指标</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集监控记录；识别服务中断时批次退回退避等待并保留异常说明</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { allJobRetryViews } from '@/data/retry/retry-service'
import type { JobRetryView } from '@/data/retry/types'

const meta = moduleMeta('monitor')
const columns = ["指标编号", "关联任务", "指标名称", "预警阈值", "告警级别", "统计粒度", "通知渠道", "静默窗口"]
const actions = ["提交校验", "启用监控", "停用监控"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]

const rows = ref<EntryRow[]>([])
const jobViews = ref<JobRetryView[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
let timer: number | undefined

const stats = computed(() => [
  { label: '监控指标总数', value: rows.value.length },
  {
    label: '等待退避批次',
    value: jobViews.value.filter((view) => view.phase === 'waiting').length,
  },
  {
    label: '已转存批次',
    value: jobViews.value.filter((view) => view.phase === 'dumped').length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '监控指标登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    jobViews.value = allJobRetryViews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集监控列表读取失败'
  }
}

onMounted(() => {
  reload()
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
  white-space: nowrap;
}
.phase-waiting { background: #fef3c7; color: #92400e; }
.phase-running { background: #dbeafe; color: #1e40af; }
.phase-recovered { background: #dcfce7; color: #166534; }
.phase-dumped { background: #fee2e2; color: #991b1b; }
.phase-idle { background: #f1f5f9; color: #64748b; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
</style>
