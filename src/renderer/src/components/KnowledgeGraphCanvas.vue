<script setup lang="ts">
import * as echarts from 'echarts'
import { markRaw, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { GraphEdge, GraphFilterInput, GraphNode } from '../../../preload/index'

const props = defineProps<{
  /** 书柜模式：仅 project_id 为空的节点 */
  bookshelfOnly?: boolean
  projectId?: number | null
  typeFilters?: string[]
  tagFilters?: string[]
  repulsion?: number
  edgeLength?: number
}>()

const emit = defineEmits<{
  (e: 'node-click', nodeId: number): void
  (e: 'node-context', payload: { nodeId: number; x: number; y: number }): void
  (e: 'layout-save', positions: Array<{ id: number; x: number; y: number }>): void
}>()

const host = ref<HTMLDivElement | null>(null)
const inst = shallowRef<echarts.ECharts | null>(null)
let hostResizeObserver: ResizeObserver | null = null
const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])

function colorForType(t: GraphNode['type']): string {
  if (t === 'excel_row') return '#3b82f6'
  if (t === 'note') return '#67C23A'
  if (t === 'file') return '#f59e0b'
  return '#a855f7'
}

async function refresh(): Promise<void> {
  const filters: GraphFilterInput = {
    types: [...(props.typeFilters ?? [])],
    tags: [...(props.tagFilters ?? [])],
    bookshelfOnly: Boolean(props.bookshelfOnly)
  }
  if (!props.bookshelfOnly && props.projectId != null) {
    filters.projectId = props.projectId
  }
  const r = await window.api.getGraphData(filters)
  if (!r.success) return
  nodes.value = r.data?.nodes ?? []
  edges.value = r.data?.edges ?? []
  await paint()
}

async function paint(): Promise<void> {
  await nextTick()
  if (!host.value) return
  if (!inst.value) {
    inst.value = markRaw(echarts.init(host.value))
  }
  const chart = inst.value
  chart.off('click')
  chart.off('contextmenu')
  const rep = props.repulsion ?? 650
  const el = props.edgeLength ?? 150

  const nodeData = nodes.value.map((node) => ({
    id: String(node.id),
    name: node.name || `Node #${node.id}`,
    type: node.type,
    tags: node.tags ?? [],
    x: node.x ?? undefined,
    y: node.y ?? undefined,
    fixed: typeof node.x === 'number' && typeof node.y === 'number',
    symbolSize: node.type === 'note' ? 40 : node.type === 'file' ? 36 : 32,
    itemStyle: { color: colorForType(node.type) }
  }))

  const linkData = edges.value.map((edge) => ({
    id: String(edge.id),
    source: String(edge.source),
    target: String(edge.target),
    value: edge.label || '',
    label: edge.label || '',
    lineStyle: { opacity: 0.9, width: 1.5 }
  }))

  chart.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataType?: string; data?: { name?: string; type?: string; tags?: GraphNode['tags'] } }) => {
        if (p.dataType !== 'node') return ''
        const d = p.data
        const tags = (d?.tags ?? []).map((t: { name: string }) => t.name).join(', ') || '无'
        return `名称：${d?.name ?? ''}<br/>类型：${d?.type ?? ''}<br/>标签：${tags}`
      }
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [4, 10],
        force: { repulsion: rep, edgeLength: [el * 0.65, el] },
        label: {
          show: true,
          position: 'bottom',
          fontSize: 11,
          color: '#555',
          formatter: (par: { data?: { name?: string } }) => {
            const raw = par?.data?.name ?? ''
            return raw.length > 10 ? `${raw.slice(0, 10)}…` : raw
          }
        },
        data: nodeData,
        links: linkData,
        lineStyle: { opacity: 0.85, width: 1.4, curveness: 0.1 }
      }
    ]
  })

  chart.on('click', (params: any) => {
    if (params.dataType !== 'node' || !params.data?.id) return
    emit('node-click', Number(params.data.id))
  })

  chart.on('contextmenu', { dataType: 'node' }, (params: any) => {
    const id = params?.data?.id
    if (id == null) return
    const ev = params?.event?.event as MouseEvent | undefined
    if (ev) {
      ev.preventDefault()
      emit('node-context', { nodeId: Number(id), x: ev.clientX, y: ev.clientY })
    }
  })

  chart.on('dragend', () => {
    const opt = chart.getOption() as { series?: Array<{ data?: Array<{ id?: string; x?: number; y?: number }> }> }
    const raw = opt.series?.[0]?.data ?? []
    const positions = raw
      .filter((d) => d.id && typeof d.x === 'number' && typeof d.y === 'number')
      .map((d) => ({ id: Number(d.id), x: d.x!, y: d.y! }))
    if (positions.length) emit('layout-save', positions)
  })
  chart.resize()
}

function resize(): void {
  inst.value?.resize()
}

watch(
  () => [props.bookshelfOnly, props.projectId, props.typeFilters, props.tagFilters, props.repulsion, props.edgeLength],
  () => {
    void refresh()
  },
  { deep: true }
)

watch(
  () => host.value,
  (el) => {
    hostResizeObserver?.disconnect()
    hostResizeObserver = null
    if (el) {
      hostResizeObserver = new ResizeObserver(() => {
        resize()
      })
      hostResizeObserver.observe(el)
      void refresh()
    }
  }
)

onBeforeUnmount(() => {
  hostResizeObserver?.disconnect()
  hostResizeObserver = null
  inst.value?.dispose()
  inst.value = null
})

defineExpose({ refresh, resize })
</script>

<template>
  <div ref="host" class="kg-canvas" />
</template>

<style scoped>
.kg-canvas {
  width: 100%;
  height: 100%;
  min-height: 420px;
}
</style>
