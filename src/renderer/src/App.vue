<script setup lang="ts">
import * as echarts from 'echarts'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Aim,
  ArrowLeft,
  Close,
  Collection,
  Delete,
  Document,
  DocumentAdd,
  Filter,
  Fold,
  FolderOpened,
  Hide,
  MagicStick,
  MoreFilled,
  Plus,
  Refresh,
  Search,
  Upload,
  Expand,
  View
} from '@element-plus/icons-vue'

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
}
type SelectedContextNode = {
  id: number
  title: string
}

const loading = ref(false)
const importing = ref(false)
const searching = ref(false)
const savingNote = ref(false)
const savingLayout = ref(false)
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
const currentProjectId = ref<number | null>(null)
const copilotVisible = ref(false)
const chatSending = ref(false)
const chatInput = ref('')
const chatMessages = ref<ChatMessage[]>([
  { role: 'assistant', content: '你好，我是 DataNode 全局 AI 助手。你可以直接提问，也可以先选中一个节点让我结合上下文回答。' }
])
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
const isGraphOpen = ref(false)
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
const noteDialogVisible = ref(false)
const noteTitle = ref('')
const noteContent = ref('')
const noteTagsInput = ref('')
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

const isExcelType = (type: unknown): boolean => type === 'excel' || type === 'excel_row'
const isStructuredImportPath = (filePath: string): boolean => {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.docx')
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
  if (!selectedContextNode.value) return '当前未选中节点'
  return `已关联当前选中节点：${selectedContextNode.value.title}`
})

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
  if (currentProjectId.value === projectId) return
  currentProjectId.value = projectId
  currentNode.value = null
  selectedContextNode.value = null
    detailDrawerVisible.value = false
  isFocusMode.value = false
  await runSearch()
  await loadAllTags()
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
  await runSearch()
  ElMessage.success('项目已删除')
}

const refreshItems = async (): Promise<void> => {
  loading.value = true
  try {
    const result = await window.api.listItems(currentProjectId.value ?? undefined)
    applyRows(result)
    try {
      await loadGraphData(false)
    } catch {
      // 图谱接口异常不阻塞表格查询
    }
  } finally {
    loading.value = false
  }
}

const runSearch = async (): Promise<void> => {
  searching.value = true
  try {
    const result = await window.api.listItems(currentProjectId.value ?? undefined)
    applyRows(result)
    try {
      await loadGraphData(false)
    } catch {
      // 图谱接口异常不阻塞搜索结果展示
    }
  } finally {
    searching.value = false
  }
}

const openNoteDialog = (): void => {
  noteTitle.value = ''
  noteContent.value = ''
  noteTagsInput.value = ''
  noteDialogVisible.value = true
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
  await loadProjects()
  await refreshItems()
  await loadAllTags()
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

const handleFileCommand = (command: string): void => {
  if (command === 'import') {
    void importFile()
    return
  }
  if (command === 'open-data-folder') {
    void openDataDirectory()
    return
  }
  if (command === 'note') {
    openNoteDialog()
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

const saveNote = async (): Promise<void> => {
  const title = noteTitle.value.trim()
  const content = noteContent.value.trim()
  if (!content) {
    ElMessage.warning('请先输入笔记内容')
    return
  }
  const tags = noteTagsInput.value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)

  savingNote.value = true
  try {
    const result = await window.api.createNote(title, content, tags, currentProjectId.value ?? undefined)
    if (!result.success) {
      ElMessage.warning(result.message)
      return
    }
    ElMessage.success(result.message)
    noteDialogVisible.value = false
    noteTitle.value = ''
    noteContent.value = ''
    noteTagsInput.value = ''
    await runSearch()
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`新建笔记失败：${String(error)}`)
  } finally {
    savingNote.value = false
  }
}

const importFile = async (): Promise<void> => {
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

const cloneGraphPayload = <T>(payload: T): T => JSON.parse(JSON.stringify(payload)) as T

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
    const result = await window.api.getAllTags(currentProjectId.value ?? undefined)
    allTags.value = result.success ? cloneGraphPayload(result.data) : []
  } catch {
    allTags.value = []
  }
}

// @ts-ignore - 预留给节点详情里的局部聚焦操作
const focusCurrentNode = async (): Promise<void> => {
  if (!currentNode.value) return
  try {
    const result = await window.api.getLocalGraphData(currentNode.value.id, 1, currentProjectId.value ?? undefined)
    if (!result.success) {
      ElMessage.error(result.message || '局部图谱加载失败')
      return
    }
    isFocusMode.value = true
    focusNodeName.value = currentNode.value.name
    detailDrawerVisible.value = false
    await openGraphPanel()
    await applyGraphData(result.data.nodes ?? [], result.data.edges ?? [], true)
  } catch (error) {
    ElMessage.error(`局部图谱加载失败：${String(error)}`)
  }
}

const clearFocus = async (): Promise<void> => {
  activeNodeId.value = null
  if (isFocusMode.value) {
    await loadGraphData(true)
    return
  }
  updateGraphHighlight(searchKeyword.value)
}

const openGraphPanel = async (): Promise<void> => {
  isGraphOpen.value = true
  await nextTick()
  if (!graphInstance.value) {
    await renderGraphFromApi()
    return
  }
  resizeGraph()
  updateGraphHighlight(searchKeyword.value)
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

const renderGraphFromApi = async (): Promise<void> => {
  try {
    await loadGraphData(true)
  } catch (error) {
    ElMessage.error(`图谱加载失败：${String(error)}`)
  }
}

const resizeGraph = (): void => {
  graphInstance.value?.resize()
}

const saveGraphLayout = async (): Promise<void> => {
  if (!graphInstance.value) {
    ElMessage.warning('图谱尚未初始化')
    return
  }

  savingLayout.value = true
  try {
    const seriesModel = (graphInstance.value as any).getModel().getSeriesByIndex(0)
    const data = seriesModel.getData()
    const positions: Array<{ id: number; x: number; y: number }> = []

    for (let index = 0; index < data.count(); index += 1) {
      const id = Number(data.getId(index))
      const layout = data.getItemLayout(index)
      const x = Array.isArray(layout) ? layout[0] : layout?.x
      const y = Array.isArray(layout) ? layout[1] : layout?.y
      if (Number.isFinite(id) && Number.isFinite(x) && Number.isFinite(y)) {
        positions.push({ id, x, y })
      }
    }

    const result = await window.api.updateNodePositions(positions)
    if (!result.success) {
      ElMessage.error(result.message || '布局保存失败')
      return
    }
    ElMessage.success('布局保存成功')
    await loadGraphData(false)
  } catch (error) {
    ElMessage.error(`布局保存失败：${String(error)}`)
  } finally {
    savingLayout.value = false
  }
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

const sendChatMessage = async (): Promise<void> => {
  const content = chatInput.value.trim()
  if (!content || chatSending.value) return

  chatInput.value = ''
  chatMessages.value.push({ role: 'user', content })
  await scrollChatToBottom()

  chatSending.value = true
  try {
    const result = await window.api.chatWithAi({
      messages: chatMessages.value.map((message) => ({ role: message.role, content: message.content })),
      context_node_id: selectedContextNode.value?.id ?? null
    })
    if (!result.success) {
      ElMessage.error(result.message || 'AI 对话失败')
      return
    }
    chatMessages.value.push({ role: 'assistant', content: result.data.answer })
    await scrollChatToBottom()
  } catch (error) {
    ElMessage.error(`AI 对话失败：${String(error)}`)
  } finally {
    chatSending.value = false
  }
}

watch(isGraphOpen, async (open) => {
  if (open) {
    await nextTick()
    if (!graphInstance.value) {
      await renderGraphFromApi()
    } else {
      resizeGraph()
      updateGraphHighlight(searchKeyword.value)
    }
  }
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
          <p>{{ currentProject?.name || 'Knowledge workspace' }}</p>
        </div>

        <div class="desktop-menu">
          <el-dropdown trigger="click" @command="handleFileCommand">
            <el-button text class="menu-button">文件</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="import" :icon="Upload">导入 Excel</el-dropdown-item>
                <el-dropdown-item command="import" :icon="FolderOpened">导入文档 / 文件</el-dropdown-item>
                <el-dropdown-item command="open-data-folder" :icon="FolderOpened">打开数据文件夹</el-dropdown-item>
                <el-dropdown-item command="note" :icon="DocumentAdd">新建笔记</el-dropdown-item>
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
      <div class="table-pane">
        <el-table
          :data="filteredTableData"
          stripe
          v-loading="loading"
          height="100%"
          class="modern-table"
          @row-click="handleTableRowClick"
        >
          <el-table-column prop="id" label="ID" width="90" fixed="left" />
          <el-table-column prop="type" label="类型" width="130" fixed="left" />
          <el-table-column label="标签" min-width="220" show-overflow-tooltip fixed="left">
            <template #default="{ row }">
              <div class="flex flex-wrap gap-1">
                <el-tag
                  v-for="tag in nodeTagsMap[row.id] || []"
                  :key="`${row.id}-${tag.id}`"
                  size="small"
                  :style="{ backgroundColor: tag.color, borderColor: tag.color, color: '#fff' }"
                >
                  {{ tag.name }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="内容摘要/名称" min-width="320" show-overflow-tooltip fixed="left">
            <template #default="{ row }">
              <span class="text-slate-700">{{ summarizeContent(row) }}</span>
            </template>
          </el-table-column>
          <template v-if="currentTableFilter !== 'all' && currentTableFilter.includes('excel')">
            <el-table-column
              v-for="col in dynamicColumns"
              :key="col"
              :label="col"
              min-width="150"
              show-overflow-tooltip
            >
              <template #default="scope">
                <span v-if="isExcelType(scope.row.type)">{{ scope.row[col] ?? '-' }}</span>
                <span v-else class="text-slate-300">-</span>
              </template>
            </el-table-column>
          </template>
          <el-table-column
            v-if="showMetadata"
            prop="source_file_path"
            label="来源文件"
            min-width="320"
            fixed="right"
            show-overflow-tooltip
          />
          <el-table-column v-if="showMetadata" prop="created_at" label="创建时间" min-width="220" fixed="right" />
        </el-table>

      </div>

      <div v-show="isGraphOpen" class="graph-pane">
        <div class="graph-pane-header">
          <span>知识图谱</span>
          <div class="graph-actions">
            <el-popover placement="bottom-end" width="320" trigger="click">
              <template #reference>
                <span>
                  <el-tooltip content="图谱过滤器" placement="bottom">
                    <el-button circle :icon="Filter" />
                  </el-tooltip>
                </span>
              </template>
              <div class="popover-panel">
                <div class="popover-title">图谱过滤器</div>
                <el-select v-model="graphTypeFilters" multiple clearable placeholder="按节点类型过滤">
                  <el-option v-for="type in availableTypes" :key="`graph-type-${type}`" :label="type" :value="type" />
                </el-select>
                <el-select v-model="graphTagFilters" multiple clearable filterable placeholder="按标签过滤">
                  <el-option v-for="tag in allTags" :key="`graph-tag-${tag.id}`" :label="tag.name" :value="tag.name" />
                </el-select>
              </div>
            </el-popover>
            <el-tooltip content="保存当前布局" placement="bottom">
              <el-button circle :icon="Collection" :loading="savingLayout" @click="saveGraphLayout" />
            </el-tooltip>
            <el-tooltip content="清除高亮 / 退出聚焦" placement="bottom">
              <el-button circle :icon="Aim" :disabled="!activeNodeId && !isFocusMode" @click="clearFocus" />
            </el-tooltip>
            <el-tooltip content="关闭图谱" placement="bottom">
              <el-button circle :icon="Close" @click="isGraphOpen = false" />
            </el-tooltip>
          </div>
        </div>
        <div class="graph-pane-body">
          <div v-if="isFocusMode" class="focus-banner">
            <span>当前处于局部聚焦模式：{{ focusNodeName }}</span>
            <el-button size="small" text :icon="Close" @click="clearFocus">返回全局</el-button>
          </div>
          <div ref="graphContainer" class="graph-canvas"></div>
        </div>
      </div>

      <el-tooltip v-if="!isGraphOpen" content="展开图谱" placement="left">
        <button class="toggle-graph-btn" @click="openGraphPanel">
          <el-icon><ArrowLeft /></el-icon>
        </button>
      </el-tooltip>
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

  <el-button v-if="appReady && !copilotVisible" class="ai-fab" type="primary" @click="copilotVisible = true">
    <el-icon><MagicStick /></el-icon>
  </el-button>

  <div v-if="appReady && copilotVisible" class="copilot-panel">
    <div class="copilot-header">
      <div>
        <div class="copilot-title">知识库 AI 助手</div>
        <div class="copilot-subtitle">Global Copilot</div>
      </div>
      <el-button circle text :icon="Close" @click="copilotVisible = false" />
    </div>

    <div ref="chatMessagesContainer" class="copilot-messages">
      <div
        v-for="(message, index) in chatMessages"
        :key="`chat-${index}`"
        class="chat-row"
        :class="message.role === 'user' ? 'is-user' : 'is-ai'"
      >
        <div class="chat-bubble">
          {{ message.content }}
        </div>
      </div>
      <div v-if="chatSending" class="typing-hint">AI 正在思考...</div>
    </div>

    <div class="copilot-input-area">
      <div class="context-hint">{{ copilotContextLabel }}</div>
      <div class="chat-input-row">
        <el-input
          v-model="chatInput"
          placeholder="输入问题，回车发送"
          :disabled="chatSending"
          @keyup.enter="sendChatMessage"
        />
        <el-button type="primary" :loading="chatSending" @click="sendChatMessage">发送</el-button>
      </div>
    </div>
  </div>

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

  <el-dialog v-model="noteDialogVisible" title="新建笔记" width="640px">
    <el-input v-model="noteTitle" class="mb-3" placeholder="请输入笔记标题（可选）" />
    <el-input
      v-model="noteContent"
      type="textarea"
      :rows="8"
      placeholder="请输入笔记正文..."
      maxlength="10000"
      show-word-limit
    />
    <el-input
      v-model="noteTagsInput"
      class="mt-3"
      placeholder="标签（可选）：用逗号或空格分隔，如 项目A,待跟进,灵感"
    />
    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="noteDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingNote" @click="saveNote">保存</el-button>
      </div>
    </template>
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
  flex-direction: row;
  padding: 0 !important;
  position: relative;
  height: calc(100vh - 56px);
  overflow: hidden;
}

.table-pane {
  flex: 1;
  height: 100%;
  overflow: auto;
  background-color: #ffffff;
}

.graph-pane {
  width: 50%;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #e5e7eb;
  background-color: #fafafa;
  box-shadow: -4px 0 15px rgba(0, 0, 0, 0.05);
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

.copilot-panel {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1200;
  display: flex;
  width: 360px;
  height: 520px;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #ffffff;
  box-shadow:
    0 24px 60px rgba(15, 23, 42, 0.16),
    0 4px 6px -1px rgba(0, 0, 0, 0.05);
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
