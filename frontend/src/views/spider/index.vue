<template>
  <section class="page" data-module="spider">
    <header class="page-head">
      <div>
        <h2>采集任务管理</h2>
        <p class="page-desc">
          采集作业的重试相位与重试批次实时同步：退避等待显示「正在等待退避」，达上限显示「已失败转存」，恢复后保留原失败尝试。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记采集作业</button>
        <button class="btn" type="button" @click="exportRows">导出采集任务清单</button>
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
          <th>台账状态</th>
          <th>重试相位（同步批次）</th>
          <th>下一次尝试说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="String(item.row.id)">
          <td v-for="column in columns" :key="column">{{ item.row[column] ?? '—' }}</td>
          <td>{{ item.row.status }}</td>
          <td>
            <span :class="['batch-status', `phase-${item.retry.phase}`]">{{ item.retry.statusLabel }}</span>
            <div v-if="item.retry.phase !== 'idle'" class="muted small">
              重试 {{ item.retry.retryCount }}/{{ item.retry.maxRetries }} · 合并失败 {{ item.retry.mergedFailureCount }} 条
            </div>
          </td>
          <td class="small">
            <span v-if="item.retry.phase === 'idle'" class="muted">{{ item.retry.nextAttemptHint }}</span>
            <span v-else-if="item.retry.nextAttemptAt">
              {{ new Date(item.retry.nextAttemptAt).toLocaleTimeString() }} 到期
            </span>
            <span v-else class="error-text">{{ item.retry.nextAttemptHint }}</span>
            <div v-if="item.retry.latestException" class="muted">{{ item.retry.latestException }}</div>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, item.row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="reportFailure(item.row, 'NETWORK_TIMEOUT')">
              上报可重试失败
            </button>
            <button class="link" type="button" @click="reportFailure(item.row, 'AUTH_FAILED')">
              上报不可重试失败
            </button>
            <button class="link" type="button" @click="reportFailure(item.row, 'RECOGNITION_SERVICE_DOWN')">
              模拟识别服务中断
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">
            暂无采集任务数据，可先登记采集作业
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集任务记录；重复上报会并入同一计划批次，不重复计算退避</span>
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
import {
  reportJobFailure,
  runDueRetry,
  spiderRowWithRetry,
} from '@/data/retry/retry-service'

const meta = moduleMeta('spider')
const columns = ["作业编号", "目标站点", "抽取模板", "起始地址", "并发线程数", "请求间隔秒", "每日上限条数", "超时秒数"]
const actions = ["提交执行", "启动采集", "终止采集", "归档结果"]
const baseStatuses = ["草稿", "待执行", "运行中", "已完成", "已失败"]
const retryPhases = ["正在等待退避", "重试执行中", "已恢复（保留失败尝试）", "已失败转存", "无在途重试"]

const rows = ref<{ row: EntryRow; retry: ReturnType<typeof spiderRowWithRetry>['retry'] }[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
let timer: number | undefined

const stats = computed(() => [
  { label: '采集作业总数', value: rows.value.length },
  {
    label: '等待退避作业',
    value: rows.value.filter((item) => item.retry.phase === 'waiting').length,
  },
  {
    label: '已转存作业',
    value: rows.value.filter((item) => item.retry.phase === 'dumped').length,
  },
])

const statusSummary = computed(() => {
  const base = baseStatuses.map((status) => ({
    status,
    count: rows.value.filter((item) => String(item.row.status) === status).length,
  }))
  const retry = retryPhases.map((status) => ({
    status,
    count: rows.value.filter((item) => item.retry.statusLabel === status).length,
  }))
  return [...base, ...retry]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '采集作业登记入口尚未接入审批流'
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

async function reportFailure(row: EntryRow, exceptionCode: string) {
  errorMessage.value = ''
  const jobKey = String(row['作业编号'] ?? '')
  const result = reportJobFailure(jobKey, exceptionCode)
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  // 若已到退避窗口，自动尝试一次，方便在页面上验证完整链路
  if (result.data.status === 'waiting' && result.data.nextAttemptAt != null
      && result.data.nextAttemptAt <= Date.now()) {
    const retryResult = await runDueRetry(result.data.id)
    if (!retryResult.ok) {
      errorMessage.value = retryResult.message
    }
  } else {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items.map((row) => spiderRowWithRetry(row))
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集任务列表读取失败'
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
