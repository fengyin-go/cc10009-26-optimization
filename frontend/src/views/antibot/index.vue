<template>
  <section class="page" data-module="antibot">
    <header class="page-head">
      <div>
        <h2>反爬对抗管理</h2>
        <p class="page-desc">维护反爬对抗策略的输入、执行约束与结果记录，为反爬对抗提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记对抗策略</button>
        <button class="btn" type="button" @click="exportRows">导出反爬对抗清单</button>
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

    <section class="service-panel">
      <h3>识别服务运行状态（与重试批次联动）</h3>
      <div class="service-actions">
        <button class="btn" type="button" @click="toggleRecognitionService">
          {{ recognitionDown ? '模拟识别服务恢复' : '模拟识别服务中断' }}
        </button>
        <span :class="['service-pill', recognitionDown ? 'down' : 'up']">
          {{ recognitionDown ? '识别服务中断中' : '识别服务正常' }}
        </span>
      </div>
      <p v-if="recognitionDown" class="error-text small">
        识别服务中断：进行中的重试事务会失败并退回退避等待，从最后一次尝试继续，不会跳过等待；
        中断期间不产生新的成功恢复，批次状态保持「正在等待退避」并保留异常说明。
      </p>
      <p v-if="!affectedBatches.length" class="empty-state">
        暂不受识别服务中断影响：当前没有等待该服务的重试批次，待采集失败上报后这里会列出受影响批次及下一次尝试时间。
      </p>
      <table v-else class="data-table">
        <thead>
          <tr><th>关联任务</th><th>批次状态</th><th>下一次尝试</th><th>异常说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="view in affectedBatches" :key="view.jobKey">
            <td>{{ view.jobKey }}</td>
            <td>{{ view.statusLabel }}</td>
            <td>
              <span v-if="view.nextAttemptAt">{{ new Date(view.nextAttemptAt).toLocaleTimeString() }} 到期</span>
              <span v-else class="error-text">{{ view.nextAttemptHint }}</span>
            </td>
            <td class="small">{{ view.latestException || '等待识别服务恢复后继续退避计时' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无反爬对抗数据，可先登记对抗策略</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条反爬对抗记录</span>
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
import { allJobRetryViews, setRecognitionServiceDown } from '@/data/retry/retry-service'
import type { JobRetryView } from '@/data/retry/types'

const meta = moduleMeta('antibot')
const columns = ["策略编号", "验证码类型", "识别服务", "触发条件", "等待时长", "重试上限", "降级方案", "策略状态"]
const actions = ["提交校验", "启用策略", "停用策略"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "对抗策略总数", "value": 0}, {"label": "已启用策略", "value": 0}, {"label": "待校验策略", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const recognitionDown = ref(false)
const jobViews = ref<JobRetryView[]>([])
let timer: number | undefined

const affectedBatches = computed(() =>
  jobViews.value.filter((view) => view.phase === 'waiting' || view.phase === 'running'),
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function toggleRecognitionService() {
  recognitionDown.value = !recognitionDown.value
  setRecognitionServiceDown(recognitionDown.value)
  errorMessage.value = recognitionDown.value
    ? '识别服务已模拟中断：重试事务将失败并退回退避等待（中断类异常按清单归为不可重试时直接转存一次）'
    : '识别服务已恢复：等待窗口到期后可正常重试，历史失败尝试保留'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '对抗策略登记入口尚未接入审批流'
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
    errorMessage.value = error instanceof Error ? error.message : '反爬对抗列表读取失败'
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
.service-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.service-panel h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.service-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.service-pill {
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
}
.service-pill.up { background: #dcfce7; color: #166534; }
.service-pill.down { background: #fee2e2; color: #991b1b; }
.small { font-size: 12px; }
</style>
