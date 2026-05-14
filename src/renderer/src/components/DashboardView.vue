<script setup lang="ts">
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

type DashboardUiPersistV1 = {
  statField: string
  catField: string
  groupField: string
  aggregateField: string
  aggregateType: 'sum' | 'avg' | 'count'
}

const props = defineProps<{
  projectId: number | null
  savedDashboard: DashboardUiPersistV1
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'dashboard-persist', payload: DashboardUiPersistV1): void
}>()

const loading = ref(false)
const rowCount = ref(0)
const allFields = ref<string[]>([])
const numericFields = ref<string[]>([])
const statField = ref('')
const catField = ref('')
const groupField = ref('')
const aggregateField = ref('')
const aggregateType = ref<'sum' | 'avg' | 'count'>('sum')

let persistTimer: ReturnType<typeof setTimeout> | null = null

function getPersistableDashboard(): DashboardUiPersistV1 {
  return {
    statField: statField.value,
    catField: catField.value,
    groupField: groupField.value,
    aggregateField: aggregateField.value,
    aggregateType: aggregateType.value
  }
}

function schedulePersistEmit(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    emit('dashboard-persist', getPersistableDashboard())
  }, 320)
}

function applySavedDashboard(saved: DashboardUiPersistV1): void {
  const pickNum = (v: string): string => (v && numericFields.value.includes(v) ? v : '')
  const pickAny = (v: string): string => (v && allFields.value.includes(v) ? v : '')
  const agg = saved.aggregateType === 'avg' || saved.aggregateType === 'count' ? saved.aggregateType : 'sum'
  statField.value = pickNum(saved.statField)
  catField.value = pickAny(saved.catField)
  groupField.value = pickAny(saved.groupField)
  aggregateField.value = pickNum(saved.aggregateField)
  aggregateType.value = agg
}

const sumVal = ref<number | null>(null)
const avgVal = ref<number | null>(null)
const maxVal = ref<number | null>(null)
const minVal = ref<number | null>(null)
const uniquePreview = ref<Array<{ value: string; count: number }>>([])
const groupPreview = ref<Array<{ group: string; value: number }>>([])

const chartPieEl = ref<HTMLDivElement | null>(null)
const chartBarEl = ref<HTMLDivElement | null>(null)
let chartPie: echarts.ECharts | null = null
let chartBar: echarts.ECharts | null = null

async function loadFields(): Promise<void> {
  if (props.projectId === null) {
    rowCount.value = 0
    allFields.value = []
    numericFields.value = []
    statField.value = ''
    catField.value = ''
    groupField.value = ''
    aggregateField.value = ''
    aggregateType.value = 'sum'
    return
  }
  loading.value = true
  try {
    const r = await window.api.statsQuery({ op: 'fields', projectId: props.projectId })
    if (!r.success || !r.data) {
      ElMessage.warning((r as { message?: string }).message || '加载字段失败')
      return
    }
    const d = r.data as { rowCount?: number; allFields?: string[]; numericFields?: string[] }
    rowCount.value = d.rowCount ?? 0
    allFields.value = d.allFields ?? []
    numericFields.value = d.numericFields ?? []
    applySavedDashboard(props.savedDashboard)
  } finally {
    loading.value = false
  }
}

async function runNumericStats(): Promise<void> {
  if (props.projectId === null || !statField.value) return
  const pid = props.projectId
  const f = statField.value
  const [s, a, x, n] = await Promise.all([
    window.api.statsQuery({ op: 'sum', projectId: pid, field: f }),
    window.api.statsQuery({ op: 'average', projectId: pid, field: f }),
    window.api.statsQuery({ op: 'max', projectId: pid, field: f }),
    window.api.statsQuery({ op: 'min', projectId: pid, field: f })
  ])
  sumVal.value = s.success ? (s.data as { value: number }).value : null
  avgVal.value = a.success ? ((a.data as { value: number | null }).value ?? null) : null
  maxVal.value = x.success ? ((x.data as { value: number | null }).value ?? null) : null
  minVal.value = n.success ? ((n.data as { value: number | null }).value ?? null) : null
}

async function runCategoryStats(): Promise<void> {
  if (props.projectId === null || !catField.value) return
  const r = await window.api.statsQuery({ op: 'uniqueValues', projectId: props.projectId, field: catField.value, limit: 15 })
  uniquePreview.value = r.success ? ((r.data as { entries: typeof uniquePreview.value }).entries ?? []) : []
  await nextTick()
  renderCategoryChart()
}

async function runGroupStats(): Promise<void> {
  if (props.projectId === null || !groupField.value || !aggregateField.value) return
  const r = await window.api.statsQuery({
    op: 'groupBy',
    projectId: props.projectId,
    groupField: groupField.value,
    aggregateField: aggregateField.value,
    aggregateType: aggregateType.value
  })
  groupPreview.value = r.success ? ((r.data as { groups: typeof groupPreview.value }).groups ?? []) : []
  await nextTick()
  renderGroupChart()
}

function renderCategoryChart(): void {
  if (!chartPieEl.value) return
  if (!chartPie) chartPie = echarts.init(chartPieEl.value)
  const data = uniquePreview.value.slice(0, 12).map((u) => ({ name: u.value, value: u.count }))
  if (data.length === 0) {
    chartPie.clear()
    return
  }
  chartPie.setOption({
    title: { text: `「${catField.value}」分布`, left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'item' },
    series: [{ type: 'pie', radius: ['30%', '58%'], data }]
  })
}

function renderGroupChart(): void {
  if (!chartBarEl.value) return
  if (!chartBar) chartBar = echarts.init(chartBarEl.value)
  const labels = groupPreview.value.slice(0, 16).map((g) => g.group)
  const values = groupPreview.value.slice(0, 16).map((g) => g.value)
  if (labels.length === 0) {
    chartBar.clear()
    return
  }
  chartBar.setOption({
    title: {
      text: `分组：${aggregateType.value}(${aggregateField.value})`,
      left: 'center',
      textStyle: { fontSize: 14 }
    },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { rotate: 28 } },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: values, itemStyle: { color: '#6366f1' } }]
  })
}

function resizeChart(): void {
  chartPie?.resize()
  chartBar?.resize()
}

watch(
  () => props.projectId,
  () => {
    void loadFields()
  },
  { immediate: true }
)

watch([statField, catField, groupField, aggregateField, aggregateType], schedulePersistEmit)

watch([statField, () => props.projectId], () => {
  void runNumericStats()
})

watch([catField, () => props.projectId], () => {
  void runCategoryStats()
})

watch([groupField, aggregateField, aggregateType, () => props.projectId], () => {
  void runGroupStats()
})

watch(loading, (v) => {
  if (!v) void nextTick(() => resizeChart())
})

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer)
  chartPie?.dispose()
  chartPie = null
  chartBar?.dispose()
  chartBar = null
})

defineExpose({ loadFields, resizeChart, getPersistableDashboard })
</script>

<template>
  <div v-loading="loading" class="dashboard-root">
    <div class="dash-hero">
      <h2>数据统计与洞察</h2>
      <p class="dash-sub">
        基于当前项目中已导入的结构化行（Excel / CSV / JSON / AI 入库）。切换项目后统计会自动刷新。
      </p>
      <div class="dash-kpis">
        <el-card shadow="hover" class="kpi-card">
          <div class="kpi-label">结构化行数</div>
          <div class="kpi-value">{{ rowCount }}</div>
        </el-card>
        <el-card shadow="hover" class="kpi-card kpi-wide">
          <div class="kpi-label">字段概览</div>
          <div class="kpi-meta">{{ allFields.length ? allFields.join(' · ') : '暂无字段，请先导入数据' }}</div>
        </el-card>
      </div>
    </div>

    <el-row :gutter="16" class="dash-row">
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="panel-card">
          <template #header>数值字段统计</template>
          <el-form label-position="top">
            <el-form-item label="选择字段">
              <el-select v-model="statField" placeholder="选择数值列" filterable style="width: 100%">
                <el-option v-for="f in numericFields" :key="f" :label="f" :value="f" />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="stat-grid">
            <div class="stat-cell"><span>总和</span><strong>{{ sumVal ?? '—' }}</strong></div>
            <div class="stat-cell"><span>平均</span><strong>{{ avgVal ?? '—' }}</strong></div>
            <div class="stat-cell"><span>最大</span><strong>{{ maxVal ?? '—' }}</strong></div>
            <div class="stat-cell"><span>最小</span><strong>{{ minVal ?? '—' }}</strong></div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="panel-card">
          <template #header>分类字段分布</template>
          <el-form label-position="top">
            <el-form-item label="选择字段">
              <el-select v-model="catField" placeholder="选择分类列" filterable style="width: 100%">
                <el-option v-for="f in allFields" :key="`c-${f}`" :label="f" :value="f" />
              </el-select>
            </el-form-item>
          </el-form>
          <el-table :data="uniquePreview" size="small" max-height="220" stripe>
            <el-table-column prop="value" label="取值" show-overflow-tooltip />
            <el-table-column prop="count" label="计数" width="90" />
            <el-table-column label="占比" width="100">
              <template #default="{ row }">
                {{ rowCount ? ((row.count / rowCount) * 100).toFixed(1) : '—' }}%
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="panel-card chart-card">
      <template #header>
        <div class="chart-header">
          <span>图表区（分类 / 分组）</span>
          <el-button size="small" text @click="emit('refresh')">同步列表数据</el-button>
        </div>
      </template>
      <el-row :gutter="12">
        <el-col :span="24">
          <el-form :inline="true" class="group-form">
            <el-form-item label="分组字段">
              <el-select v-model="groupField" filterable style="width: 160px">
                <el-option v-for="f in allFields" :key="`g-${f}`" :label="f" :value="f" />
              </el-select>
            </el-form-item>
            <el-form-item label="聚合字段">
              <el-select v-model="aggregateField" filterable style="width: 160px">
                <el-option v-for="f in numericFields" :key="`a-${f}`" :label="f" :value="f" />
              </el-select>
            </el-form-item>
            <el-form-item label="聚合方式">
              <el-select v-model="aggregateType" style="width: 120px">
                <el-option label="求和" value="sum" />
                <el-option label="平均" value="avg" />
                <el-option label="计数" value="count" />
              </el-select>
            </el-form-item>
          </el-form>
          <el-row :gutter="12">
            <el-col :xs="24" :md="12">
              <div ref="chartPieEl" class="chart-sub" />
            </el-col>
            <el-col :xs="24" :md="12">
              <div ref="chartBarEl" class="chart-sub" />
            </el-col>
          </el-row>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<style scoped>
.dashboard-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 4px 24px;
  min-height: 100%;
}
.dash-hero h2 {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 600;
  color: #0f172a;
}
.dash-sub {
  margin: 0 0 16px;
  color: #64748b;
  font-size: 14px;
}
.dash-kpis {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.kpi-card {
  min-width: 140px;
  flex: 1;
}
.kpi-wide {
  flex: 3;
}
.kpi-label {
  font-size: 12px;
  color: #94a3b8;
}
.kpi-value {
  font-size: 28px;
  font-weight: 700;
  color: #2563eb;
}
.kpi-meta {
  font-size: 13px;
  color: #475569;
  line-height: 1.5;
  word-break: break-all;
}
.panel-card {
  border-radius: 12px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-top: 8px;
}
.stat-cell {
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-cell span {
  font-size: 12px;
  color: #94a3b8;
}
.stat-cell strong {
  font-size: 18px;
  color: #0f172a;
}
.chart-card {
  margin-top: 4px;
}
.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.group-form {
  margin-bottom: 8px;
}
.chart-sub {
  width: 100%;
  height: 300px;
}
.dash-row {
  margin-top: 4px;
}
</style>
