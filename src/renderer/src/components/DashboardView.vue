<script setup lang="ts">
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { Rank, Plus, Delete } from '@element-plus/icons-vue'
import { markRaw, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChartCardConfig, ChartCardKind, DashboardUiPersistV1 } from '../../../preload/index'

const props = defineProps<{
  projectId: number | null
  savedDashboard: DashboardUiPersistV1
  /** undefined：旧数据未写过图表配置，用 dashboard 生成默认两张卡；[]：用户主动清空 */
  savedChartConfigurations?: ChartCardConfig[] | null
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'dashboard-persist', payload: { dashboard: DashboardUiPersistV1; chartConfigurations: ChartCardConfig[] }): void
}>()

const loading = ref(false)
const rowCount = ref(0)
const allFields = ref<string[]>([])
const numericFields = ref<string[]>([])
const statField = ref('')
const catField = ref('')

const chartCards = ref<ChartCardConfig[]>([])
const cardCharts = new Map<string, echarts.ECharts>()
let persistTimer: ReturnType<typeof setTimeout> | null = null
let cardRefreshTimer: ReturnType<typeof setTimeout> | null = null
const draggingCardIndex = ref<number | null>(null)

function genId(): string {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function defaultCardsFromDashboard(d: DashboardUiPersistV1): ChartCardConfig[] {
  const agg = d.aggregateType === 'avg' || d.aggregateType === 'count' ? d.aggregateType : 'sum'
  return [
    { id: genId(), kind: 'category_pie', title: '分类分布', catField: d.catField || '' },
    {
      id: genId(),
      kind: 'group_bar',
      title: '分组聚合',
      groupField: d.groupField || '',
      aggregateField: d.aggregateField || '',
      aggregateType: agg
    }
  ]
}

function sanitizeCard(c: ChartCardConfig, fields: { all: string[]; numeric: string[] }): ChartCardConfig {
  const agg = c.aggregateType === 'avg' || c.aggregateType === 'count' ? c.aggregateType : 'sum'
  if (c.kind === 'category_pie') {
    const cf = c.catField?.trim() ?? ''
    return {
      ...c,
      catField: cf && fields.all.includes(cf) ? cf : '',
      aggregateType: agg
    }
  }
  const gf = c.groupField?.trim() ?? ''
  const af = c.aggregateField?.trim() ?? ''
  return {
    ...c,
    groupField: gf && fields.all.includes(gf) ? gf : '',
    aggregateField: af && fields.numeric.includes(af) ? af : '',
    aggregateType: agg
  }
}

function hydrateChartCards(): void {
  const saved = props.savedChartConfigurations
  const dash = props.savedDashboard
  if (saved === undefined || saved === null) {
    chartCards.value = defaultCardsFromDashboard(dash)
    return
  }
  if (saved.length === 0) {
    chartCards.value = []
    disposeAllCardCharts()
    return
  }
  const fields = { all: allFields.value, numeric: numericFields.value }
  chartCards.value = saved.map((c) => sanitizeCard(c, fields))
}

function getPersistableDashboard(): DashboardUiPersistV1 {
  const bar = chartCards.value.find((c) => c.kind === 'group_bar')
  return {
    statField: statField.value,
    catField: catField.value,
    groupField: bar?.groupField ?? '',
    aggregateField: bar?.aggregateField ?? '',
    aggregateType: bar?.aggregateType === 'avg' || bar?.aggregateType === 'count' ? bar.aggregateType : 'sum'
  }
}

function getPersistableChartConfigurations(): ChartCardConfig[] {
  return chartCards.value.map((c) => ({ ...c }))
}

function emitPersist(): void {
  emit('dashboard-persist', {
    dashboard: getPersistableDashboard(),
    chartConfigurations: getPersistableChartConfigurations()
  })
}

function schedulePersistEmit(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    emitPersist()
  }, 320)
}

function scheduleCardChartsRefresh(): void {
  if (cardRefreshTimer) clearTimeout(cardRefreshTimer)
  cardRefreshTimer = setTimeout(() => {
    cardRefreshTimer = null
    void refreshAllCardCharts()
  }, 140)
}

function applySavedDashboard(saved: DashboardUiPersistV1): void {
  const pickNum = (v: string): string => (v && numericFields.value.includes(v) ? v : '')
  const pickAny = (v: string): string => (v && allFields.value.includes(v) ? v : '')
  statField.value = pickNum(saved.statField)
  catField.value = pickAny(saved.catField)
}

const sumVal = ref<number | null>(null)
const avgVal = ref<number | null>(null)
const maxVal = ref<number | null>(null)
const minVal = ref<number | null>(null)
const uniquePreview = ref<Array<{ value: string; count: number }>>([])

function disposeAllCardCharts(): void {
  cardCharts.forEach((c) => c.dispose())
  cardCharts.clear()
}

function bindChartHost(cardId: string, el: unknown): void {
  const host = el instanceof HTMLDivElement ? el : null
  if (!host) {
    cardCharts.get(cardId)?.dispose()
    cardCharts.delete(cardId)
    return
  }
  let inst = cardCharts.get(cardId)
  if (!inst) {
    inst = markRaw(echarts.init(host))
    cardCharts.set(cardId, inst)
  }
  void refreshCardChart(cardId)
}

async function refreshCardChart(cardId: string): Promise<void> {
  const inst = cardCharts.get(cardId)
  const card = chartCards.value.find((c) => c.id === cardId)
  const pid = props.projectId
  if (!inst || !card || pid == null) return

  if (card.kind === 'category_pie') {
    const f = (card.catField ?? '').trim()
    if (!f) {
      inst.clear()
      return
    }
    const r = await window.api.statsQuery({ op: 'uniqueValues', projectId: pid, field: f, limit: 15 })
    const entries = r.success ? ((r.data as { entries: { value: string; count: number }[] }).entries ?? []) : []
    const data = entries.slice(0, 12).map((u) => ({ name: u.value, value: u.count }))
    if (data.length === 0) {
      inst.clear()
      return
    }
    inst.setOption({
      title: { text: card.title?.trim() || `「${f}」分布`, left: 'center', textStyle: { fontSize: 14 } },
      tooltip: { trigger: 'item' },
      series: [{ type: 'pie', radius: ['30%', '58%'], data }]
    })
  } else {
    const gf = (card.groupField ?? '').trim()
    const af = (card.aggregateField ?? '').trim()
    if (!gf || !af) {
      inst.clear()
      return
    }
    const r = await window.api.statsQuery({
      op: 'groupBy',
      projectId: pid,
      groupField: gf,
      aggregateField: af,
      aggregateType: card.aggregateType ?? 'sum'
    })
    const groups = r.success ? ((r.data as { groups: { group: string; value: number }[] }).groups ?? []) : []
    const labels = groups.slice(0, 16).map((g) => g.group)
    const values = groups.slice(0, 16).map((g) => g.value)
    if (labels.length === 0) {
      inst.clear()
      return
    }
    const aggLabel = card.aggregateType === 'avg' ? '平均' : card.aggregateType === 'count' ? '计数' : '求和'
    inst.setOption({
      title: {
        text: card.title?.trim() || `${aggLabel}(${af}) · 按 ${gf}`,
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate: 28 } },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: values, itemStyle: { color: '#6366f1' } }]
    })
  }
  void nextTick(() => inst.resize())
}

async function refreshAllCardCharts(): Promise<void> {
  for (const c of chartCards.value) {
    await refreshCardChart(c.id)
  }
}

async function loadFields(): Promise<void> {
  if (props.projectId === null) {
    rowCount.value = 0
    allFields.value = []
    numericFields.value = []
    statField.value = ''
    catField.value = ''
    chartCards.value = []
    disposeAllCardCharts()
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
    hydrateChartCards()
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
  const r = await window.api.statsQuery({
    op: 'uniqueValues',
    projectId: props.projectId,
    field: catField.value,
    limit: 15
  })
  uniquePreview.value = r.success ? ((r.data as { entries: typeof uniquePreview.value }).entries ?? []) : []
}

function resizeChart(): void {
  cardCharts.forEach((c) => c.resize())
}

function onCardDragStart(index: number, ev: DragEvent): void {
  draggingCardIndex.value = index
  ev.dataTransfer?.setData('text/plain', String(index))
  ev.dataTransfer!.effectAllowed = 'move'
}

function onCardDragEnd(): void {
  draggingCardIndex.value = null
}

function onCardDragOver(ev: DragEvent): void {
  ev.preventDefault()
}

function onCardDrop(index: number): void {
  const from = draggingCardIndex.value
  draggingCardIndex.value = null
  if (from == null || from === index) return
  const list = [...chartCards.value]
  const [moved] = list.splice(from, 1)
  list.splice(index, 0, moved)
  chartCards.value = list
  schedulePersistEmit()
  void nextTick(() => refreshAllCardCharts())
}

function onKindChange(card: ChartCardConfig): void {
  if (card.kind === 'category_pie') {
    card.groupField = undefined
    card.aggregateField = undefined
    if (!(card.catField ?? '').trim() && catField.value) card.catField = catField.value
    if (!(card.catField ?? '').trim() && allFields.value[0]) card.catField = allFields.value[0]
  } else {
    card.catField = undefined
    if (!(card.groupField ?? '').trim() && allFields.value[0]) card.groupField = allFields.value[0]
    if (!(card.aggregateField ?? '').trim() && numericFields.value[0]) card.aggregateField = numericFields.value[0]
    card.aggregateType = card.aggregateType === 'avg' || card.aggregateType === 'count' ? card.aggregateType : 'sum'
  }
  schedulePersistEmit()
  scheduleCardChartsRefresh()
}

function addChartCard(kind: ChartCardKind): void {
  if (kind === 'category_pie') {
    chartCards.value.push({
      id: genId(),
      kind,
      title: '分类分布',
      catField: catField.value || allFields.value[0] || ''
    })
  } else {
    chartCards.value.push({
      id: genId(),
      kind,
      title: '分组聚合',
      groupField: allFields.value[0] || '',
      aggregateField: numericFields.value[0] || '',
      aggregateType: 'sum'
    })
  }
  schedulePersistEmit()
  scheduleCardChartsRefresh()
}

function removeChartCard(index: number): void {
  const id = chartCards.value[index]?.id
  if (!id) return
  chartCards.value.splice(index, 1)
  cardCharts.get(id)?.dispose()
  cardCharts.delete(id)
  schedulePersistEmit()
}

watch(
  () => props.projectId,
  () => {
    void loadFields()
  },
  { immediate: true }
)

watch([statField, catField], schedulePersistEmit)

watch([statField, () => props.projectId], () => {
  void runNumericStats()
})

watch([catField, () => props.projectId], () => {
  void runCategoryStats()
})

watch(
  chartCards,
  () => {
    schedulePersistEmit()
    scheduleCardChartsRefresh()
  },
  { deep: true }
)

watch(loading, (v) => {
  if (!v) void nextTick(() => resizeChart())
})

onBeforeUnmount(() => {
  if (persistTimer) clearTimeout(persistTimer)
  if (cardRefreshTimer) clearTimeout(cardRefreshTimer)
  disposeAllCardCharts()
})

defineExpose({
  loadFields,
  resizeChart,
  getPersistableDashboard,
  getPersistableChartConfigurations
})
</script>

<template>
  <div v-loading="loading" class="dashboard-root">
    <div class="dash-hero">
      <h2>数据统计与洞察</h2>
      <p class="dash-sub">
        基于当前项目中已导入的结构化行（Excel / CSV / JSON / AI 入库）。图表支持多张卡片、拖拽排序，配置随项目保存。
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

    <el-card shadow="never" class="panel-card chart-gallery-card">
      <template #header>
        <div class="chart-header">
          <span>图表卡片（可拖拽排序）</span>
          <div class="chart-header-actions">
            <el-button size="small" type="primary" plain :icon="Plus" @click="addChartCard('category_pie')">
              饼图
            </el-button>
            <el-button size="small" type="primary" plain :icon="Plus" @click="addChartCard('group_bar')">
              柱状图
            </el-button>
            <el-button size="small" text @click="emit('refresh')">同步数据</el-button>
          </div>
        </div>
      </template>

      <div v-if="!chartCards.length" class="chart-gallery-empty">
        <p>暂无图表卡片。点击「饼图 / 柱状图」添加，或稍等在存在旧项目数据时会自动生成默认布局。</p>
      </div>

      <div v-else class="chart-gallery-list">
        <div
          v-for="(card, index) in chartCards"
          :key="card.id"
          class="chart-dash-card"
          @dragover="onCardDragOver"
          @drop.prevent="onCardDrop(index)"
        >
          <div class="chart-dash-card-toolbar">
            <span
              class="drag-handle"
              title="拖拽排序"
              draggable="true"
              @dragstart="onCardDragStart(index, $event)"
              @dragend="onCardDragEnd"
            >
              <el-icon><Rank /></el-icon>
            </span>
            <el-input v-model="card.title" size="small" class="card-title-input" placeholder="卡片标题" />
            <el-select v-model="card.kind" size="small" class="card-kind-select" @change="onKindChange(card)">
              <el-option label="分类饼图" value="category_pie" />
              <el-option label="分组柱状图" value="group_bar" />
            </el-select>
            <el-button text circle type="danger" :icon="Delete" @click="removeChartCard(index)" />
          </div>
          <div v-if="card.kind === 'category_pie'" class="chart-dash-card-fields">
            <span class="field-label">分类列</span>
            <el-select v-model="card.catField" filterable placeholder="列" size="small" style="width: 220px">
              <el-option v-for="f in allFields" :key="`cp-${card.id}-${f}`" :label="f" :value="f" />
            </el-select>
          </div>
          <div v-else class="chart-dash-card-fields chart-dash-card-fields-row">
            <el-form inline size="small">
              <el-form-item label="分组">
                <el-select v-model="card.groupField" filterable placeholder="分组列" style="width: 160px">
                  <el-option v-for="f in allFields" :key="`gf-${card.id}-${f}`" :label="f" :value="f" />
                </el-select>
              </el-form-item>
              <el-form-item label="聚合列">
                <el-select v-model="card.aggregateField" filterable placeholder="数值列" style="width: 160px">
                  <el-option v-for="f in numericFields" :key="`af-${card.id}-${f}`" :label="f" :value="f" />
                </el-select>
              </el-form-item>
              <el-form-item label="方式">
                <el-select v-model="card.aggregateType" style="width: 110px">
                  <el-option label="求和" value="sum" />
                  <el-option label="平均" value="avg" />
                  <el-option label="计数" value="count" />
                </el-select>
              </el-form-item>
            </el-form>
          </div>
          <div :ref="(el) => bindChartHost(card.id, el)" class="chart-sub" />
        </div>
      </div>
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
.chart-gallery-card {
  margin-top: 4px;
}
.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.chart-header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.chart-gallery-empty {
  padding: 24px;
  color: #94a3b8;
  font-size: 14px;
  text-align: center;
}
.chart-gallery-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 12px;
  align-items: start;
}
.chart-dash-card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px;
  background: #fafafa;
}
.chart-dash-card-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.drag-handle {
  cursor: grab;
  color: #9ca3af;
  display: flex;
  align-items: center;
  padding: 4px;
  user-select: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.card-title-input {
  flex: 1;
  min-width: 120px;
  max-width: 240px;
}
.card-kind-select {
  width: 140px;
}
.chart-dash-card-fields {
  margin-bottom: 10px;
}
.chart-dash-card-fields-row :deep(.el-form-item) {
  margin-bottom: 0;
}
.field-label {
  font-size: 13px;
  color: #64748b;
  margin-right: 8px;
}
.chart-sub {
  width: 100%;
  height: 220px;
  min-height: 180px;
}
.dash-row {
  margin-top: 4px;
}
</style>
