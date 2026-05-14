<script setup lang="ts">
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { Rank, Plus, Delete, EditPen } from '@element-plus/icons-vue'
import { markRaw, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChartCardConfig, ChartCardKind, ChartLegendPosition, DashboardUiPersistV1 } from '../../../preload/index'

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

const chartEditorVisible = ref(false)
const chartEditorForm = ref<ChartCardConfig | null>(null)

const CARD_W_DEF = 380
const CARD_H_DEF = 300
const CARD_W_MIN = 280
const CARD_W_MAX = 720
const CARD_H_MIN = 160
const CARD_H_MAX = 560
const TITLE_FS_DEF = 14
const TITLE_FS_MIN = 10
const TITLE_FS_MAX = 22
const AXIS_FS_DEF = 12
const AXIS_FS_MIN = 8
const AXIS_FS_MAX = 18

type ResizeState = { cardId: string; startX: number; startY: number; startW: number; startH: number }
let resizeState: ResizeState | null = null

function genId(): string {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function defaultCardsFromDashboard(d: DashboardUiPersistV1): ChartCardConfig[] {
  const agg = d.aggregateType === 'avg' || d.aggregateType === 'count' ? d.aggregateType : 'sum'
  return [
    {
      id: genId(),
      kind: 'category_pie',
      title: '分类分布',
      catField: d.catField || '',
      chartStyle: 'pie',
      legendPosition: 'bottom',
      color: '#6366f1',
      cardWidthPx: CARD_W_DEF,
      chartHeightPx: CARD_H_DEF,
      titleFontSize: TITLE_FS_DEF,
      axisFontSize: AXIS_FS_DEF
    },
    {
      id: genId(),
      kind: 'group_bar',
      title: '分组聚合',
      groupField: d.groupField || '',
      aggregateField: d.aggregateField || '',
      aggregateType: agg,
      chartStyle: 'bar',
      legendPosition: 'bottom',
      color: '#6366f1',
      cardWidthPx: CARD_W_DEF,
      chartHeightPx: CARD_H_DEF,
      titleFontSize: TITLE_FS_DEF,
      axisFontSize: AXIS_FS_DEF
    }
  ]
}

function sanitizeCard(c: ChartCardConfig, fields: { all: string[]; numeric: string[] }): ChartCardConfig {
  const agg = c.aggregateType === 'avg' || c.aggregateType === 'count' ? c.aggregateType : 'sum'
  const chartStyle: ChartCardConfig['chartStyle'] =
    c.kind === 'category_pie'
      ? c.chartStyle === 'bar'
        ? 'bar'
        : 'pie'
      : c.chartStyle === 'line'
        ? 'line'
        : 'bar'
  const legendPosition: ChartLegendPosition =
    c.legendPosition === 'top' || c.legendPosition === 'left' || c.legendPosition === 'right' ? c.legendPosition : 'bottom'
  const w =
    typeof c.cardWidthPx === 'number' && Number.isFinite(c.cardWidthPx)
      ? Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, Math.round(c.cardWidthPx)))
      : CARD_W_DEF
  const h =
    typeof c.chartHeightPx === 'number' && Number.isFinite(c.chartHeightPx)
      ? Math.min(CARD_H_MAX, Math.max(CARD_H_MIN, Math.round(c.chartHeightPx)))
      : CARD_H_DEF
  const color = typeof c.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.color.trim()) ? c.color.trim() : '#6366f1'
  const titleFontSize =
    typeof c.titleFontSize === 'number' && Number.isFinite(c.titleFontSize)
      ? Math.min(TITLE_FS_MAX, Math.max(TITLE_FS_MIN, Math.round(c.titleFontSize)))
      : TITLE_FS_DEF
  const axisFontSize =
    typeof c.axisFontSize === 'number' && Number.isFinite(c.axisFontSize)
      ? Math.min(AXIS_FS_MAX, Math.max(AXIS_FS_MIN, Math.round(c.axisFontSize)))
      : AXIS_FS_DEF
  const base: ChartCardConfig = {
    ...c,
    chartStyle,
    legendPosition,
    color,
    cardWidthPx: w,
    chartHeightPx: h,
    aggregateType: agg,
    titleFontSize,
    axisFontSize
  }
  if (c.kind === 'category_pie') {
    const cf = c.catField?.trim() ?? ''
    return {
      ...base,
      catField: cf && fields.all.includes(cf) ? cf : ''
    }
  }
  const gf = c.groupField?.trim() ?? ''
  const af = c.aggregateField?.trim() ?? ''
  return {
    ...base,
    groupField: gf && fields.all.includes(gf) ? gf : '',
    aggregateField: af && fields.numeric.includes(af) ? af : ''
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

function legendEchartsOption(pos: ChartLegendPosition | undefined, legendFontSize: number): Record<string, unknown> {
  const p = pos ?? 'bottom'
  const textStyle = { fontSize: legendFontSize }
  if (p === 'top') return { type: 'scroll', top: 4, textStyle }
  if (p === 'left') return { type: 'scroll', left: 4, orient: 'vertical', textStyle }
  if (p === 'right') return { type: 'scroll', right: 4, orient: 'vertical', textStyle }
  return { type: 'scroll', bottom: 0, textStyle }
}

function onResizeMove(ev: MouseEvent): void {
  if (!resizeState) return
  const card = chartCards.value.find((c) => c.id === resizeState!.cardId)
  if (!card) return
  const dw = ev.clientX - resizeState.startX
  const dh = ev.clientY - resizeState.startY
  card.cardWidthPx = Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, resizeState.startW + dw))
  card.chartHeightPx = Math.min(CARD_H_MAX, Math.max(CARD_H_MIN, resizeState.startH + dh))
  void refreshCardChart(card.id)
}

function endCardResize(): void {
  if (resizeState) {
    resizeState = null
    schedulePersistEmit()
  }
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', endCardResize)
}

function startCardResize(card: ChartCardConfig, ev: MouseEvent): void {
  ev.preventDefault()
  ev.stopPropagation()
  resizeState = {
    cardId: card.id,
    startX: ev.clientX,
    startY: ev.clientY,
    startW: card.cardWidthPx ?? CARD_W_DEF,
    startH: card.chartHeightPx ?? CARD_H_DEF
  }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', endCardResize)
}

function openChartEditor(card: ChartCardConfig): void {
  chartEditorForm.value = JSON.parse(JSON.stringify(card)) as ChartCardConfig
  chartEditorVisible.value = true
}

function applyChartEditor(): void {
  const draft = chartEditorForm.value
  if (!draft?.id) {
    chartEditorVisible.value = false
    return
  }
  const idx = chartCards.value.findIndex((c) => c.id === draft.id)
  if (idx >= 0) {
    const fields = { all: allFields.value, numeric: numericFields.value }
    chartCards.value[idx] = sanitizeCard({ ...draft, id: draft.id }, fields)
  }
  chartEditorVisible.value = false
  chartEditorForm.value = null
  schedulePersistEmit()
  scheduleCardChartsRefresh()
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

  const titleText = card.title?.trim()
  const pal = card.color ?? '#6366f1'
  const titleFs = card.titleFontSize ?? TITLE_FS_DEF
  const axisFs = card.axisFontSize ?? AXIS_FS_DEF
  const leg = legendEchartsOption(card.legendPosition, axisFs)

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
    const style = card.chartStyle === 'bar' ? 'bar' : 'pie'
    if (style === 'pie') {
      inst.setOption({
        color: [pal, '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444'],
        title: { text: titleText || `「${f}」分布`, left: 'center', textStyle: { fontSize: titleFs } },
        tooltip: { trigger: 'item' },
        legend: { ...leg, data: data.map((d) => d.name) },
        series: [{ type: 'pie', radius: ['30%', '58%'], data }]
      })
    } else {
      inst.setOption({
        color: [pal],
        title: { text: titleText || `「${f}」计数`, left: 'center', textStyle: { fontSize: titleFs } },
        tooltip: { trigger: 'axis' },
        legend: { show: false },
        xAxis: {
          type: 'category',
          data: data.map((d) => d.name),
          name: card.xAxisName?.trim() || f,
          nameTextStyle: { fontSize: axisFs },
          axisLabel: { rotate: 24, fontSize: axisFs }
        },
        yAxis: {
          type: 'value',
          name: card.yAxisName?.trim() || '计数',
          nameTextStyle: { fontSize: axisFs },
          axisLabel: { fontSize: axisFs }
        },
        series: [{ type: 'bar', data: data.map((d) => d.value), itemStyle: { color: pal } }]
      })
    }
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
    const seriesType = card.chartStyle === 'line' ? 'line' : 'bar'
    inst.setOption({
      color: [pal],
      title: {
        text: titleText || `${aggLabel}(${af}) · 按 ${gf}`,
        left: 'center',
        textStyle: { fontSize: titleFs }
      },
      tooltip: { trigger: 'axis' },
      legend: { show: false },
      xAxis: {
        type: 'category',
        data: labels,
        name: card.xAxisName?.trim() || gf,
        nameLocation: 'middle',
        nameGap: 28,
        nameTextStyle: { fontSize: axisFs },
        axisLabel: { rotate: 28, fontSize: axisFs }
      },
      yAxis: {
        type: 'value',
        name: card.yAxisName?.trim() || `${aggLabel}(${af})`,
        nameTextStyle: { fontSize: axisFs },
        axisLabel: { fontSize: axisFs }
      },
      series: [
        {
          type: seriesType,
          data: values,
          itemStyle: { color: pal },
          lineStyle: seriesType === 'line' ? { width: 2, color: pal } : undefined,
          smooth: seriesType === 'line'
        }
      ]
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
    card.chartStyle = 'pie'
    if (!(card.catField ?? '').trim() && catField.value) card.catField = catField.value
    if (!(card.catField ?? '').trim() && allFields.value[0]) card.catField = allFields.value[0]
  } else {
    card.catField = undefined
    card.chartStyle = 'bar'
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
      catField: catField.value || allFields.value[0] || '',
      chartStyle: 'pie',
      legendPosition: 'bottom',
      color: '#6366f1',
      cardWidthPx: CARD_W_DEF,
      chartHeightPx: CARD_H_DEF,
      titleFontSize: TITLE_FS_DEF,
      axisFontSize: AXIS_FS_DEF
    })
  } else {
    chartCards.value.push({
      id: genId(),
      kind,
      title: '分组聚合',
      groupField: allFields.value[0] || '',
      aggregateField: numericFields.value[0] || '',
      aggregateType: 'sum',
      chartStyle: 'bar',
      legendPosition: 'bottom',
      color: '#6366f1',
      cardWidthPx: CARD_W_DEF,
      chartHeightPx: CARD_H_DEF,
      titleFontSize: TITLE_FS_DEF,
      axisFontSize: AXIS_FS_DEF
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
  endCardResize()
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
        基于当前项目中已导入的结构化行（Excel / CSV / JSON / AI 入库）。图表支持拖拽排序、**拖拽右下角调整大小**、双击或「编辑」精细配置；设置随项目保存。
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
          :style="{ width: `${card.cardWidthPx ?? CARD_W_DEF}px` }"
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
            <el-button text circle type="primary" :icon="EditPen" title="编辑图表" @click="openChartEditor(card)" />
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
          <div
            :ref="(el) => bindChartHost(card.id, el)"
            class="chart-sub"
            :style="{ height: `${card.chartHeightPx ?? CARD_H_DEF}px` }"
            title="双击打开编辑"
            @dblclick.stop="openChartEditor(card)"
          />
          <div class="chart-resize-handle" title="拖拽调整大小" @mousedown="startCardResize(card, $event)" />
        </div>
      </div>
    </el-card>
  </div>

  <el-dialog
    v-model="chartEditorVisible"
    title="编辑图表"
    width="540px"
    destroy-on-close
    @closed="chartEditorForm = null"
  >
    <template v-if="chartEditorForm">
      <el-form label-position="top" size="small">
        <el-form-item label="标题">
          <el-input v-model="chartEditorForm.title" placeholder="图表标题" />
        </el-form-item>
        <el-form-item v-if="chartEditorForm.kind === 'category_pie'" label="图表类型">
          <el-radio-group v-model="chartEditorForm.chartStyle">
            <el-radio-button value="pie">饼图</el-radio-button>
            <el-radio-button value="bar">柱状</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-else label="图表类型">
          <el-radio-group v-model="chartEditorForm.chartStyle">
            <el-radio-button value="bar">柱状</el-radio-button>
            <el-radio-button value="line">折线</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="横轴 / 分类轴名称">
          <el-input v-model="chartEditorForm.xAxisName" placeholder="可选；饼图仅在柱状模式下有效" />
        </el-form-item>
        <el-form-item label="纵轴 / 数值轴名称">
          <el-input v-model="chartEditorForm.yAxisName" placeholder="可选" />
        </el-form-item>
        <el-form-item v-if="chartEditorForm.kind === 'category_pie'" label="分类列">
          <el-select v-model="chartEditorForm.catField" filterable style="width: 100%">
            <el-option v-for="f in allFields" :key="`ed-c-${f}`" :label="f" :value="f" />
          </el-select>
        </el-form-item>
        <template v-else>
          <el-form-item label="分组列">
            <el-select v-model="chartEditorForm.groupField" filterable style="width: 100%">
              <el-option v-for="f in allFields" :key="`ed-g-${f}`" :label="f" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="聚合列">
            <el-select v-model="chartEditorForm.aggregateField" filterable style="width: 100%">
              <el-option v-for="f in numericFields" :key="`ed-a-${f}`" :label="f" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="聚合方式">
            <el-select v-model="chartEditorForm.aggregateType" style="width: 100%">
              <el-option label="求和" value="sum" />
              <el-option label="平均" value="avg" />
              <el-option label="计数" value="count" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item label="主色">
          <div class="chart-editor-color-row">
            <el-color-picker v-model="chartEditorForm.color" :predefine="['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444']" />
            <el-input v-model="chartEditorForm.color" class="chart-editor-color-input" />
          </div>
        </el-form-item>
        <el-form-item label="图例位置">
          <el-select v-model="chartEditorForm.legendPosition" style="width: 100%">
            <el-option label="底部" value="bottom" />
            <el-option label="顶部" value="top" />
            <el-option label="左侧" value="left" />
            <el-option label="右侧" value="right" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题字号">
          <el-input-number v-model="chartEditorForm.titleFontSize" :min="TITLE_FS_MIN" :max="TITLE_FS_MAX" :step="1" />
        </el-form-item>
        <el-form-item label="坐标轴 / 图例字号">
          <el-input-number v-model="chartEditorForm.axisFontSize" :min="AXIS_FS_MIN" :max="AXIS_FS_MAX" :step="1" />
        </el-form-item>
        <el-form-item label="卡片宽度 (px)">
          <el-input-number v-model="chartEditorForm.cardWidthPx" :min="CARD_W_MIN" :max="CARD_W_MAX" :step="10" />
        </el-form-item>
        <el-form-item label="绘图区高度 (px)">
          <el-input-number v-model="chartEditorForm.chartHeightPx" :min="CARD_H_MIN" :max="CARD_H_MAX" :step="10" />
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <el-button @click="chartEditorVisible = false">取消</el-button>
      <el-button type="primary" @click="applyChartEditor">保存</el-button>
    </template>
  </el-dialog>
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
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-start;
}
.chart-dash-card {
  position: relative;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px;
  background: #fafafa;
  flex: 0 0 auto;
}
.chart-resize-handle {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  z-index: 3;
  border-radius: 2px;
  background: linear-gradient(135deg, transparent 52%, #94a3b8 52%);
  opacity: 0.85;
}
.chart-resize-handle:hover {
  opacity: 1;
}
.chart-editor-color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.chart-editor-color-input {
  width: 120px;
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
  min-height: 120px;
}
.dash-row {
  margin-top: 4px;
}
</style>
