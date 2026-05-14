<script setup lang="ts">
import * as echarts from 'echarts'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import DashboardView from './components/DashboardView.vue'
import RawDataView from './components/RawDataView.vue'
import BookshelfView from './components/BookshelfView.vue'
import NoteEditorShell from './components/NoteEditorShell.vue'
import type { AiMessageRow, AiTopicRow, ChartCardConfig, DashboardUiPersistV1, ProjectUiStateV1 } from '../../preload/index'
import { Close, Delete, Document, EditPen, Expand, Filter, Fold, FolderOpened, FullScreen, Hide, Link, MagicStick, MoreFilled, Plus, Reading, Refresh, Search, Upload, View } from '@element-plus/icons-vue'

type ItemRow = {
  id: number
  project_id: number | null
  type: 'note' | 'excel_row' | 'document' | 'file'
  title: string
  content_text: string
  content_json: string
  source_file_path: string
  created_at: string
}

type FlattenedItemRow = ItemRow & Record<string, unknown>
type GraphNode = {
  id: number
  name: string
  type: ItemRow['type']
  tags: Array<{ id: number; name: string; color: string }>
  x: number | null
  y: number | null
}
type GraphEdge = {
  id: number
  source: number
  target: number
  label: string
}
type NodeEdge = GraphEdge & {
  direction: 'outgoing' | 'incoming'
  otherNodeId: number
  otherNodeName: string
  otherNodeType: ItemRow['type']
}
type NodeSearchOption = {
  id: number
  name: string
  type: ItemRow['type']
}
type NodeDetail = GraphNode & {
  title?: string
  content_text?: string
  content_json?: string
  source_file_path?: string
  created_at?: string
}
type AppSettings = {
  ai_api_key: string
  ai_base_url: string
  ai_model_name: string
  ai_system_prompt: string
  ai_temperature: number
  graph_node_size: number
  graph_edge_length: number
  graph_repulsion: number
  app_theme: string
  app_language: string
}
type DataPathsSnapshot = {
  userData: string
  logsDir: string
  logFile: string
  dbFile: string
}
type ProjectRow = {
  id: number
  name: string
  created_at: string
}
type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  chartSpec?: Record<string, unknown> | null
}
type SelectedContextNode = {
  id: number
  title: string
}

function emptyDashboard(): DashboardUiPersistV1 {
  return {
    statField: '',
    catField: '',
    groupField: '',
    aggregateField: '',
    aggregateType: 'sum'
  }
}

const COPILOT_WELCOME_PROJECT: ChatMessage = {
  role: 'assistant',
  content:
    '你好，我是「项目 AI」助手。对话按项目隔离；左侧可创建与切换**分支**。请结合当前项目数据提问，或使用「应用 JSON 入库」。'
}

const COPILOT_WELCOME_GLOBAL: ChatMessage = {
  role: 'assistant',
  content:
    '你好，我是「全局 AI」助手。对话不与任何项目绑定，适合通用问答、代码与文档；左侧可管理**全局对话分支**（与项目 AI 历史完全独立）。'
}

const loading = ref(false)
const importing = ref(false)
const searching = ref(false)
const savingNodeDetail = ref(false)
const settingsVisible = ref(false)
const settingsLoading = ref(false)
const savingSettings = ref(false)
const storagePath = ref('')
const appReady = ref(false)
const firstLaunchStorageDialogVisible = ref(false)
const firstLaunchPendingPath = ref('')
const dataDiagnostic = ref<DataPathsSnapshot>({
  userData: '',
  logsDir: '',
  logFile: '',
  dbFile: ''
})
const initialStorageLoading = ref(false)
const sidebarCollapsed = ref(false)
const creatingProject = ref(false)
const projects = ref<ProjectRow[]>([])
const shellMode = ref<'bookshelf' | 'project'>('bookshelf')
const currentProjectId = ref<number | null>(null)
const bookshelfRef = ref<InstanceType<typeof BookshelfView> | null>(null)
const workspaceTab = ref<'dashboard' | 'raw' | 'notes'>('dashboard')
/** 项目内嵌图谱已迁到书柜；保留 false 以兼容遗留分支 */
const isGraphOpen = computed(() => false)
const dashboardRef = ref<InstanceType<typeof DashboardView> | null>(null)
const pendingAiImport = ref<{ preview: string; path: string } | null>(null)
const copilotVisible = ref(false)
const copilotMode = ref<'project' | 'global'>('project')
const copilotMaximized = ref(false)
const copilotTopicsCollapsed = ref(false)
function copilotWelcomeMessage(): ChatMessage {
  return copilotMode.value === 'global' ? COPILOT_WELCOME_GLOBAL : COPILOT_WELCOME_PROJECT
}
const savedDashboardState = ref<DashboardUiPersistV1>(emptyDashboard())
/** undefined：数据库从未写入 chartConfigurations（旧数据），由子组件生成默认卡片 */
const chartConfigurationsState = ref<ChartCardConfig[] | undefined>(undefined)
const aiTopics = ref<AiTopicRow[]>([])
const activeAiTopicId = ref<number | null>(null)
const activeGlobalAiTopicId = ref<number | null>(null)
const globalLinkedProjectIds = ref<number[]>([])
const globalLinkedDraftIds = ref<number[]>([])
const globalLinkedFlyoutOpen = ref(false)
const projectNotesList = ref<ItemRow[]>([])
const importChoiceDialogVisible = ref(false)
const bookshelfPickForImportVisible = ref(false)
const bookshelfImportCandidates = ref<ItemRow[]>([])
let globalLinkedPersistTimer: ReturnType<typeof setTimeout> | null = null
let projectUiPersistTimer: ReturnType<typeof setTimeout> | null = null
const chatSending = ref(false)
const chatInput = ref('')
const chatMessages = ref<ChatMessage[]>([COPILOT_WELCOME_PROJECT])
const selectedContextNode = ref<SelectedContextNode | null>(null)
const settingsForm = ref<AppSettings>({
  ai_api_key: '',
  ai_base_url: '',
  ai_model_name: 'gpt-4o-mini',
  ai_system_prompt: '',
  ai_temperature: 0.4,
  graph_node_size: 36,
  graph_edge_length: 150,
  graph_repulsion: 650,
  app_theme: 'light',
  app_language: 'zh-CN'
})
const items = ref<ItemRow[]>([])
const flattenedRows = ref<FlattenedItemRow[]>([])
const activeNodeId = ref<number | null>(null)
const detailDrawerVisible = ref(false)
const currentDetailData = ref<Record<string, unknown> | null>(null)
const currentTableFilter = ref<string>('all')
const graphTypeFilters = shallowRef<string[]>([])
const graphTagFilters = shallowRef<string[]>([])
const allTags = shallowRef<Array<{ id: number; name: string; color: string }>>([])
const isFocusMode = ref(false)
const focusNodeName = ref('')
const searchKeyword = ref('')
const noteEditorOpen = ref(false)
const noteEditorId = ref<number | null>(null)
const noteEditorNotebookId = ref(0)
const noteEditorProjectId = ref<number | null>(null)
const noteEditorTitleSeed = ref('')
const noteEditorVariant = ref<'split' | 'fullscreen'>('fullscreen')
const showMetadata = ref(false)
const graphContainer = ref<HTMLDivElement | null>(null)
const chatMessagesContainer = ref<HTMLDivElement | null>(null)
const graphInstance = shallowRef<echarts.ECharts | null>(null)
const nodeTagsMap = ref<Record<number, Array<{ id: number; name: string; color: string }>>>({})
const graphNodes = shallowRef<GraphNode[]>([])
const graphEdges = shallowRef<GraphEdge[]>([])
const currentNode = ref<NodeDetail | null>(null)
const drawerTitle = ref('')
const drawerContent = ref('')
const drawerTagsInput = ref('')
const newTagName = ref('')
const newTagColor = ref('#3b82f6')
const relationTargetId = ref<number | null>(null)
const relationLabel = ref('')
const relationSearchLoading = ref(false)
const relationOptions = ref<NodeSearchOption[]>([])
const nodeRelations = ref<NodeEdge[]>([])
const activeDrawerTab = ref('info')
const isEditing = ref(false)
const editForm = ref<Record<string, any>>({})
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const currentContextNode = ref<Record<string, any> | null>(null)
const hiddenNodeIds = ref<Set<number>>(new Set())
const STORAGE_PATH_KEY = 'app_storage_path'
let graphSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const formatImportUiError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  const friendlyMessage =
    '读取文件失败，请检查该文件是否正在被 Excel 等其他软件打开，或尝试将其移动到其他目录后重试。'
  if (
    /cannot access file|cannot save file|EACCES|EPERM|EBUSY|ENOENT|permission|busy|locked|no such file|used by another process/i.test(
      cleaned
    )
  ) {
    return friendlyMessage
  }
  return cleaned.startsWith('导入失败') ? cleaned : `导入失败：${cleaned || message}`
}

const formatImportBackendMessage = (raw: string): string => {
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  const friendlyMessage =
    '读取文件失败，请检查该文件是否正在被 Excel 等其他软件打开，或尝试将其移动到其他目录后重试。'
  if (
    /cannot access file|cannot save file|EACCES|EPERM|EBUSY|ENOENT|permission denied|busy|locked|no such file|used by another process/i.test(
      cleaned
    )
  ) {
    return friendlyMessage
  }
  return cleaned || raw
}

const parseJsonSafely = (input: string): Record<string, string> => {
  if (!input?.trim()) return {}
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])
    )
  } catch {
    // content_json 可能来自历史数据，解析失败时降级为空对象，避免页面崩溃
    return {}
  }
}

const dynamicColumns = computed<string[]>(() => {
  const keySet = new Set<string>()
  for (const row of flattenedRows.value) {
    if (row.type !== 'excel_row') continue
    Object.keys(row).forEach((key) => {
      if (
        !['id', 'type', 'content_text', 'content_json', 'source_file_path', 'created_at'].includes(key) &&
        key
      ) {
        keySet.add(key)
      }
    })
  }
  return Array.from(keySet)
})

const isStructuredImportPath = (filePath: string): boolean => {
  const lower = filePath.toLowerCase()
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.docx') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.json') ||
    lower.endsWith('.txt')
  )
}

const availableTypes = computed(() => {
  const set = new Set<string>()
  for (const row of flattenedRows.value) {
    if (typeof row.type === 'string' && row.type.trim()) {
      set.add(row.type)
    }
  }
  return Array.from(set)
})

const rowMatchesSearchKeyword = (row: FlattenedItemRow): boolean => {
  const normalizedKeyword = searchKeyword.value.trim().toLowerCase()
  if (!normalizedKeyword) return true

  const tags = nodeTagsMap.value[row.id] ?? []
  const searchableText = [
    row.title,
    row.type,
    row.content_text,
    row.content_json,
    row.source_file_path,
    summarizeContent(row),
    ...tags.map((tag) => tag.name),
    ...Object.values(row).map((value) => String(value ?? ''))
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return searchableText.includes(normalizedKeyword)
}

const filteredTableData = computed(() => {
  return flattenedRows.value.filter((row) => {
    const typeMatched = currentTableFilter.value === 'all' || row.type === currentTableFilter.value
    return typeMatched && rowMatchesSearchKeyword(row)
  })
})

const filteredGraphData = computed(() => {
  const normalizedKeyword = searchKeyword.value.trim().toLowerCase()
  const matchedNodeIds = normalizedKeyword
    ? new Set(
        flattenedRows.value
          .filter((row) => rowMatchesSearchKeyword(row))
          .map((row) => Number(row.id))
          .filter((id) => Number.isFinite(id))
      )
    : new Set(graphNodes.value.map((node) => node.id))
  const finalNodeIds = new Set(
    [...matchedNodeIds].filter((id) => !hiddenNodeIds.value.has(id))
  )
  const filteredNodes = graphNodes.value.filter(
    (node) => finalNodeIds.has(node.id) || (normalizedKeyword && nodeMatchesKeyword(node, normalizedKeyword) && !hiddenNodeIds.value.has(node.id))
  )
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id))
  const filteredEdges = graphEdges.value.filter(
    (edge) => filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
  )

  return { nodes: filteredNodes, relationships: filteredEdges }
})

const relatedNodesList = computed(() => {
  if (!currentDetailData.value) return []
  const currentId = Number(currentDetailData.value.id)
  if (!Number.isFinite(currentId)) return []

  const relatedIds = new Set<number>()
  graphEdges.value.forEach((edge) => {
    if (edge.source === currentId) relatedIds.add(edge.target)
    if (edge.target === currentId) relatedIds.add(edge.source)
  })

  return graphNodes.value.filter((node) => relatedIds.has(node.id))
})

const drawerTagList = computed(() => {
  const rawTags = editForm.value.tags
  if (Array.isArray(rawTags)) {
    const tags = rawTags
      .map((tag) => (typeof tag === 'string' ? tag : String(tag?.name ?? '')))
      .filter(Boolean)
    return tags.length ? tags : ['默认标签']
  }
  if (typeof rawTags === 'string') {
    const tags = rawTags
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    return tags.length ? tags : ['默认标签']
  }
  return ['默认标签']
})

const copilotContextLabel = computed(() => {
  if (copilotMode.value === 'global') {
    const n = globalLinkedProjectIds.value.length
    if (n > 0) {
      return `全局 AI：已合并 ${n} 个关联项目的结构化数据；不使用图谱节点上下文。`
    }
    return '全局 AI：未绑定关联项目数据与节点上下文'
  }
  if (!selectedContextNode.value) return '当前未选中节点（项目 AI）'
  return `已关联当前选中节点：${selectedContextNode.value.title}`
})

const copilotRailTitle = computed(() => (copilotMode.value === 'global' ? '全局对话' : '分支'))

const copilotModeBadge = computed(() => {
  if (copilotMode.value === 'global') {
    const ids = globalLinkedProjectIds.value
    if (!ids.length) return '全局 AI'
    const names = ids
      .map((id) => projects.value.find((p) => p.id === id)?.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, 5)
    const tail = ids.length > 5 ? ` 等 ${ids.length} 个` : ''
    return `全局 AI（关联项目：${names.join('、')}${tail}）`
  }
  return `项目 AI · ${currentProject.value?.name ?? '—'}`
})

function openGlobalLinkedFlyout(): void {
  globalLinkedDraftIds.value = [...globalLinkedProjectIds.value]
  globalLinkedFlyoutOpen.value = true
}

function confirmGlobalLinkedProjects(): void {
  globalLinkedProjectIds.value = [...globalLinkedDraftIds.value]
  onGlobalLinkedProjectsChange()
  globalLinkedFlyoutOpen.value = false
}

async function loadGlobalLinkedProjectsFromDb(): Promise<void> {
  const r = await window.api.getGlobalAiLinkedProjectIds()
  if (r.success && Array.isArray(r.data)) {
    globalLinkedProjectIds.value = r.data
  }
}

function schedulePersistGlobalLinkedProjects(): void {
  if (globalLinkedPersistTimer) clearTimeout(globalLinkedPersistTimer)
  globalLinkedPersistTimer = setTimeout(() => {
    globalLinkedPersistTimer = null
    void window.api.setGlobalAiLinkedProjectIds(globalLinkedProjectIds.value)
  }, 400)
}

function onGlobalLinkedProjectsChange(): void {
  schedulePersistGlobalLinkedProjects()
}

const copilotLeftPx = computed(() => (sidebarCollapsed.value ? 64 : 240))

function messagesPayloadForApi(): Array<{ role: 'user' | 'assistant'; content: string }> {
  const w = copilotWelcomeMessage().content
  return chatMessages.value
    .filter((m) => !(m.role === 'assistant' && m.content === w))
    .map((m) => ({ role: m.role, content: m.content }))
}

const currentProject = computed(() => projects.value.find((project) => project.id === currentProjectId.value) ?? null)

const summarizeContent = (row: ItemRow): string => {
  const rawText = (row.title || row.content_text)?.trim()
  if (rawText) return rawText.slice(0, 80)

  if (!row.content_json) return ''
  try {
    const obj = JSON.parse(row.content_json) as Record<string, unknown>
    const compact = Object.entries(obj)
      .map(([key, value]) => `${key}:${String(value ?? '')}`)
      .join(' | ')
    return compact.slice(0, 80)
  } catch {
    return row.content_json.slice(0, 80)
  }
}

const flattenRows = (source: ItemRow[]): FlattenedItemRow[] => {
  return source.map((row) => {
    if (row.type !== 'excel_row' || !row.content_json?.trim()) return { ...row }
    const parsed = parseJsonSafely(row.content_json)
    // 将 content_json 展平到第一层，供 :prop 直接绑定
    return { ...row, ...parsed }
  })
}

const applyRows = (source: ItemRow[]): void => {
  items.value = source
  flattenedRows.value = flattenRows(source)
  void nextTick(() => dashboardRef.value?.loadFields())
}

async function loadProjectUiFromDb(projectId: number): Promise<void> {
  const r = await window.api.getProjectUiState(projectId)
  if (r.success && r.data) {
    const d = r.data
    savedDashboardState.value = { ...emptyDashboard(), ...d.dashboard }
    currentTableFilter.value = d.workspace?.tableFilter?.trim() ? d.workspace.tableFilter : 'all'
    searchKeyword.value = d.workspace?.searchKeyword ?? ''
    const tab = d.workspace?.workspaceTab
    workspaceTab.value = tab === 'raw' || tab === 'notes' || tab === 'dashboard' ? tab : 'dashboard'
    activeAiTopicId.value =
      typeof d.aiCurrentTopicId === 'number' && Number.isFinite(d.aiCurrentTopicId) ? d.aiCurrentTopicId : null
    chartConfigurationsState.value = d.chartConfigurations
  } else {
    savedDashboardState.value = emptyDashboard()
    currentTableFilter.value = 'all'
    searchKeyword.value = ''
    workspaceTab.value = 'dashboard'
    activeAiTopicId.value = null
    chartConfigurationsState.value = undefined
  }
}

async function persistCurrentProjectUiState(projectId: number): Promise<void> {
  const inst = dashboardRef.value as unknown as {
    getPersistableDashboard?: () => DashboardUiPersistV1
    getPersistableChartConfigurations?: () => ChartCardConfig[]
  } | null
  const dash = inst?.getPersistableDashboard?.() ?? savedDashboardState.value
  const charts = inst?.getPersistableChartConfigurations?.() ?? chartConfigurationsState.value ?? []
  const state: ProjectUiStateV1 = {
    dashboard: { ...emptyDashboard(), ...dash },
    workspace: {
      tableFilter: currentTableFilter.value,
      searchKeyword: searchKeyword.value,
      workspaceTab: workspaceTab.value
    },
    aiCurrentTopicId: activeAiTopicId.value,
    chartConfigurations: charts
  }
  savedDashboardState.value = state.dashboard
  chartConfigurationsState.value = charts
  const res = await window.api.saveProjectUiState(projectId, state)
  if (!res.success && res.message) {
    console.warn(res.message)
  }
}

function schedulePersistProjectUi(): void {
  const pid = currentProjectId.value
  if (pid == null) return
  if (projectUiPersistTimer) clearTimeout(projectUiPersistTimer)
  projectUiPersistTimer = setTimeout(() => {
    projectUiPersistTimer = null
    void persistCurrentProjectUiState(pid)
  }, 480)
}

function coerceTableFilterForAvailableTypes(): void {
  const f = currentTableFilter.value
  if (f === 'all') return
  if (!availableTypes.value.includes(f)) {
    currentTableFilter.value = 'all'
  }
}

function onDashboardPersist(payload: {
  dashboard: DashboardUiPersistV1
  chartConfigurations: ChartCardConfig[]
}): void {
  savedDashboardState.value = payload.dashboard
  chartConfigurationsState.value = payload.chartConfigurations
  schedulePersistProjectUi()
}

async function loadAiTopicsForProject(): Promise<void> {
  const pid = currentProjectId.value
  if (pid == null) {
    aiTopics.value = []
    return
  }
  const r = await window.api.listAiTopics(pid)
  aiTopics.value = r.success && Array.isArray(r.data) ? r.data : []
}

async function loadGlobalAiTopics(): Promise<void> {
  const r = await window.api.listGlobalAiTopics()
  aiTopics.value = r.success && Array.isArray(r.data) ? r.data : []
}

async function ensureDefaultAiTopic(): Promise<void> {
  const pid = currentProjectId.value
  if (pid == null) return
  if (aiTopics.value.length) return
  const r = await window.api.createAiTopic(pid, '默认分支')
  if (r.success && r.data?.id) {
    activeAiTopicId.value = r.data.id
    await loadAiTopicsForProject()
  }
}

async function ensureDefaultGlobalTopic(): Promise<void> {
  if (aiTopics.value.length) return
  const r = await window.api.createGlobalAiTopic('默认分支')
  if (r.success && r.data?.id) {
    activeGlobalAiTopicId.value = r.data.id
    await window.api.setGlobalAiCurrentTopicId(r.data.id)
    await loadGlobalAiTopics()
  }
}

async function resolveGlobalActiveTopicSelection(): Promise<void> {
  const id = activeGlobalAiTopicId.value
  if (id != null && aiTopics.value.some((t) => t.id === id)) return
  const saved = await window.api.getGlobalAiCurrentTopicId()
  const sid = saved.success && saved.data != null && Number.isFinite(saved.data) ? saved.data : null
  if (sid != null && aiTopics.value.some((t) => t.id === sid)) {
    activeGlobalAiTopicId.value = sid
    return
  }
  activeGlobalAiTopicId.value = aiTopics.value[0]?.id ?? null
  if (activeGlobalAiTopicId.value == null) {
    await ensureDefaultGlobalTopic()
    activeGlobalAiTopicId.value = aiTopics.value[0]?.id ?? null
  }
  if (activeGlobalAiTopicId.value != null) {
    await window.api.setGlobalAiCurrentTopicId(activeGlobalAiTopicId.value)
  }
}

async function resolveActiveTopicSelection(): Promise<void> {
  const id = activeAiTopicId.value
  if (id != null && aiTopics.value.some((t) => t.id === id)) return
  activeAiTopicId.value = aiTopics.value[0]?.id ?? null
  if (activeAiTopicId.value == null) {
    await ensureDefaultAiTopic()
    activeAiTopicId.value = aiTopics.value[0]?.id ?? null
  }
}

function mapRowsToChatMessages(rows: AiMessageRow[]): ChatMessage[] {
  return rows.map((row) => {
    let chart: Record<string, unknown> | null = null
    if (row.chart_json?.trim()) {
      try {
        chart = JSON.parse(row.chart_json) as Record<string, unknown>
      } catch {
        chart = null
      }
    }
    return {
      role: row.role,
      content: row.content,
      chartSpec: chart
    }
  })
}

async function loadMessagesForActiveTopic(): Promise<void> {
  const welcome = copilotWelcomeMessage()
  if (copilotMode.value === 'global') {
    const tid = activeGlobalAiTopicId.value
    if (tid == null) {
      chatMessages.value = [welcome]
      return
    }
    const r = await window.api.listGlobalAiMessages(tid)
    if (!r.success || !r.data?.length) {
      chatMessages.value = [welcome]
      await nextTick()
      return
    }
    chatMessages.value = mapRowsToChatMessages(r.data)
    await nextTick()
    await repaintCopilotCharts()
    return
  }

  const tid = activeAiTopicId.value
  if (tid == null) {
    chatMessages.value = [welcome]
    return
  }
  const r = await window.api.listAiMessages(tid)
  if (!r.success || !r.data?.length) {
    chatMessages.value = [welcome]
    await nextTick()
    return
  }
  chatMessages.value = mapRowsToChatMessages(r.data)
  await nextTick()
  await repaintCopilotCharts()
}

async function repaintCopilotCharts(): Promise<void> {
  await nextTick()
  chatMessages.value.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.chartSpec) return
    const host = chatMessagesContainer.value?.querySelector(`[data-chat-chart="${index}"]`) ?? null
    paintCopilotChart(host, message.chartSpec, index)
  })
}

async function selectAiTopic(topicId: number): Promise<void> {
  if (copilotMode.value === 'global') {
    if (activeGlobalAiTopicId.value === topicId) return
    activeGlobalAiTopicId.value = topicId
    await window.api.setGlobalAiCurrentTopicId(topicId)
    await loadMessagesForActiveTopic()
    return
  }
  if (activeAiTopicId.value === topicId) return
  activeAiTopicId.value = topicId
  schedulePersistProjectUi()
  await loadMessagesForActiveTopic()
}

async function createAiTopicAction(): Promise<void> {
  if (copilotMode.value === 'global') {
    const r = await window.api.createGlobalAiTopic(`新分支 ${aiTopics.value.length + 1}`)
    if (!r.success || !r.data?.id) {
      ElMessage.error(r.message || '创建失败')
      return
    }
    await loadGlobalAiTopics()
    await selectAiTopic(r.data.id)
    ElMessage.success('已创建分支')
    return
  }
  const pid = currentProjectId.value
  if (pid == null) return
  const r = await window.api.createAiTopic(pid, `新分支 ${aiTopics.value.length + 1}`)
  if (!r.success || !r.data?.id) {
    ElMessage.error(r.message || '创建失败')
    return
  }
  await loadAiTopicsForProject()
  await selectAiTopic(r.data.id)
  ElMessage.success('已创建分支')
}

async function renameAiTopicAction(topic: AiTopicRow): Promise<void> {
  const res = await ElMessageBox.prompt('分支名称', '重命名', {
    confirmButtonText: '保存',
    cancelButtonText: '取消',
    inputValue: topic.title,
    inputPattern: /\S+/,
    inputErrorMessage: '名称不能为空'
  }).catch(() => null)
  if (!res) return
  if (copilotMode.value === 'global') {
    const r = await window.api.renameGlobalAiTopic(topic.id, res.value.trim())
    if (!r.success) {
      ElMessage.error(r.message || '重命名失败')
      return
    }
    await loadGlobalAiTopics()
    ElMessage.success('已更新')
    return
  }
  const r = await window.api.renameAiTopic(topic.id, res.value.trim())
  if (!r.success) {
    ElMessage.error(r.message || '重命名失败')
    return
  }
  await loadAiTopicsForProject()
  ElMessage.success('已更新')
}

async function deleteAiTopicAction(topic: AiTopicRow): Promise<void> {
  const ok = await ElMessageBox.confirm(`确定删除分支「${topic.title}」及其消息？`, '删除分支', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!ok) return
  if (copilotMode.value === 'global') {
    const r = await window.api.deleteGlobalAiTopic(topic.id)
    if (!r.success) {
      ElMessage.error(r.message || '删除失败')
      return
    }
    if (activeGlobalAiTopicId.value === topic.id) {
      activeGlobalAiTopicId.value = null
    }
    await loadGlobalAiTopics()
    if (aiTopics.value.length === 0) {
      const cr = await window.api.createGlobalAiTopic('默认分支')
      if (cr.success && cr.data?.id) {
        await loadGlobalAiTopics()
      }
    }
    await resolveGlobalActiveTopicSelection()
    await loadMessagesForActiveTopic()
    ElMessage.success('已删除')
    return
  }

  const r = await window.api.deleteAiTopic(topic.id)
  if (!r.success) {
    ElMessage.error(r.message || '删除失败')
    return
  }
  if (activeAiTopicId.value === topic.id) {
    activeAiTopicId.value = null
  }
  await loadAiTopicsForProject()
  if (aiTopics.value.length === 0 && currentProjectId.value != null) {
    const cr = await window.api.createAiTopic(currentProjectId.value, '默认分支')
    if (cr.success && cr.data?.id) {
      await loadAiTopicsForProject()
    }
  }
  await resolveActiveTopicSelection()
  await loadMessagesForActiveTopic()
  schedulePersistProjectUi()
  ElMessage.success('已删除')
}

async function ensureActiveTopicId(): Promise<number | null> {
  if (copilotMode.value === 'global') {
    if (activeGlobalAiTopicId.value != null) return activeGlobalAiTopicId.value
    await loadGlobalAiTopics()
    await resolveGlobalActiveTopicSelection()
    return activeGlobalAiTopicId.value
  }
  const pid = currentProjectId.value
  if (pid == null) return null
  if (activeAiTopicId.value != null) return activeAiTopicId.value
  await loadAiTopicsForProject()
  await resolveActiveTopicSelection()
  return activeAiTopicId.value
}

const loadProjects = async (): Promise<void> => {
  const result = await window.api.listProjects()
  if (!result.success) {
    ElMessage.error(result.message || '项目加载失败')
    return
  }
  projects.value = result.data
  if (!currentProjectId.value || !projects.value.some((project) => project.id === currentProjectId.value)) {
    currentProjectId.value = projects.value[0]?.id ?? null
  }
}

const switchProject = async (projectId: number): Promise<void> => {
  const sameProject = currentProjectId.value === projectId
  if (sameProject && shellMode.value === 'project') return

  const prev = currentProjectId.value
  if (prev !== null && !sameProject) {
    await persistCurrentProjectUiState(prev)
  }

  if (!sameProject) {
    await loadProjectUiFromDb(projectId)
    currentProjectId.value = projectId
  }

  shellMode.value = 'project'
  currentNode.value = null
  selectedContextNode.value = null
  detailDrawerVisible.value = false
  isFocusMode.value = false
  await runSearch()
  await loadProjectNotes()
  coerceTableFilterForAvailableTypes()
  await loadAllTags()
  if (copilotVisible.value && copilotMode.value === 'project') {
    await loadAiTopicsForProject()
    await resolveActiveTopicSelection()
    await loadMessagesForActiveTopic()
  }
}

const createNewProject = async (): Promise<void> => {
  const promptResult = await ElMessageBox.prompt('请输入项目名称', '新建项目', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputPattern: /\S+/,
    inputErrorMessage: '项目名称不能为空'
  }).catch(() => null)
  if (!promptResult) return

  creatingProject.value = true
  try {
    const result = await window.api.createProject(promptResult.value.trim())
    if (!result.success || !result.data) {
      ElMessage.error(result.message || '项目创建失败')
      return
    }
    await loadProjects()
    await switchProject(result.data.id)
    ElMessage.success('项目创建成功')
  } finally {
    creatingProject.value = false
  }
}

const removeProject = async (projectId: number): Promise<void> => {
  const confirmed = await ElMessageBox.confirm('删除项目会同时删除该项目下的节点和关系，是否继续？', '删除项目', {
    confirmButtonText: '删除',
    cancelButtonText: '取消',
    type: 'warning'
  }).catch(() => false)
  if (!confirmed) return

  const result = await window.api.deleteProject(projectId)
  if (!result.success) {
    ElMessage.error(result.message || '项目删除失败')
    return
  }
  await loadProjects()
  globalLinkedProjectIds.value = globalLinkedProjectIds.value.filter((id) => id !== projectId)
  await window.api.setGlobalAiLinkedProjectIds(globalLinkedProjectIds.value)
  if (currentProjectId.value != null) {
    await loadProjectUiFromDb(currentProjectId.value)
  }
  await runSearch()
  coerceTableFilterForAvailableTypes()
  ElMessage.success('项目已删除')
}

const refreshItems = async (): Promise<void> => {
  loading.value = true
  try {
    const result = await window.api.listItems(currentProjectId.value ?? undefined)
    applyRows(result)
  } finally {
    loading.value = false
  }
}

const runSearch = async (): Promise<void> => {
  searching.value = true
  try {
    const result = await window.api.listItems(currentProjectId.value ?? undefined)
    applyRows(result)
  } finally {
    searching.value = false
  }
}

function openBookshelfShell(): void {
  shellMode.value = 'bookshelf'
}

async function loadProjectNotes(): Promise<void> {
  if (currentProjectId.value == null) {
    projectNotesList.value = []
    return
  }
  const r = await window.api.listProjectNotes(currentProjectId.value)
  projectNotesList.value = r.success ? r.data ?? [] : []
}

function openNoteEditor(payload: {
  id: number | null
  notebookId: number
  projectId: number | null
  title?: string
}): void {
  noteEditorId.value = payload.id
  noteEditorNotebookId.value = payload.notebookId
  noteEditorProjectId.value = payload.projectId
  noteEditorTitleSeed.value = payload.title ?? ''
  const useSplit =
    shellMode.value === 'bookshelf' || (shellMode.value === 'project' && workspaceTab.value === 'notes')
  noteEditorVariant.value = useSplit ? 'split' : 'fullscreen'
  noteEditorOpen.value = true
}

async function onNoteEditorSaved(payload: { id: number; isNew: boolean }): Promise<void> {
  if (payload.isNew) {
    noteEditorId.value = payload.id
  }
  await runSearch()
  await loadProjectNotes()
  await bookshelfRef.value?.refreshLibrary?.()
}

function onNoteEditorClosed(): void {
  noteEditorOpen.value = false
}

function onNoteEditorExitFullscreen(): void {
  const canSplit =
    shellMode.value === 'bookshelf' || (shellMode.value === 'project' && workspaceTab.value === 'notes')
  noteEditorVariant.value = canSplit ? 'split' : 'fullscreen'
}

async function createProjectNote(): Promise<void> {
  if (currentProjectId.value == null) return
  const books = await window.api.listNotebooks()
  const nb = books[0]?.id
  if (nb == null) {
    ElMessage.warning('数据库中缺少笔记本记录')
    return
  }
  openNoteEditor({ id: null, notebookId: nb, projectId: currentProjectId.value })
}

async function openProjectNote(id: number): Promise<void> {
  if (currentProjectId.value == null) return
  const books = await window.api.listNotebooks()
  const nb = books[0]?.id
  if (nb == null) return
  openNoteEditor({ id, notebookId: nb, projectId: currentProjectId.value })
}

async function runProjectFileImport(filePath: string, title: string): Promise<void> {
  const result = await window.api.importFile(filePath, title, currentProjectId.value ?? undefined)

  if (result.mode === 'ai_text') {
    pendingAiImport.value = {
      preview: result.preview ?? '',
      path: result.filePath ?? filePath
    }
    copilotMode.value = 'project'
    copilotVisible.value = true
    await ElMessageBox.alert(
      '该文件需要结合 AI 理解结构。底部助手已打开并附带文本摘录。请描述列名、分隔规则或期望 JSON；模型给出 ```json 数组后可点击助手内的「应用 JSON 入库」。',
      'AI 辅助解析',
      { confirmButtonText: '我知道了' }
    )
    await runSearch()
    return
  }

  if (!result.success) {
    ElMessage.error(formatImportBackendMessage(result.message || '导入失败'))
    return
  }
  ElMessage.success(result.message)
  const lower = filePath.toLowerCase()
  if (/\.(csv|json)$/.test(lower)) {
    await ElMessageBox.alert(
      '导入已完成。如需进一步清洗或统计，可在右下角打开 AI 助手提问；复杂排布也可请 AI 输出新的 JSON 再入库。',
      '提示',
      { confirmButtonText: '好的' }
    )
  }
  await runSearch()
}

const startEdit = (): void => {
  isEditing.value = true
}

const cancelEdit = (): void => {
  editForm.value = currentDetailData.value ? JSON.parse(JSON.stringify(currentDetailData.value)) : {}
  isEditing.value = false
}

const saveEdit = (): void => {
  if (!currentDetailData.value) return
  Object.assign(currentDetailData.value, editForm.value)
  isEditing.value = false
  ElMessage.success('保存成功')
}

const showContextMenu = (event: MouseEvent, nodeData: Record<string, any>): void => {
  event.preventDefault()
  contextMenuVisible.value = true
  contextMenuX.value = event.clientX + 10
  contextMenuY.value = event.clientY + 10
  currentContextNode.value = nodeData
}

const closeContextMenu = (): void => {
  contextMenuVisible.value = false
}

const handleMenuDetail = (): void => {
  if (!currentContextNode.value) return
  openDetail(currentContextNode.value)
  closeContextMenu()
}

const handleMenuHide = (): void => {
  const nodeId = Number(currentContextNode.value?.id)
  if (!Number.isFinite(nodeId)) return
  hiddenNodeIds.value = new Set([...hiddenNodeIds.value, nodeId])
  if (activeNodeId.value === nodeId) activeNodeId.value = null
  closeContextMenu()
}

const handleMenuResetHidden = (): void => {
  hiddenNodeIds.value = new Set()
  closeContextMenu()
}

const openSettingsDialog = async (): Promise<void> => {
  settingsVisible.value = true
  settingsLoading.value = true
  loadStoragePath()
  try {
    const result = await window.api.getSettings()
    if (!result.success) {
      ElMessage.error(result.message || '设置加载失败')
      return
    }
    settingsForm.value = {
      ai_api_key: result.data.ai_api_key || '',
      ai_base_url: result.data.ai_base_url || '',
      ai_model_name: result.data.ai_model_name || 'gpt-4o-mini',
      ai_system_prompt: result.data.ai_system_prompt || '',
      ai_temperature: Number(result.data.ai_temperature) || 0.4,
      graph_node_size: Number(result.data.graph_node_size) || 36,
      graph_edge_length: Number(result.data.graph_edge_length) || 150,
      graph_repulsion: Number(result.data.graph_repulsion) || 650,
      app_theme: result.data.app_theme || 'light',
      app_language: result.data.app_language || 'zh-CN'
    }
  } catch (error) {
    ElMessage.error(`设置加载失败：${String(error)}`)
  } finally {
    settingsLoading.value = false
    void refreshDataDiagnostic()
  }
}

const refreshDataDiagnostic = async (): Promise<void> => {
  try {
    const paths = await window.api.getDataPaths()
    dataDiagnostic.value = paths
  } catch {
    /* 设置窗口已开但主进程不可用时忽略 */
  }
}

const openDataDirectory = async (): Promise<void> => {
  try {
    const result = await window.api.openUserDataFolder()
    if (!result.success) {
      ElMessage.error(result.message || '打开数据目录失败')
    }
  } catch (error) {
    ElMessage.error(`打开数据目录失败：${String(error)}`)
  }
}

const openLogsDirectory = async (): Promise<void> => {
  try {
    const result = await window.api.openLogsFolder()
    if (!result.success) {
      ElMessage.error(result.message || '打开日志目录失败')
    }
  } catch (error) {
    ElMessage.error(`打开日志目录失败：${String(error)}`)
  }
}

const copyDiagnosticPath = async (path: string, label: string): Promise<void> => {
  if (!path.trim()) {
    ElMessage.warning('暂无可用路径')
    return
  }
  try {
    const result = await window.api.copyText(path)
    if (!result.success) {
      ElMessage.error(result.message || '复制失败')
      return
    }
    ElMessage.success(`${label}已复制到剪贴板`)
  } catch (error) {
    ElMessage.error(`复制失败：${String(error)}`)
  }
}

const loadStoragePath = (): void => {
  storagePath.value = localStorage.getItem(STORAGE_PATH_KEY) ?? ''
}

const loadInitialData = async (): Promise<void> => {
  shellMode.value = 'bookshelf'
  await loadProjects()
  await loadGlobalLinkedProjectsFromDb()
  const pid = currentProjectId.value
  if (pid != null) {
    await loadProjectUiFromDb(pid)
  }
  await refreshItems()
  coerceTableFilterForAvailableTypes()
  await loadAllTags()
  await loadProjectNotes()
}

const initializeStorageAndLoadApp = async (selectedPath: string): Promise<boolean> => {
  const normalizedPath = selectedPath.trim()
  if (!normalizedPath) {
    ElMessage.warning('请先选择数据存储位置')
    return false
  }

  initialStorageLoading.value = true
  try {
    const result = await window.api.initializeStoragePath(normalizedPath)
    if (!result.success) {
      ElMessage.error(result.message || '存储路径初始化失败')
      return false
    }
    storagePath.value = normalizedPath
    localStorage.setItem(STORAGE_PATH_KEY, normalizedPath)
    await loadInitialData()
    appReady.value = true
    firstLaunchStorageDialogVisible.value = false
    firstLaunchPendingPath.value = ''
    return true
  } catch (error) {
    ElMessage.error(`存储路径初始化失败：${String(error)}`)
    return false
  } finally {
    initialStorageLoading.value = false
  }
}

const chooseStoragePath = async (): Promise<void> => {
  try {
    const selectedPath = await window.api.openDirectoryDialog()
    if (!selectedPath) return
    storagePath.value = selectedPath
    localStorage.setItem(STORAGE_PATH_KEY, selectedPath)
    ElMessage.success('存储路径已保存')
  } catch (error) {
    ElMessage.error(`选择文件夹失败：${String(error)}`)
  }
}

const pickFirstLaunchFolder = async (): Promise<void> => {
  try {
    const selectedPath = await window.api.openDirectoryDialog()
    if (!selectedPath) return
    firstLaunchPendingPath.value = selectedPath
  } catch (error) {
    ElMessage.error(`选择文件夹失败：${String(error)}`)
  }
}

const confirmFirstLaunchStorage = async (): Promise<void> => {
  const pending = firstLaunchPendingPath.value.trim()
  if (!pending) {
    ElMessage.warning('请先选择数据存储位置')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将在此目录创建数据库文件 datanode.db 与日志目录 logs\\（运行记录写入 datanode.log）。\n\n路径：\n${pending}\n\n提示：安装程序时选择的「程序安装位置」与此处的「数据目录」不同，请区分备份与排查时查找的路径。`,
      '确认数据目录',
      {
        confirmButtonText: '确认并开始',
        cancelButtonText: '返回修改',
        type: 'info'
      }
    )
  } catch {
    return
  }
  const initialized = await initializeStorageAndLoadApp(pending)
  if (initialized) {
    ElMessage.success('存储路径已保存')
  }
}

async function importAssetToProject(): Promise<void> {
  if (shellMode.value !== 'project' || currentProjectId.value == null) {
    ElMessage.warning('请先进入项目工作区后再导入文档')
    return
  }
  importing.value = true
  try {
    const picked = await window.api.pickImportFile()
    if (!picked.success || !picked.filePath) {
      if (picked.message) ElMessage.warning(picked.message)
      return
    }
    let title = ''
    if (!isStructuredImportPath(picked.filePath)) {
      const promptResult = await ElMessageBox.prompt('请输入该文件的标题/摘要（必填）', '导入资产文件', {
        confirmButtonText: '导入',
        cancelButtonText: '取消',
        inputPattern: /\S+/,
        inputErrorMessage: '标题/摘要不能为空'
      }).catch(() => null)
      if (!promptResult) return
      title = promptResult.value.trim()
      if (!title) return
    }
    const result = await window.api.importFile(picked.filePath, title, currentProjectId.value ?? undefined)
    if (result.mode === 'ai_text') {
      pendingAiImport.value = {
        preview: result.preview ?? '',
        path: result.filePath ?? picked.filePath
      }
      copilotMode.value = 'project'
      copilotVisible.value = true
      await ElMessageBox.alert(
        '该文件需要结合 AI 理解结构。底部助手已打开并附带文本摘录。',
        'AI 辅助解析',
        { confirmButtonText: '我知道了' }
      )
      await runSearch()
      return
    }
    if (!result.success) {
      ElMessage.error(formatImportBackendMessage(result.message || '导入失败'))
      return
    }
    ElMessage.success(result.message)
    await runSearch()
  } catch (error) {
    ElMessage.error(formatImportUiError(error))
  } finally {
    importing.value = false
  }
}

const handleFileCommand = (command: string): void => {
  if (command === 'import') {
    void importFile()
    return
  }
  if (command === 'import-asset') {
    void importAssetToProject()
    return
  }
  if (command === 'open-data-folder') {
    void openDataDirectory()
  }
}

const handleEditCommand = (command: string): void => {
  if (command === 'metadata') {
    showMetadata.value = !showMetadata.value
    return
  }
  if (command === 'clear') {
    void clearItems()
  }
}

const saveSettings = async (): Promise<void> => {
  savingSettings.value = true
  try {
    const trimmedStoragePath = storagePath.value.trim()
    if (trimmedStoragePath) {
      localStorage.setItem(STORAGE_PATH_KEY, trimmedStoragePath)
    } else {
      localStorage.removeItem(STORAGE_PATH_KEY)
    }

    const result = await window.api.saveSettings({
      ai_api_key: settingsForm.value.ai_api_key.trim(),
      ai_base_url: settingsForm.value.ai_base_url.trim(),
      ai_model_name: settingsForm.value.ai_model_name.trim(),
      ai_system_prompt: settingsForm.value.ai_system_prompt.trim(),
      ai_temperature: settingsForm.value.ai_temperature,
      graph_node_size: settingsForm.value.graph_node_size,
      graph_edge_length: settingsForm.value.graph_edge_length,
      graph_repulsion: settingsForm.value.graph_repulsion,
      app_theme: settingsForm.value.app_theme,
      app_language: settingsForm.value.app_language
    })
    if (!result.success) {
      ElMessage.error(result.message || '设置保存失败')
      return
    }
    settingsForm.value = {
      ai_api_key: result.data.ai_api_key || '',
      ai_base_url: result.data.ai_base_url || '',
      ai_model_name: result.data.ai_model_name || 'gpt-4o-mini',
      ai_system_prompt: result.data.ai_system_prompt || '',
      ai_temperature: Number(result.data.ai_temperature) || settingsForm.value.ai_temperature,
      graph_node_size: Number(result.data.graph_node_size) || settingsForm.value.graph_node_size,
      graph_edge_length: Number(result.data.graph_edge_length) || settingsForm.value.graph_edge_length,
      graph_repulsion: Number(result.data.graph_repulsion) || settingsForm.value.graph_repulsion,
      app_theme: result.data.app_theme || 'light',
      app_language: result.data.app_language || 'zh-CN'
    }
    settingsVisible.value = false
    ElMessage.success('保存成功')
  } catch (error) {
    ElMessage.error(`设置保存失败：${String(error)}`)
  } finally {
    savingSettings.value = false
  }
}

async function pickLocalFileAndImport(): Promise<void> {
  importChoiceDialogVisible.value = false
  importing.value = true
  try {
    const picked = await window.api.pickImportFile()
    if (!picked.success || !picked.filePath) {
      if (picked.message) ElMessage.warning(picked.message)
      return
    }
    let title = ''
    if (!isStructuredImportPath(picked.filePath)) {
      const promptResult = await ElMessageBox.prompt('请输入该文件的标题/摘要（必填）', '导入资产文件', {
        confirmButtonText: '导入',
        cancelButtonText: '取消',
        inputPattern: /\S+/,
        inputErrorMessage: '标题/摘要不能为空'
      }).catch(() => null)
      if (!promptResult) return
      title = promptResult.value.trim()
      if (!title) return
    }
    await runProjectFileImport(picked.filePath, title)
  } catch (error) {
    ElMessage.error(formatImportUiError(error))
  } finally {
    importing.value = false
  }
}

async function openBookshelfImportPickerForProject(): Promise<void> {
  importChoiceDialogVisible.value = false
  const r = await window.api.listBookshelfImportCandidates()
  bookshelfImportCandidates.value = r.success ? r.data ?? [] : []
  if (!bookshelfImportCandidates.value.length) {
    ElMessage.info('书柜中暂无可导入的结构化表格文件（Excel / CSV / JSON）')
    return
  }
  bookshelfPickForImportVisible.value = true
}

async function confirmImportFromBookshelfItem(row: ItemRow): Promise<void> {
  const path = row.source_file_path?.trim()
  if (!path) return
  bookshelfPickForImportVisible.value = false
  importing.value = true
  try {
    await runProjectFileImport(path, '')
  } catch (error) {
    ElMessage.error(formatImportUiError(error))
  } finally {
    importing.value = false
  }
}

const importFile = async (): Promise<void> => {
  if (shellMode.value !== 'project' || currentProjectId.value == null) {
    ElMessage.warning('请先点击左侧项目进入项目工作区，再导入数据')
    return
  }
  importChoiceDialogVisible.value = true
}

const clearItems = async (): Promise<void> => {
  try {
    const result = await window.api.clearItems(currentProjectId.value ?? undefined)
    if (!result.success) {
      ElMessage.warning(result.message)
      return
    }
    ElMessage.success(result.message)
    await runSearch()
  } catch (error) {
    ElMessage.error(`清空失败：${String(error)}`)
  }
}

const getNodeColorByType = (type: ItemRow['type']): string => {
  if (type === 'excel_row') return '#3b82f6'
  if (type === 'note') return '#67C23A'
  if (type === 'file') return '#f59e0b'
  return '#a855f7'
}

const nodeMatchesKeyword = (node: GraphNode, keyword: string): boolean => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return true
  const nameHit = (node.name || '').toLowerCase().includes(normalizedKeyword)
  const tagHit = (node.tags || []).some((tag) => (tag.name || '').toLowerCase().includes(normalizedKeyword))
  return nameHit || tagHit
}

const updateGraphHighlight = (keyword: string): void => {
  if (!graphInstance.value) return

  const normalizedKeyword = keyword.trim().toLowerCase()
  const displayNodes = filteredGraphData.value.nodes
  const displayEdges = filteredGraphData.value.relationships
  const nodeMatchMap = new Map<number, boolean>()
  displayNodes.forEach((node) => {
    nodeMatchMap.set(node.id, nodeMatchesKeyword(node, normalizedKeyword))
  })
  const selectedNodeId = activeNodeId.value
  const selectedRelatedNodeIds = new Set<number>()
  if (selectedNodeId) {
    selectedRelatedNodeIds.add(selectedNodeId)
    displayEdges.forEach((edge) => {
      if (edge.source === selectedNodeId) selectedRelatedNodeIds.add(edge.target)
      if (edge.target === selectedNodeId) selectedRelatedNodeIds.add(edge.source)
    })
  }

  const highlightedNodes = displayNodes.map((node) => {
    const keywordMatched = normalizedKeyword ? Boolean(nodeMatchMap.get(node.id)) : true
    const selectedMatched = selectedNodeId ? selectedRelatedNodeIds.has(node.id) : true
    const matched = keywordMatched && selectedMatched
    const isSelected = selectedNodeId === node.id
    return {
      id: String(node.id),
      name: node.name || `Node #${node.id}`,
      type: node.type,
      tags: node.tags ?? [],
      x: node.x ?? undefined,
      y: node.y ?? undefined,
      fixed: typeof node.x === 'number' && typeof node.y === 'number',
      symbolSize: (node.type === 'note' ? 40 : node.type === 'excel_row' ? 30 : node.type === 'file' ? 36 : 34) + (isSelected ? 14 : 0),
      itemStyle: {
        color: getNodeColorByType(node.type),
        opacity: matched ? 1 : 0.12,
        borderWidth: isSelected ? 5 : matched && normalizedKeyword ? 2 : 0,
        borderColor: isSelected ? '#409EFF' : matched && normalizedKeyword ? '#ffeb3b' : 'transparent',
        shadowBlur: isSelected ? 18 : 0,
        shadowColor: isSelected ? 'rgba(64, 158, 255, 0.45)' : 'transparent'
      }
    }
  })

  const highlightedLinks = displayEdges.map((edge) => {
    const sourceMatched = nodeMatchMap.get(edge.source) ?? true
    const targetMatched = nodeMatchMap.get(edge.target) ?? true
    const selectedEdgeMatched = selectedNodeId ? edge.source === selectedNodeId || edge.target === selectedNodeId : true
    const dimmed = (normalizedKeyword ? !(sourceMatched && targetMatched) : false) || !selectedEdgeMatched
    return {
      id: String(edge.id),
      source: String(edge.source),
      target: String(edge.target),
      value: edge.label || '',
      label: edge.label || '',
      lineStyle: {
        opacity: dimmed ? 0.08 : 0.95,
        width: selectedEdgeMatched && selectedNodeId ? 2.4 : 1.5
      }
    }
  })

  // 仅局部更新 data / links，避免重新布局导致节点“乱飞”
  graphInstance.value.setOption({
    series: [
      {
        data: highlightedNodes,
        links: highlightedLinks
      }
    ]
  })

  if (selectedNodeId) {
    const dataIndex = displayNodes.findIndex((node) => node.id === selectedNodeId)
    if (dataIndex >= 0) {
      graphInstance.value.dispatchAction({ type: 'downplay', seriesIndex: 0 })
      graphInstance.value.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex })
      graphInstance.value.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex })
    }
  } else {
    graphInstance.value.dispatchAction({ type: 'downplay', seriesIndex: 0 })
  }
}

function cloneGraphPayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T
}

const applyGraphData = async (nodes: GraphNode[], edges: GraphEdge[], renderWhenReady: boolean): Promise<void> => {
  const safeNodes = cloneGraphPayload(nodes ?? [])
  const safeEdges = cloneGraphPayload(edges ?? [])
  graphNodes.value = safeNodes
  graphEdges.value = safeEdges
  nodeTagsMap.value = Object.fromEntries(
    safeNodes.map((node) => [node.id, node.tags ?? []])
  ) as Record<number, Array<{ id: number; name: string; color: string }>>

  if (currentNode.value) {
    const refreshed = graphNodes.value.find((node) => node.id === currentNode.value?.id)
    if (refreshed) {
      currentNode.value = { ...currentNode.value, ...refreshed }
    }
  }

  if (!renderWhenReady || !isGraphOpen.value) return
  await initGraph(safeNodes, safeEdges)
}

const loadGraphData = async (renderWhenReady = true): Promise<void> => {
  const result = await window.api.getGraphData({
    types: [...graphTypeFilters.value],
    tags: [...graphTagFilters.value],
    projectId: currentProjectId.value ?? undefined
  })
  if (!result.success) {
    throw new Error(result.message ?? '图谱数据加载失败')
  }

  isFocusMode.value = false
  focusNodeName.value = ''
  await applyGraphData(result.data.nodes ?? [], result.data.edges ?? [], renderWhenReady)
}

const loadAllTags = async (): Promise<void> => {
  try {
    const result = await window.api.getAllTags({
      projectId: currentProjectId.value ?? undefined
    })
    allTags.value = result.success ? cloneGraphPayload(result.data) : []
  } catch {
    allTags.value = []
  }
}

const initGraph = async (nodes: GraphNode[], edges: GraphEdge[]): Promise<void> => {
  await nextTick()
  if (!graphContainer.value) return

  if (!graphInstance.value) {
    graphInstance.value = markRaw(echarts.init(graphContainer.value))
  }
  graphInstance.value.off('click')
  graphInstance.value.off('contextmenu')

  graphInstance.value.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        if (params.dataType !== 'node') return params.data?.label ?? ''
        const data = params.data as { name?: string; type?: string; tags?: GraphNode['tags'] }
        const fullName = data?.name ?? '未命名节点'
        const tagText = (data.tags ?? []).map((tag) => tag.name).join(', ') || '无'
        return `名称：${fullName}<br/>类型：${data?.type ?? 'unknown'}<br/>标签：${tagText}`
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
        force: {
          repulsion: 650,
          edgeLength: [100, 150]
        },
        label: {
          show: true,
          position: 'bottom',
          fontSize: 12,
          color: '#555',
          formatter: (params: { data?: { name?: string } }) => {
            const raw = params?.data?.name ?? ''
            return raw.length > 12 ? `${raw.slice(0, 12)}...` : raw
          }
        },
        edgeLabel: {
          show: true,
          formatter: (params: { data?: { label?: string } }) => params.data?.label || '',
          color: '#64748b',
          fontSize: 10
        },
        lineStyle: {
          color: '#94a3b8',
          width: 1.5,
          opacity: 0.85,
          curveness: 0.2
        },
        data: nodes.map((node) => ({
          id: String(node.id),
          name: node.name || `Node #${node.id}`,
          type: node.type,
          tags: node.tags ?? [],
          x: node.x ?? undefined,
          y: node.y ?? undefined,
          fixed: typeof node.x === 'number' && typeof node.y === 'number',
          symbolSize: node.type === 'note' ? 40 : node.type === 'excel_row' ? 30 : node.type === 'file' ? 36 : 34,
          itemStyle: {
            color: getNodeColorByType(node.type)
          }
        })),
        links: edges.map((edge) => ({
          id: String(edge.id),
          source: String(edge.source),
          target: String(edge.target),
          value: edge.label || '',
          label: edge.label || '',
          lineStyle: {
            opacity: 0.85
          }
        }))
      }
    ]
  })
  updateGraphHighlight(searchKeyword.value)

  graphInstance.value.on('click', (params: any) => {
    if (params?.dataType !== 'node') return
    const nodeId = Number(params?.data?.id)
    if (!nodeId) return
    handleNodeClick(nodeId)
  })

  graphInstance.value.on('contextmenu', { dataType: 'node' }, (params: any) => {
    const nativeEvent = params?.event?.event as MouseEvent | undefined
    if (!nativeEvent) return
    showContextMenu(nativeEvent, params.data as Record<string, any>)
  })
}

const resizeGraph = (): void => {
  graphInstance.value?.resize()
}

const openDetail = (data: Record<string, unknown>): void => {
  currentDetailData.value = data
  detailDrawerVisible.value = true
  const nodeId = Number(data.id)
  if (nodeId) void openNodeDetail(nodeId, false)
}

const handleRowClick = (row: FlattenedItemRow): void => {
  const nodeId = Number(row.id)
  if (!nodeId) return

  if (!isGraphOpen.value) {
    openDetail(row)
  } else if (activeNodeId.value === nodeId) {
    openDetail(row)
  } else {
    activeNodeId.value = nodeId
    selectedContextNode.value = {
      id: nodeId,
      title: summarizeContent(row) || `Node #${nodeId}`
    }
  }
}

const handleTableRowClick = (row: FlattenedItemRow): void => {
  handleRowClick(row)
}

const handleNodeClick = (nodeId: number): void => {
  const graphNode = graphNodes.value.find((node) => node.id === nodeId)
  if (activeNodeId.value === nodeId) {
    openDetail({
      id: nodeId,
      type: graphNode?.type,
      name: graphNode?.name,
      内容摘要: graphNode?.name
    })
    return
  }
  activeNodeId.value = nodeId
  selectedContextNode.value = {
    id: nodeId,
    title: graphNode?.name || `Node #${nodeId}`
  }
}

const openNodeDetail = async (nodeId: number, showDrawer = true): Promise<void> => {
  try {
    const result = await window.api.getNodeDetail(nodeId)
    if (!result.success || !result.data) {
      ElMessage.error(result.message || '节点详情加载失败')
      return
    }
    const graphNode = graphNodes.value.find((node) => node.id === nodeId)
    currentNode.value = {
      id: result.data.id,
      name: result.data.title || result.data.content_text || graphNode?.name || `Node #${result.data.id}`,
      type: result.data.type,
      tags: result.data.tags ?? [],
      x: graphNode?.x ?? null,
      y: graphNode?.y ?? null,
      title: result.data.title,
      content_text: result.data.content_text,
      content_json: result.data.content_json,
      source_file_path: result.data.source_file_path,
      created_at: result.data.created_at
    }
    currentDetailData.value = {
      ...result.data,
      id: result.data.id,
      type: result.data.type,
      name: currentNode.value.name,
      内容摘要: currentNode.value.name
    }
    selectedContextNode.value = {
      id: result.data.id,
      title: currentNode.value.name || `Node #${result.data.id}`
    }
    drawerTitle.value = result.data.title || ''
    drawerContent.value = result.data.content_text || ''
    drawerTagsInput.value = (result.data.tags ?? []).map((tag) => tag.name).join(', ')
    relationTargetId.value = null
    relationLabel.value = ''
    if (showDrawer) detailDrawerVisible.value = true
    await refreshNodeRelations(nodeId)
    await searchRelationTargets('', nodeId)
  } catch (error) {
    ElMessage.error(`节点详情加载失败：${String(error)}`)
  }
}

const refreshNodeRelations = async (nodeId = currentNode.value?.id): Promise<void> => {
  if (!nodeId) return
  try {
    const result = await window.api.getNodeEdges(nodeId)
    if (!result.success) {
      ElMessage.error(result.message || '关联列表加载失败')
      return
    }
    nodeRelations.value = result.data
  } catch (error) {
    ElMessage.error(`关联列表加载失败：${String(error)}`)
  }
}

const searchRelationTargets = async (keyword: string, excludeId = currentNode.value?.id): Promise<void> => {
  relationSearchLoading.value = true
  try {
    const result = await window.api.searchNodes(keyword, excludeId, currentProjectId.value ?? undefined)
    if (!result.success) {
      relationOptions.value = []
      return
    }
    relationOptions.value = result.data
  } catch {
    relationOptions.value = []
  } finally {
    relationSearchLoading.value = false
  }
}

const parseCurrentNodeJson = computed(() => parseJsonSafely(currentNode.value?.content_json || ''))

// @ts-ignore - 预留给文件节点详情元数据展示
const currentNodeJsonEntries = computed(() => Object.entries(parseCurrentNodeJson.value))

const currentNodeFilePath = computed(() => {
  const parsed = parseCurrentNodeJson.value
  return String(parsed.filePath || currentNode.value?.source_file_path || '')
})

// @ts-ignore - 预留给文件节点图片预览
const isImageNode = computed(() => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(currentNodeFilePath.value))

// @ts-ignore - 预留给文件节点预览
const filePreviewUrl = computed(() => {
  if (!currentNodeFilePath.value) return ''
  return `file:///${currentNodeFilePath.value.replace(/\\/g, '/').replace(/^\/+/, '')}`
})

// @ts-ignore - 预留给节点详情正文编辑
const canEditText = computed(() => currentNode.value?.type === 'note' || currentNode.value?.type === 'document')

// @ts-ignore - 预留给节点详情持久化保存
const saveNodeDetail = async (): Promise<void> => {
  if (!currentNode.value) return
  const tags = drawerTagsInput.value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)

  savingNodeDetail.value = true
  try {
    const result = await window.api.updateNodeDetail({
      id: currentNode.value.id,
      title: drawerTitle.value,
      contentText: drawerContent.value,
      tags
    })
    if (!result.success) {
      ElMessage.error(result.message || '保存失败')
      return
    }
    ElMessage.success('节点已保存')
    await runSearch()
    await loadGraphData(true)
    await openNodeDetail(currentNode.value.id)
  } catch (error) {
    ElMessage.error(`保存失败：${String(error)}`)
  } finally {
    savingNodeDetail.value = false
  }
}

// @ts-ignore - 预留给文件节点打开操作
const openCurrentFile = async (): Promise<void> => {
  const filePath = currentNodeFilePath.value
  if (!filePath) {
    ElMessage.warning('没有可打开的文件路径')
    return
  }
  try {
    const result = await window.api.openFile(filePath)
    if (!result.success) {
      ElMessage.error(result.message || '打开文件失败')
      return
    }
  } catch (error) {
    ElMessage.error(`打开文件失败：${String(error)}`)
  }
}

// @ts-ignore - 预留给节点标签编辑
const addTag = async (): Promise<void> => {
  if (!currentNode.value) return
  const name = newTagName.value.trim()
  if (!name) {
    ElMessage.warning('请输入标签名称')
    return
  }
  try {
    const result = await window.api.addTagToNode(currentNode.value.id, name, newTagColor.value)
    if (!result.success) {
      ElMessage.error(result.message || '添加标签失败')
      return
    }
    ElMessage.success('标签添加成功')
    newTagName.value = ''
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`添加标签失败：${String(error)}`)
  }
}

// @ts-ignore - 预留给节点标签编辑
const removeTag = async (tagId: number): Promise<void> => {
  if (!currentNode.value) return
  try {
    const result = await window.api.removeTagFromNode(currentNode.value.id, tagId)
    if (!result.success) {
      ElMessage.error(result.message || '删除标签失败')
      return
    }
    ElMessage.success('标签删除成功')
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`删除标签失败：${String(error)}`)
  }
}

// @ts-ignore - 预留给节点关系编辑
const addRelation = async (): Promise<void> => {
  if (!currentNode.value) return
  if (!relationTargetId.value) {
    ElMessage.warning('请选择目标节点')
    return
  }
  try {
    const result = await window.api.addRelation(
      currentNode.value.id,
      relationTargetId.value,
      relationLabel.value.trim()
    )
    if (!result.success) {
      ElMessage.error(result.message || '添加关系失败')
      return
    }
    ElMessage.success('关系添加成功')
    relationTargetId.value = null
    relationLabel.value = ''
    await refreshNodeRelations()
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`添加关系失败：${String(error)}`)
  }
}

// @ts-ignore - 预留给节点关系编辑
const removeRelation = async (relationId: number): Promise<void> => {
  try {
    const result = await window.api.removeRelation(relationId)
    if (!result.success) {
      ElMessage.error(result.message || '删除关系失败')
      return
    }
    ElMessage.success('关系删除成功')
    await refreshNodeRelations()
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`删除关系失败：${String(error)}`)
  }
}

// @ts-ignore - 预留给关系列表展示
const formatRelationText = (edge: NodeEdge): string => {
  const arrow = edge.direction === 'outgoing' ? '→' : '←'
  return `[${edge.label || '关联'}] ${arrow} ${edge.otherNodeName}`
}

const scrollChatToBottom = async (): Promise<void> => {
  await nextTick()
  if (!chatMessagesContainer.value) return
  chatMessagesContainer.value.scrollTop = chatMessagesContainer.value.scrollHeight
}

const copilotChatCharts = new Map<number, echarts.ECharts>()

function disposeCopilotCharts(): void {
  copilotChatCharts.forEach((c) => c.dispose())
  copilotChatCharts.clear()
}

function openProjectCopilot(): void {
  copilotMode.value = 'project'
  copilotTopicsCollapsed.value = false
  copilotVisible.value = true
}

function openGlobalCopilot(): void {
  copilotMode.value = 'global'
  copilotTopicsCollapsed.value = false
  globalLinkedFlyoutOpen.value = false
  copilotVisible.value = true
}

watch(copilotVisible, async (v) => {
  if (!v) {
    disposeCopilotCharts()
    pendingAiImport.value = null
    globalLinkedFlyoutOpen.value = false
    if (currentProjectId.value != null) {
      await persistCurrentProjectUiState(currentProjectId.value)
    }
    copilotMaximized.value = false
    return
  }
  copilotTopicsCollapsed.value = false
  if (pendingAiImport.value) {
    copilotMode.value = 'project'
  }
  if (copilotMode.value === 'global') {
    await loadGlobalAiTopics()
    const saved = await window.api.getGlobalAiCurrentTopicId()
    if (saved.success && saved.data != null && Number.isFinite(saved.data)) {
      activeGlobalAiTopicId.value = saved.data
    }
    await resolveGlobalActiveTopicSelection()
    await loadMessagesForActiveTopic()
    return
  }
  await loadAiTopicsForProject()
  await resolveActiveTopicSelection()
  if (pendingAiImport.value) {
    const intro = `已载入文本（${pendingAiImport.value.path}）。请说明如何结构化，或让我直接输出可写入数据库的 JSON 对象数组。`
    const tid = await ensureActiveTopicId()
    if (tid != null) {
      await window.api.appendAiMessage(tid, 'assistant', intro)
    }
    chatMessages.value = [{ role: 'assistant', content: intro }]
    await nextTick()
    await scrollChatToBottom()
    return
  }
  await loadMessagesForActiveTopic()
})

watch([currentTableFilter, searchKeyword], () => {
  schedulePersistProjectUi()
})

function splitChartFromAnswer(answer: string): { text: string; chart: Record<string, unknown> | null } {
  const lines = answer.split('\n')
  const kept: string[] = []
  let chart: Record<string, unknown> | null = null
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('CHART_JSON:')) {
      try {
        chart = JSON.parse(t.slice('CHART_JSON:'.length).trim()) as Record<string, unknown>
      } catch {
        kept.push(line)
      }
    } else {
      kept.push(line)
    }
  }
  return { text: kept.join('\n').trim(), chart }
}

function paintCopilotChart(
  el: Element | null,
  spec: Record<string, unknown> | null | undefined,
  index: number
): void {
  if (!el || !spec) return
  copilotChatCharts.get(index)?.dispose()
  const chart = echarts.init(el as HTMLDivElement)
  copilotChatCharts.set(index, chart)
  const type = String(spec.type ?? 'bar')
  const title = String(spec.title ?? '')
  const categories = (spec.categories as string[] | undefined) ?? (spec.names as string[] | undefined)
  const values = spec.values as number[] | undefined
  if (type === 'pie' && categories && values && categories.length === values.length) {
    chart.setOption({
      title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'item' },
      series: [{ type: 'pie', radius: '55%', data: categories.map((n, i) => ({ name: n, value: values[i]! })) }]
    })
  } else if (categories && values) {
    chart.setOption({
      title: { text: title, textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: categories, axisLabel: { rotate: 24 } },
      yAxis: { type: 'value' },
      series: [{ type: type === 'line' ? 'line' : 'bar', data: values }]
    })
  }
  void nextTick(() => chart.resize())
}

async function applyAiJsonFromChat(): Promise<void> {
  if (copilotMode.value === 'global') {
    ElMessage.warning('JSON 入库需在「项目 AI」中进行，请使用右下角项目助手')
    return
  }
  const lastAssistant = [...chatMessages.value].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant?.content) {
    ElMessage.warning('暂无助手回复可解析')
    return
  }
  const m = lastAssistant.content.match(/```json\s*([\s\S]*?)\s*```/)
  if (!m?.[1]) {
    ElMessage.warning('请让 AI 使用 markdown 代码块输出 ```json ... ``` 对象数组')
    return
  }
  try {
    const data = JSON.parse(m[1].trim()) as unknown
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : null
    if (!rows?.length || rows.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) {
      ElMessage.warning('JSON 须为非空对象数组')
      return
    }
    const res = await window.api.importStructuredJson({
      projectId: currentProjectId.value ?? undefined,
      rows,
      sourceFilePath: pendingAiImport.value?.path ?? 'ai-chat.json'
    })
    if (!res.success) {
      ElMessage.error(res.message || '入库失败')
      return
    }
    ElMessage.success(res.message)
    pendingAiImport.value = null
    await runSearch()
  } catch {
    ElMessage.error('JSON 解析失败')
  }
}

const sendChatMessage = async (): Promise<void> => {
  const content = chatInput.value.trim()
  if (!content || chatSending.value) return
  if (copilotMode.value === 'project' && currentProjectId.value == null) {
    ElMessage.warning('请先选择或创建项目')
    return
  }
  const topicId = await ensureActiveTopicId()
  if (topicId == null) {
    ElMessage.warning('无法定位当前分支，请重试')
    return
  }

  chatInput.value = ''
  const userSave =
    copilotMode.value === 'global'
      ? await window.api.appendGlobalAiMessage(topicId, 'user', content)
      : await window.api.appendAiMessage(topicId, 'user', content)
  if (!userSave.success) {
    ElMessage.error(userSave.message || '保存用户消息失败')
    return
  }
  chatMessages.value.push({ role: 'user', content })
  await scrollChatToBottom()

  chatSending.value = true
  try {
    const result = await window.api.chatWithAi({
      messages: messagesPayloadForApi(),
      context_node_id: copilotMode.value === 'global' ? null : selectedContextNode.value?.id ?? null,
      project_id: copilotMode.value === 'global' ? null : currentProjectId.value,
      global_ai: copilotMode.value === 'global',
      linked_project_ids: copilotMode.value === 'global' ? [...globalLinkedProjectIds.value] : undefined,
      raw_file_preview: copilotMode.value === 'global' ? undefined : pendingAiImport.value?.preview,
      raw_file_path: copilotMode.value === 'global' ? undefined : pendingAiImport.value?.path
    })
    if (!result.success) {
      ElMessage.error(result.message || 'AI 对话失败')
      return
    }
    const { text, chart } = splitChartFromAnswer(result.data.answer)
    const chartJson = chart ? JSON.stringify(chart) : null
    const asstSave =
      copilotMode.value === 'global'
        ? await window.api.appendGlobalAiMessage(topicId, 'assistant', text, chartJson)
        : await window.api.appendAiMessage(topicId, 'assistant', text, chartJson)
    if (!asstSave.success) {
      console.warn(asstSave.message)
    }
    chatMessages.value.push({ role: 'assistant', content: text, chartSpec: chart })
    const idx = chatMessages.value.length - 1
    await scrollChatToBottom()
    await nextTick()
    if (chart) {
      const host = chatMessagesContainer.value?.querySelector(`[data-chat-chart="${idx}"]`) ?? null
      paintCopilotChart(host, chart, idx)
    }
  } catch (error) {
    ElMessage.error(`AI 对话失败：${String(error)}`)
  } finally {
    chatSending.value = false
  }
}

watch(workspaceTab, async (tab) => {
  if (tab === 'dashboard') {
    await nextTick()
    dashboardRef.value?.resizeChart()
  }
  schedulePersistProjectUi()
})

watch(filteredGraphData, () => {
  if (graphSearchDebounceTimer) clearTimeout(graphSearchDebounceTimer)
  graphSearchDebounceTimer = setTimeout(() => {
    updateGraphHighlight(searchKeyword.value)
  }, 180)
})

watch(activeNodeId, () => {
  if (!isGraphOpen.value) return
  updateGraphHighlight(searchKeyword.value)
})

watch(currentDetailData, (newData) => {
  if (!newData) {
    editForm.value = {}
    return
  }
  const clonedData = JSON.parse(JSON.stringify(newData)) as Record<string, any>
  editForm.value = {
    ...clonedData,
    name: clonedData.name || clonedData.title || clonedData.内容摘要 || '',
    content: clonedData.content || clonedData.content_text || clonedData.内容摘要 || ''
  }
  isEditing.value = false
  activeDrawerTab.value = 'info'
})

watch([graphTypeFilters, graphTagFilters], async () => {
  if (!isGraphOpen.value || isFocusMode.value) return
  await loadGraphData(true)
}, { deep: true })

onMounted(async () => {
  loadStoragePath()
  window.addEventListener('resize', resizeGraph)
  window.addEventListener('click', closeContextMenu)
  if (!storagePath.value.trim()) {
    firstLaunchStorageDialogVisible.value = true
    return
  }
  const initialized = await initializeStorageAndLoadApp(storagePath.value)
  if (!initialized) {
    localStorage.removeItem(STORAGE_PATH_KEY)
    storagePath.value = ''
    firstLaunchStorageDialogVisible.value = true
  }
})

onBeforeUnmount(() => {
  if (graphSearchDebounceTimer) clearTimeout(graphSearchDebounceTimer)
  if (projectUiPersistTimer) clearTimeout(projectUiPersistTimer)
  if (currentProjectId.value != null) {
    void persistCurrentProjectUiState(currentProjectId.value)
  }
  window.removeEventListener('resize', resizeGraph)
  graphInstance.value?.dispose()
  graphInstance.value = null
})

onUnmounted(() => {
  window.removeEventListener('click', closeContextMenu)
})
</script>

<template>
  <el-container v-if="appReady" class="app-wrapper">
    <el-aside :width="sidebarCollapsed ? '64px' : '240px'" class="project-sidebar">
      <div class="sidebar-top">
        <el-button circle text :icon="sidebarCollapsed ? Expand : Fold" @click="sidebarCollapsed = !sidebarCollapsed" />
        <span v-if="!sidebarCollapsed" class="sidebar-title">Projects</span>
      </div>

      <el-button
        class="bookshelf-sidebar-btn"
        :class="{ 'is-collapsed': sidebarCollapsed }"
        :icon="Reading"
        @click="openBookshelfShell"
      >
        <span v-if="!sidebarCollapsed">书柜</span>
      </el-button>

      <el-button
        class="new-project-button"
        :class="{ 'is-collapsed': sidebarCollapsed }"
        :icon="Plus"
        :loading="creatingProject"
        @click="createNewProject"
      >
        <span v-if="!sidebarCollapsed">新建项目</span>
      </el-button>

      <div class="project-list">
        <button
          v-for="project in projects"
          :key="project.id"
          class="project-item"
          :class="{ active: project.id === currentProjectId, collapsed: sidebarCollapsed }"
          @click="switchProject(project.id)"
        >
          <span class="project-avatar">{{ project.name.slice(0, 1).toUpperCase() }}</span>
          <span v-if="!sidebarCollapsed" class="project-name">{{ project.name }}</span>
          <el-dropdown v-if="!sidebarCollapsed" trigger="click" @command="removeProject(project.id)">
            <el-button text circle :icon="MoreFilled" @click.stop />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delete" :icon="Delete">删除项目</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </button>
      </div>
    </el-aside>

    <el-container direction="vertical" class="main-right-wrapper">
    <el-header height="56px" class="global-header">
      <div class="header-left">
        <div class="brand-mark">DN</div>
        <div class="brand-copy">
          <h1>DataNode</h1>
          <p>
            {{
              shellMode === 'bookshelf'
                ? '书柜 · 知识中心'
                : currentProject?.name || '项目工作区'
            }}
          </p>
        </div>

        <div class="desktop-menu">
          <el-dropdown trigger="click" @command="handleFileCommand">
            <el-button text class="menu-button">文件</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="import" :icon="Upload">导入表格数据（Excel · CSV · JSON）</el-dropdown-item>
                <el-dropdown-item command="import-asset" :icon="FolderOpened">导入文档 / 文件</el-dropdown-item>
                <el-dropdown-item command="open-data-folder" :icon="FolderOpened">打开数据文件夹</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-dropdown trigger="click" @command="handleEditCommand">
            <el-button text class="menu-button">编辑</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="metadata" :icon="showMetadata ? Hide : View">
                  {{ showMetadata ? '隐藏属性列' : '显示属性列' }}
                </el-dropdown-item>
                <el-dropdown-item command="clear" :icon="Refresh">清空测试数据</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button text class="menu-button" @click="openGlobalCopilot">全局 AI</el-button>
          <el-button text class="menu-button" @click="openSettingsDialog">⚙️ 设置</el-button>
        </div>
      </div>

      <div class="header-right">
        <el-input
          v-model="searchKeyword"
          class="global-search"
          placeholder="搜索知识库..."
          clearable
          :prefix-icon="Search"
          @keyup.enter="runSearch"
        />

        <el-tooltip content="执行搜索" placement="bottom">
          <el-button circle :icon="Search" :loading="searching" @click="runSearch" />
        </el-tooltip>

        <el-popover placement="bottom-end" width="280" trigger="click">
          <template #reference>
            <span>
              <el-tooltip content="资源类型过滤" placement="bottom">
                <el-button circle :icon="Filter" />
              </el-tooltip>
            </span>
          </template>
          <div class="popover-panel">
            <div class="popover-title">表格过滤</div>
            <el-radio-group v-model="currentTableFilter" size="small" class="filter-group">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button v-for="type in availableTypes" :key="type" :value="type">
                {{ type }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </el-popover>

        <el-tooltip :content="showMetadata ? '隐藏属性列' : '显示属性列'" placement="bottom">
          <el-button circle :icon="showMetadata ? Hide : View" @click="showMetadata = !showMetadata" />
        </el-tooltip>

        <el-tooltip content="刷新" placement="bottom">
          <el-button circle :icon="Refresh" :loading="loading" @click="refreshItems" />
        </el-tooltip>

      </div>
    </el-header>

    <el-main class="content-area">
      <div v-if="shellMode === 'bookshelf'" class="bookshelf-host">
        <BookshelfView
          ref="bookshelfRef"
          class="bookshelf-pane"
          :class="{ 'bookshelf-pane--with-editor': noteEditorOpen && noteEditorVariant === 'split' }"
          @new-note="
            openNoteEditor({ id: null, notebookId: $event.notebookId, projectId: null, title: '' })
          "
          @edit-note="
            openNoteEditor({ id: $event.id, notebookId: $event.notebookId, projectId: null, title: '' })
          "
          @open-node-detail="openNodeDetail($event, true)"
        />
      </div>
      <el-tabs v-else v-model="workspaceTab" class="workspace-main-tabs" type="border-card">
        <el-tab-pane label="统计与洞察" name="dashboard">
          <DashboardView
            ref="dashboardRef"
            :project-id="currentProjectId"
            :saved-dashboard="savedDashboardState"
            :saved-chart-configurations="chartConfigurationsState"
            @refresh="refreshItems"
            @dashboard-persist="onDashboardPersist"
          />
        </el-tab-pane>
        <el-tab-pane label="原始数据" name="raw">
          <div class="table-pane-inner">
            <RawDataView
              :rows="filteredTableData"
              :loading="loading"
              :show-metadata="showMetadata"
              :dynamic-columns="dynamicColumns"
              :current-table-filter="currentTableFilter"
              :node-tags-map="nodeTagsMap"
              :summarize-content="summarizeContent"
              @row-click="handleTableRowClick"
            />
          </div>
        </el-tab-pane>
        <el-tab-pane label="项目笔记" name="notes">
          <div class="project-notes-pane">
            <div class="project-notes-toolbar">
              <el-button type="primary" :icon="Plus" @click="createProjectNote">新建项目笔记</el-button>
              <el-button text :icon="Refresh" @click="loadProjectNotes">刷新列表</el-button>
            </div>
            <div class="project-notes-grid">
              <el-card
                v-for="n in projectNotesList"
                :key="n.id"
                class="project-note-card"
                shadow="hover"
                @click="openProjectNote(n.id)"
              >
                <div class="pn-title">{{ n.title?.trim() || `笔记 #${n.id}` }}</div>
                <div class="pn-meta">{{ n.created_at?.slice(0, 16) }}</div>
                <p class="pn-snippet">{{ (n.content_text || '').replace(/<[^>]+>/g, '').slice(0, 140) }}</p>
              </el-card>
              <el-empty v-if="!projectNotesList.length" description="暂无项目笔记" />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div
        v-if="noteEditorOpen"
        class="note-editor-host"
        :class="{ 'note-editor-host--docked': noteEditorVariant === 'split' }"
      >
        <NoteEditorShell
          v-model:visible="noteEditorOpen"
          :note-id="noteEditorId"
          :notebook-id="noteEditorNotebookId"
          :project-id="noteEditorProjectId"
          :initial-title="noteEditorTitleSeed"
          :variant="noteEditorVariant"
          :allow-exit-to-split="shellMode === 'bookshelf' || workspaceTab === 'notes'"
          @saved="onNoteEditorSaved"
          @update:visible="(v) => !v && onNoteEditorClosed()"
          @request-fullscreen="noteEditorVariant = 'fullscreen'"
          @exit-fullscreen="onNoteEditorExitFullscreen"
        />
      </div>
    </el-main>
    </el-container>
  </el-container>

  <el-dialog
    v-model="firstLaunchStorageDialogVisible"
    title="欢迎使用 DataNode - 请选择数据存储位置"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <p class="first-launch-storage-tip">
      安装 NSIS 安装包时可以自定义<strong>程序安装目录</strong>（与其它 Windows 软件相同）。此处选择的是<strong>数据目录</strong>，用于存放数据库
      <code>datanode.db</code>、运行日志 <code>logs\datanode.log</code> 等，便于备份与排查问题。建议选大盘或您习惯管理的文件夹。
    </p>
    <el-input
      v-model="firstLaunchPendingPath"
      class="first-launch-path-input"
      type="textarea"
      :rows="2"
      readonly
      placeholder="请先点击下方「选择文件夹」"
    />
    <div class="first-launch-storage-actions">
      <el-button @click="pickFirstLaunchFolder">选择文件夹</el-button>
      <el-button
        type="primary"
        :loading="initialStorageLoading"
        :disabled="!firstLaunchPendingPath.trim()"
        @click="confirmFirstLaunchStorage"
      >
        确认并开始
      </el-button>
    </div>
  </el-dialog>

  <el-tooltip v-if="appReady && !copilotVisible" content="项目 AI" placement="left">
    <el-button class="ai-fab" type="primary" @click="openProjectCopilot">
      <el-icon><MagicStick /></el-icon>
    </el-button>
  </el-tooltip>

    <template v-if="copilotVisible">
      <div
        class="copilot-backdrop"
        :style="{ left: `${copilotLeftPx}px` }"
        @click.self="copilotVisible = false"
      />
      <div
        class="copilot-sheet"
        :class="{ 'copilot-sheet--max': copilotMaximized }"
        :style="{ left: `${copilotLeftPx}px` }"
        @click.stop
      >
        <div class="copilot-sheet-header">
          <div class="copilot-header-text">
            <div class="copilot-title-row">
              <div class="copilot-title">知识库与数据分析 AI</div>
              <el-tag size="small" :type="copilotMode === 'global' ? 'warning' : 'info'" effect="plain" class="copilot-mode-tag">
                {{ copilotModeBadge }}
              </el-tag>
            </div>
            <div class="copilot-subtitle">项目 AI 按项目隔离分支；全局 AI 独立存储。侧栏可收起，主界面左侧项目栏保持可见。</div>
          </div>
          <div class="copilot-sheet-actions">
            <el-tooltip :content="copilotMaximized ? '恢复高度' : '最大化显示'" placement="bottom">
              <el-button text circle :icon="FullScreen" @click="copilotMaximized = !copilotMaximized" />
            </el-tooltip>
            <el-button
              v-if="copilotMode === 'project'"
              size="small"
              type="primary"
              plain
              @click="applyAiJsonFromChat"
            >
              应用 JSON 入库
            </el-button>
            <el-button circle text :icon="Close" @click="copilotVisible = false" />
          </div>
        </div>
        <div class="copilot-sheet-body">
          <aside v-if="!copilotTopicsCollapsed" class="copilot-topic-rail">
            <template v-if="copilotMode === 'global'">
              <div class="global-ai-rail-tools">
                <el-tooltip content="关联项目（侧栏勾选）" placement="right">
                  <el-button
                    class="global-link-circle-btn"
                    circle
                    type="primary"
                    plain
                    :icon="Link"
                    @click="openGlobalLinkedFlyout"
                  />
                </el-tooltip>
                <span v-if="globalLinkedProjectIds.length" class="global-linked-pill">
                  已选 {{ globalLinkedProjectIds.length }} 个项目
                </span>
              </div>
            </template>
            <div class="copilot-topic-head-row">
              <span>{{ copilotMode === 'global' ? '对话分支' : copilotRailTitle }}</span>
              <el-tooltip content="收起分支栏" placement="left">
                <el-button text circle size="small" :icon="Fold" @click="copilotTopicsCollapsed = true" />
              </el-tooltip>
            </div>
            <div class="copilot-topic-new-branch">
              <el-button
                v-show="copilotMode === 'global' || currentProjectId != null"
                size="small"
                type="primary"
                plain
                class="copilot-new-branch-btn"
                @click="createAiTopicAction"
              >
                新增分支
              </el-button>
            </div>
            <el-scrollbar class="copilot-topic-scroll">
              <button
                v-for="t in aiTopics"
                :key="t.id"
                type="button"
                class="copilot-topic-row"
                :class="{
                  active:
                    (copilotMode === 'global' && t.id === activeGlobalAiTopicId) ||
                    (copilotMode === 'project' && t.id === activeAiTopicId)
                }"
                @click="selectAiTopic(t.id)"
              >
                <span class="copilot-topic-label">{{ t.title }}</span>
                <span class="copilot-topic-actions">
                  <el-button text circle :icon="EditPen" size="small" @click.stop="renameAiTopicAction(t)" />
                  <el-button text circle :icon="Delete" size="small" @click.stop="deleteAiTopicAction(t)" />
                </span>
              </button>
            </el-scrollbar>
          </aside>
          <div v-else class="copilot-topic-rail-mini">
            <el-tooltip content="展开分支栏" placement="right">
              <el-button circle :icon="Expand" @click="copilotTopicsCollapsed = false" />
            </el-tooltip>
          </div>
          <aside v-if="copilotMode === 'global' && globalLinkedFlyoutOpen" class="global-linked-flyout">
            <div class="global-linked-flyout-header">
              <span class="global-linked-flyout-title">关联项目</span>
              <el-button text circle size="small" :icon="Close" @click="globalLinkedFlyoutOpen = false" />
            </div>
            <p class="global-linked-flyout-hint">勾选需参与统计合并的项目，确认后生效。本面板贴近对话区左侧，不遮挡分支列表。</p>
            <el-scrollbar class="global-linked-flyout-scroll" max-height="320px">
              <el-checkbox-group v-model="globalLinkedDraftIds" class="global-linked-flyout-checks">
                <el-checkbox v-for="p in projects" :key="p.id" :label="p.id" class="global-linked-flyout-cb">
                  {{ p.name }}
                </el-checkbox>
              </el-checkbox-group>
            </el-scrollbar>
            <div class="global-linked-flyout-footer">
              <el-button size="small" round @click="globalLinkedFlyoutOpen = false">取消</el-button>
              <el-button size="small" round type="primary" @click="confirmGlobalLinkedProjects">确认</el-button>
            </div>
          </aside>
          <div class="copilot-chat-col">
            <div ref="chatMessagesContainer" class="copilot-messages copilot-messages-embed">
              <div
                v-for="(message, index) in chatMessages"
                :key="`chat-${index}`"
                class="chat-row"
                :class="message.role === 'user' ? 'is-user' : 'is-ai'"
              >
                <div class="chat-bubble">
                  <div class="chat-text-block">{{ message.content }}</div>
                  <div
                    v-if="message.chartSpec"
                    class="copilot-mini-chart"
                    :data-chat-chart="index"
                    style="height: 240px; width: 100%; min-width: 280px"
                  />
                </div>
              </div>
              <div v-if="chatSending" class="typing-hint">AI 正在思考...</div>
            </div>
            <div class="copilot-input-area">
              <div class="context-hint">{{ copilotContextLabel }}</div>
              <div class="chat-input-row">
                <el-input
                  v-model="chatInput"
                  placeholder="输入数据分析问题或描述非结构化文本字段…"
                  :disabled="chatSending"
                  @keyup.enter="sendChatMessage"
                />
                <el-button type="primary" :loading="chatSending" @click="sendChatMessage">发送</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

  <el-drawer v-model="detailDrawerVisible" size="450px" :with-header="false">
    <div v-if="currentDetailData" class="drawer-container">
      <div class="drawer-header">
        <h3>节点详情</h3>
        <div class="drawer-actions">
          <el-button v-if="!isEditing" type="primary" link @click="startEdit">编辑</el-button>
          <el-button v-if="isEditing" @click="cancelEdit">取消</el-button>
          <el-button v-if="isEditing" type="primary" @click="saveEdit">保存</el-button>
        </div>
      </div>

      <el-tabs v-model="activeDrawerTab" class="drawer-tabs">
        <el-tab-pane label="基本信息" name="info">
          <el-form :model="editForm" label-width="80px" label-position="left" :disabled="!isEditing">
            <el-form-item label="节点 ID">
              <el-input v-model="editForm.id" disabled />
            </el-form-item>
            <el-form-item label="节点名称">
              <el-input v-model="editForm.name" placeholder="请输入名称" />
            </el-form-item>
            <el-form-item label="数据类型">
              <el-select v-model="editForm.type" placeholder="请选择类型" style="width: 100%;">
                <el-option label="文件 (file)" value="file" />
                <el-option label="文档 (document)" value="document" />
                <el-option label="笔记 (note)" value="note" />
                <el-option label="数据行 (excel_row)" value="excel_row" />
              </el-select>
            </el-form-item>
            <el-form-item label="标签">
              <div v-if="!isEditing" class="drawer-tags">
                <el-tag v-for="tag in drawerTagList" :key="tag" size="small" effect="light">
                  {{ tag }}
                </el-tag>
              </div>
              <el-input v-else v-model="editForm.tags" placeholder="输入标签，用逗号分隔" />
            </el-form-item>
            <el-form-item label="内容摘要">
              <el-input v-model="editForm.content" type="textarea" :rows="6" placeholder="请输入内容摘要..." />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="关联图谱" name="relations">
          <div v-if="relatedNodesList.length > 0">
            <p class="drawer-relation-hint">与该节点直接相连的节点：</p>
            <el-timeline>
              <el-timeline-item v-for="node in relatedNodesList" :key="node.id" type="primary" hollow>
                <div class="relation-node-name">{{ node.name || node.id }}</div>
                <div class="relation-node-meta">类型: {{ node.type }}</div>
              </el-timeline-item>
            </el-timeline>
          </div>
          <el-empty v-else description="暂无关联节点" :image-size="60" />
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-drawer>

 title="导入数据到当前项目" width="440px" align-center>
    <p class="import-choice-hint">请选择数据来源。结构化表格支持 Excel、CSV、JSON。</p>
    <div class="import-choice-actions">
      <el-button type="primary" @click="pickLocalFileAndImport">从本地电脑导入</el-button>
      <el-button @click="openBookshelfImportPickerForProject">从书柜导入</el-button>
    </div>
  </el-dialog>

  <el-dialog v-model="bookshelfPickForImportVisible" title="从书柜选择文件" width="520px">
    <el-scrollbar max-height="360px">
      <div
        v-for="row in bookshelfImportCandidates"
        :key="row.id"
        class="bookshelf-pick-row"
        @click="confirmImportFromBookshelfItem(row)"
      >
        <span class="bp-name">{{ row.title?.trim() || row.source_file_path }}</span>
        <span class="bp-path">{{ row.source_file_path }}</span>
      </div>
      <el-empty v-if="!bookshelfImportCandidates.length" description="没有可选项" />
    </el-scrollbar>
  </el-dialog>

  <el-dialog v-model="settingsVisible" title="全局设置" width="720px">
    <el-tabs v-loading="settingsLoading" class="settings-tabs">
      <el-tab-pane label="🤖 AI 配置">
        <el-form label-width="140px" label-position="left">
          <el-form-item label="AI Base URL">
            <el-input v-model="settingsForm.ai_base_url" placeholder="例如：https://api.deepseek.com/v1" clearable />
          </el-form-item>
          <el-form-item label="AI API Key">
            <el-input
              v-model="settingsForm.ai_api_key"
              type="password"
              placeholder="请输入 OpenAI 兼容接口 API Key"
              show-password
              clearable
            />
          </el-form-item>
          <el-form-item label="AI 模型名称">
            <el-input v-model="settingsForm.ai_model_name" placeholder="例如：deepseek-chat / gpt-4o-mini" clearable />
          </el-form-item>
          <el-form-item label="系统提示词">
            <el-input
              v-model="settingsForm.ai_system_prompt"
              type="textarea"
              :rows="4"
              placeholder="可选：自定义 AI 助手的角色、语气和回答边界"
            />
          </el-form-item>
          <el-form-item label="回复温度">
            <el-slider v-model="settingsForm.ai_temperature" :min="0" :max="2" :step="0.1" show-input />
          </el-form-item>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="🎨 图谱外观">
        <el-form label-width="150px" label-position="left">
          <el-form-item label="节点默认大小">
            <el-slider v-model="settingsForm.graph_node_size" :min="20" :max="80" :step="1" show-input />
          </el-form-item>
          <el-form-item label="连线长度">
            <el-slider v-model="settingsForm.graph_edge_length" :min="60" :max="260" :step="10" show-input />
          </el-form-item>
          <el-form-item label="物理排斥力强度">
            <el-slider v-model="settingsForm.graph_repulsion" :min="100" :max="1200" :step="50" show-input />
          </el-form-item>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="⚙️ 通用设置">
        <el-form label-width="120px" label-position="left">
          <el-form-item label="存储路径">
            <div class="storage-path-row">
              <el-input v-model="storagePath" placeholder="请选择本地文件存储路径（已选路径会写入本地；切换需在首次启动前或清空后重选）" clearable />
              <el-button @click="chooseStoragePath">选择文件夹</el-button>
            </div>
            <p class="settings-hint">
              与安装目录不同：数据目录含数据库与日志；遇到问题可在「数据与诊断」中打开文件夹或复制路径。
            </p>
          </el-form-item>
          <el-form-item label="主题">
            <el-radio-group v-model="settingsForm.app_theme">
              <el-radio-button value="light">浅色</el-radio-button>
              <el-radio-button value="dark">深色</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="语言">
            <el-select v-model="settingsForm.app_language" style="width: 240px">
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="English" value="en-US" />
            </el-select>
          </el-form-item>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="数据与诊断">
        <el-form label-width="120px" label-position="left">
          <el-form-item label="数据目录">
            <el-input :model-value="dataDiagnostic.userData" type="textarea" :rows="2" readonly />
          </el-form-item>
          <el-form-item label="日志文件">
            <el-input :model-value="dataDiagnostic.logFile" type="textarea" :rows="2" readonly />
          </el-form-item>
          <el-form-item>
            <div class="diagnostic-actions">
              <el-button @click="openDataDirectory">打开数据目录</el-button>
              <el-button @click="openLogsDirectory">打开日志目录</el-button>
              <el-button @click="copyDiagnosticPath(dataDiagnostic.userData, '数据目录路径')">复制数据路径</el-button>
              <el-button @click="copyDiagnosticPath(dataDiagnostic.logFile, '日志文件路径')">复制日志路径</el-button>
            </div>
          </el-form-item>
        </el-form>
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSettings" @click="saveSettings">保存</el-button>
      </div>
    </template>
  </el-dialog>

  <div
    v-show="contextMenuVisible"
    class="custom-context-menu"
    :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
    @click.stop
  >
    <div class="menu-header">{{ currentContextNode?.name || '节点操作' }}</div>
    <div class="menu-item" @click="handleMenuDetail">
      <el-icon><Document /></el-icon>
      <span>查看详情</span>
    </div>
    <div class="menu-item" @click="handleMenuHide">
      <el-icon><Hide /></el-icon>
      <span>隐藏该节点</span>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-item" @click="handleMenuResetHidden">
      <el-icon><Refresh /></el-icon>
      <span>恢复所有隐藏</span>
    </div>
  </div>
</template>

<style scoped>
:global(body) {
  margin: 0;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #374151;
  background: #f5f7fa;
}

.app-wrapper {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: #f5f7fa;
  color: #374151;
}

.main-right-wrapper {
  height: 100vh;
  overflow: hidden;
}

.project-sidebar {
  display: flex;
  height: 100vh;
  overflow: hidden;
  flex-direction: column;
  border-right: 1px solid #e5e7eb;
  background: #f9fafb;
  transition: width 0.3s ease-in-out;
}

.sidebar-top {
  display: flex;
  height: 56px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.sidebar-title {
  color: #111827;
  font-size: 13px;
  font-weight: 700;
}

.new-project-button {
  margin: 0 12px 12px;
  justify-content: flex-start;
  border-style: dashed;
  color: #4f46e5;
}

.new-project-button.is-collapsed {
  width: 40px;
  margin: 0 auto 12px;
  padding: 8px;
}

.project-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}

.project-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  padding: 8px;
  color: #4b5563;
  cursor: pointer;
  text-align: left;
}

.project-item:hover {
  background: #f3f4f6;
}

.project-item.active {
  background: #eef2ff;
  color: #3730a3;
}

.project-item.collapsed {
  justify-content: center;
}

.project-avatar {
  display: grid;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  place-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  font-size: 12px;
  font-weight: 700;
}

.project-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-header {
  z-index: 20;
  display: flex;
  height: 56px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #e5e7eb;
  background: rgba(255, 255, 255, 0.96);
  padding: 0 16px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.04);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-right {
  justify-content: flex-end;
  flex: 1;
}

.brand-mark {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  background: linear-gradient(135deg, #ffffff, #eef2ff);
  color: #4f46e5;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.brand-copy {
  margin-right: 8px;
  line-height: 1.1;
}

.brand-copy h1 {
  margin: 0;
  color: #111827;
  font-size: 15px;
  font-weight: 650;
}

.brand-copy p {
  margin: 2px 0 0;
  color: #9ca3af;
  font-size: 11px;
}

.desktop-menu {
  display: flex;
  align-items: center;
  gap: 2px;
  border-left: 1px solid #eef2f7;
  padding-left: 10px;
}

.menu-button {
  color: #4b5563;
  font-weight: 500;
}

.global-search {
  width: min(320px, 28vw);
}

.content-area {
  display: flex;
  flex-direction: column;
  padding: 0 !important;
  position: relative;
  height: calc(100vh - 56px);
  overflow: hidden;
}

.bookshelf-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.bookshelf-sidebar-btn {
  margin: 0 12px 8px;
  justify-content: flex-start;
  width: calc(100% - 24px);
  border-radius: 10px;
  border: 1px dashed #a5b4fc;
  color: #4338ca;
  font-weight: 600;
  background: #eef2ff;
}
.bookshelf-sidebar-btn:hover {
  border-color: #6366f1;
  color: #312e81;
}
.bookshelf-sidebar-btn.is-collapsed {
  width: 40px;
  margin: 0 auto 8px;
  padding: 8px;
}

.bookshelf-pane--with-editor {
  flex: 1;
  min-width: 0;
}

.note-editor-host {
  flex-shrink: 0;
}
.note-editor-host--docked {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(480px, 44vw);
  z-index: 50;
  min-width: 320px;
}

.import-choice-hint {
  margin: 0 0 16px;
  color: #64748b;
  font-size: 14px;
  line-height: 1.5;
}
.import-choice-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.bookshelf-pick-row {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid #e2e8f0;
  margin-bottom: 8px;
}
.bookshelf-pick-row:hover {
  background: #f1f5f9;
}
.bp-name {
  display: block;
  font-weight: 600;
  color: #0f172a;
}
.bp-path {
  font-size: 12px;
  color: #94a3b8;
  word-break: break-all;
}
.global-ai-rail-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #eef2f7;
}
.global-link-circle-btn {
  flex-shrink: 0;
}
.global-linked-pill {
  font-size: 11px;
  color: #64748b;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.global-linked-flyout {
  width: 272px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: linear-gradient(180deg, #fafbff 0%, #f4f6fb 100%);
  border-right: 1px solid #e5e7eb;
  border-radius: 0 18px 18px 0;
  box-shadow: 4px 0 24px rgba(15, 23, 42, 0.06);
  padding: 12px 12px 10px;
}
.global-linked-flyout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.global-linked-flyout-title {
  font-size: 14px;
  font-weight: 700;
  color: #111827;
  letter-spacing: 0.01em;
}
.global-linked-flyout-hint {
  font-size: 12px;
  color: #64748b;
  line-height: 1.45;
  margin: 0 0 10px;
}
.global-linked-flyout-checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.global-linked-flyout-cb {
  margin-right: 0;
  border-radius: 10px;
  padding: 4px 6px;
  width: 100%;
}
.global-linked-flyout-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #e5e7eb;
}
.global-linked-flyout-scroll {
  margin-bottom: 4px;
}
.project-notes-pane {
  padding: 16px;
  min-height: 360px;
}
.project-notes-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.project-notes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.project-note-card {
  cursor: pointer;
  border-radius: 12px;
}
.pn-title {
  font-weight: 600;
  color: #0f172a;
}
.pn-meta {
  font-size: 12px;
  color: #94a3b8;
  margin: 6px 0;
}
.pn-snippet {
  margin: 0;
  font-size: 13px;
  color: #64748b;
  line-height: 1.45;
}

.workspace-main-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: none !important;
}

.workspace-main-tabs :deep(.el-tabs__header) {
  margin: 0;
  padding: 0 8px;
  background: #f8fafc;
}

.workspace-main-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.workspace-main-tabs :deep(.el-tab-pane) {
  height: 100%;
  overflow: auto;
}

.table-pane-inner {
  height: calc(100vh - 56px - 42px);
  min-height: 420px;
  background: #fff;
}

.graph-pane-embedded {
  width: 100%;
  height: calc(100vh - 56px - 42px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
  border: none;
  box-shadow: none;
  background: #fafafa;
}

.graph-canvas-embedded {
  flex: 1;
  min-height: 400px;
}

.graph-pane-header {
  height: 40px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 15px;
  border-bottom: 1px solid #e5e7eb;
  background: #fff;
}

.graph-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-graph-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 60px;
  background-color: #409EFF;
  color: #ffffff;
  border: none;
  border-radius: 8px 0 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: -4px 0 12px rgba(64, 158, 255, 0.3);
  z-index: 999;
  transition: all 0.3s ease;
}

.toggle-graph-btn:hover {
  background-color: #337ecc;
  width: 28px;
}

.toggle-graph-btn .el-icon {
  color: #ffffff !important;
  font-size: 18px;
}

.graph-canvas {
  width: 100%;
  height: 100%;
  background: #ffffff;
}

.graph-pane-body {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.focus-banner {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #fde68a;
  border-radius: 999px;
  background: rgba(255, 251, 235, 0.96);
  padding: 6px 10px 6px 12px;
  color: #92400e;
  font-size: 12px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
}

.popover-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.popover-title {
  color: #111827;
  font-size: 13px;
  font-weight: 650;
}

.storage-path-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
}

.storage-path-row .el-input {
  flex: 1;
}

.first-launch-storage-tip {
  margin: 0 0 20px;
  color: #4b5563;
  font-size: 14px;
  line-height: 1.8;
}

.first-launch-path-input {
  margin-bottom: 16px;
}

.first-launch-path-input :deep(.el-textarea__inner) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
}

.first-launch-storage-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  padding: 4px 0;
}

.settings-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #6b7280;
  line-height: 1.6;
}

.diagnostic-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-fab {
  position: fixed !important;
  right: 20px !important;
  bottom: 20px !important;
  z-index: 1200 !important;
  width: 54px !important;
  height: 54px !important;
  border-radius: 18px !important;
  border: 1px solid #dbeafe !important;
  background: linear-gradient(135deg, #2563eb, #4f46e5) !important;
  box-shadow: 0 18px 38px rgba(37, 99, 235, 0.24) !important;
}

.copilot-backdrop {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1100;
  background: rgba(15, 23, 42, 0.12);
}

.copilot-sheet {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 1110;
  display: flex;
  flex-direction: column;
  height: 75vh;
  max-height: calc(100vh - 56px);
  border-top-left-radius: 16px;
  background: #ffffff;
  box-shadow: 0 -12px 48px rgba(15, 23, 42, 0.18);
  overflow: hidden;
}

.copilot-sheet--max {
  height: calc(100vh - 56px);
  max-height: calc(100vh - 56px);
  border-top-left-radius: 0;
}

.copilot-sheet-header {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #eef2f7;
  background: #ffffff;
}

.copilot-header-text {
  min-width: 0;
}

.copilot-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.copilot-mode-tag {
  flex-shrink: 0;
  max-width: 100%;
}

.copilot-sheet-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.copilot-sheet-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.copilot-topic-rail {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid #eef2f7;
  display: flex;
  flex-direction: column;
  background: #f9fafb;
  position: relative;
}

  width: 52px;
  flex-shrink: 0;
  border-right: 1px solid #eef2f7;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12px;
  background: #f9fafb;
}

.copilot-topic-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 6px;
  font-size: 12px;
  font-weight: 650;
  color: #374151;
}

.copilot-topic-new-branch {
  padding: 0 12px 10px;
}

.copilot-new-branch-btn {
  width: 100%;
}

.copilot-topic-scroll {
  flex: 1;
  min-height: 0;
}

.copilot-topic-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid #f3f4f6;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.copilot-topic-row:hover {
  background: #f3f4f6;
}

.copilot-topic-row.active {
  background: #eef2ff;
  color: #3730a3;
}

.copilot-topic-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.copilot-topic-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}

.copilot-chat-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.copilot-messages-embed {
  flex: 1;
  min-height: 0;
}

.copilot-header-bar {
  width: 100%;
}

.copilot-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-text-block {
  white-space: pre-wrap;
}

.copilot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #eef2f7;
  background: #ffffff;
  padding: 14px 16px;
}

.copilot-title {
  color: #111827;
  font-size: 14px;
  font-weight: 650;
}

.copilot-subtitle {
  margin-top: 2px;
  color: #9ca3af;
  font-size: 11px;
}

.copilot-messages {
  flex: 1;
  overflow-y: auto;
  background: #f9fafb;
  padding: 14px;
}

.chat-row {
  display: flex;
  margin-bottom: 10px;
}

.chat-row.is-user {
  justify-content: flex-end;
}

.chat-row.is-ai {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 82%;
  white-space: pre-wrap;
  border-radius: 16px;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 1.65;
}

.is-user .chat-bubble {
  border-bottom-right-radius: 5px;
  background: #2563eb;
  color: #ffffff;
}

.is-ai .chat-bubble {
  border: 1px solid #e5e7eb;
  border-bottom-left-radius: 5px;
  background: #ffffff;
  color: #374151;
}

.typing-hint,
.context-hint {
  color: #9ca3af;
  font-size: 12px;
}

.copilot-input-area {
  flex-shrink: 0;
  border-top: 1px solid #eef2f7;
  background: #ffffff;
  padding: 12px;
}

.context-hint {
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

:deep(.modern-table) {
  --el-table-border-color: #eef2f7;
  --el-table-header-bg-color: #f9fafb;
  --el-table-header-text-color: #6b7280;
  --el-table-row-hover-bg-color: #f8fafc;
  color: #374151;
}

:deep(.modern-table .el-table__inner-wrapper::before),
:deep(.modern-table .el-table__border-left-patch) {
  display: none;
}

:deep(.el-button.is-circle) {
  border-color: #e5e7eb;
  color: #4b5563;
  background: #ffffff;
}

:deep(.el-button.is-circle:hover) {
  border-color: #c7d2fe;
  color: #4f46e5;
  background: #f8fafc;
}

:deep(.el-input__wrapper) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px #e5e7eb inset;
}

:deep(.el-input__wrapper:hover),
:deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #c7d2fe inset;
}

:deep(.el-drawer) {
  background: #ffffff;
}

:deep(.el-drawer__header) {
  margin-bottom: 0;
  border-bottom: 1px solid #eef2f7;
  padding: 18px 22px;
  color: #111827;
}

:deep(.el-drawer__body) {
  padding: 20px;
}

.drawer-container {
  padding: 10px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.drawer-header h3 {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drawer-tabs {
  flex: 1;
  overflow-y: auto;
}

.drawer-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.drawer-relation-hint {
  font-size: 13px;
  color: #909399;
  margin-bottom: 12px;
}

.relation-node-name {
  font-weight: 700;
  color: #303133;
}

.relation-node-meta {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.custom-context-menu {
  position: fixed;
  z-index: 9999;
  background-color: #ffffff;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 6px 0;
  min-width: 160px;
  font-size: 13px;
  color: #606266;
}

.menu-header {
  padding: 4px 16px 8px;
  font-size: 12px;
  color: #909399;
  border-bottom: 1px solid #ebeef5;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-item {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: background-color 0.2s;
}

.menu-item:hover {
  background-color: #f5f7fa;
  color: #409eff;
}

.menu-divider {
  height: 1px;
  background-color: #ebeef5;
  margin: 4px 0;
}

:deep(.el-overlay) {
  background-color: rgba(15, 23, 42, 0.18);
}

:deep(.el-dialog) {
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.16);
}
</style>
