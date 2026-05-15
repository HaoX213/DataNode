import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type NotebookRow = {
  id: number
  name: string
  parent_id: number | null
  created_at: string
}

export type ItemRow = {
  id: number
  notebook_id?: number
  project_id: number | null
  type: 'note' | 'excel_row' | 'document' | 'file'
  title: string
  content_text: string
  content_json: string
  source_file_path: string
  created_at: string
  updated_at?: string
}

export type ImportResult = {
  success: boolean
  message: string
  inserted: number
  mode?: 'ai_text'
  preview?: string
  filePath?: string
}

export type StatsQueryPayload = {
  op: string
  projectId?: number | null
  /** 多项目合并（传给统计引擎时会合并 excel_row 并打上 _DataNodeProjectId） */
  projectIds?: number[] | null
  field?: string
  groupField?: string
  aggregateField?: string
  aggregateType?: string
  limit?: number
}

export type StatsQueryResult = {
  success: boolean
  message?: string
  data?: unknown
}

export type PickImportFileResult = {
  success: boolean
  message?: string
  filePath?: string
}

export type ActionResult = {
  success: boolean
  message: string
  data?: unknown
}

export type ProjectRow = {
  id: number
  name: string
  created_at: string
}

export type ProjectsResult = {
  success: boolean
  message?: string
  data: ProjectRow[]
}

export type ProjectResult = {
  success: boolean
  message?: string
  data?: ProjectRow
}

export type GraphTag = {
  id: number
  name: string
  color: string
}

export type GraphNode = {
  id: number
  name: string
  type: ItemRow['type']
  tags: GraphTag[]
  x: number | null
  y: number | null
}

export type GraphEdge = {
  id: number
  source: number
  target: number
  label: string
}

export type NodeSearchResult = {
  id: number
  name: string
  type: ItemRow['type']
}

export type NodeEdge = GraphEdge & {
  direction: 'outgoing' | 'incoming'
  otherNodeId: number
  otherNodeName: string
  otherNodeType: ItemRow['type']
}

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type GraphDataResult = {
  success: boolean
  message?: string
  data: GraphData
}

export type TagsResult = {
  success: boolean
  message?: string
  data: GraphTag[]
}

export type GraphFilterInput = {
  types?: string[]
  tags?: string[]
  projectId?: number
  bookshelfOnly?: boolean
}

export type NodePositionInput = {
  id: number
  x: number
  y: number
}

export type NodeDetail = ItemRow & {
  tags: GraphTag[]
}

export type NodeDetailResult = {
  success: boolean
  message?: string
  data?: NodeDetail
}

export type NodeSearchResultResponse = {
  success: boolean
  message?: string
  data: NodeSearchResult[]
}

export type NodeEdgesResult = {
  success: boolean
  message?: string
  data: NodeEdge[]
}

export type AiSummaryResult = {
  success: boolean
  message?: string
  data: {
    summary: string
  }
}

export type AiChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type DashboardUiPersistV1 = {
  statField: string
  catField: string
  groupField: string
  aggregateField: string
  aggregateType: 'sum' | 'avg' | 'count'
}

export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right'

/** 仪表盘可拖拽图表卡片（ECharts） */
export type ChartCardKind = 'category_pie' | 'group_bar'

export type ChartCardConfig = {
  id: string
  kind: ChartCardKind
  title?: string
  catField?: string
  groupField?: string
  aggregateField?: string
  aggregateType?: 'sum' | 'avg' | 'count'
  /** 分类图：pie | bar；分组图：bar | line */
  chartStyle?: 'pie' | 'bar' | 'line'
  xAxisName?: string
  yAxisName?: string
  color?: string
  legendPosition?: ChartLegendPosition
  cardWidthPx?: number
  chartHeightPx?: number
  titleFontSize?: number
  axisFontSize?: number
}

export type ProjectUiStateV1 = {
  dashboard: DashboardUiPersistV1
  workspace: {
    tableFilter: string
    searchKeyword: string
    workspaceTab?: 'dashboard' | 'raw' | 'notes' | 'graph'
  }
  aiCurrentTopicId: number | null
  /** 未写入过该字段的旧数据为 undefined，由前端按当前 dashboard 生成默认两张卡 */
  chartConfigurations?: ChartCardConfig[]
}

export type AiTopicRow = {
  id: number
  /** 项目分支为项目 id；全局 AI 为 null */
  project_id: number | null
  title: string
  created_at: string
  updated_at: string
}

export type AiMessageRow = {
  id: number
  topic_id: number
  role: 'user' | 'assistant'
  content: string
  chart_json: string | null
  created_at: string
}

export type AiTopicsResult = {
  success: boolean
  message?: string
  data: AiTopicRow[]
}

export type AiMessagesResult = {
  success: boolean
  message?: string
  data: AiMessageRow[]
}

export type ProjectUiStateResult = {
  success: boolean
  message?: string
  data?: ProjectUiStateV1
}

export type AiTopicCreateResult = {
  success: boolean
  message?: string
  data?: { id: number }
}

export type GlobalAiCurrentTopicResult = {
  success: boolean
  message?: string
  data: number | null
}

export type GlobalAiLinkedProjectsResult = {
  success: boolean
  message?: string
  data: number[]
}

export type AiChatResult = {
  success: boolean
  message?: string
  data: {
    answer: string
  }
}

export type AppSettings = {
  ai_api_key: string
  ai_base_url: string
  ai_model_name: string
  ai_system_prompt: string
  ai_temperature: string | number
  graph_node_size: string | number
  graph_edge_length: string | number
  graph_repulsion: string | number
  app_theme: string
  app_language: string
}

export type SettingsResult = {
  success: boolean
  message?: string
  data: AppSettings
}

export type DataPaths = {
  userData: string
  logsDir: string
  logFile: string
  dbFile: string
}

const api = {
  listNotebooks: (): Promise<NotebookRow[]> => ipcRenderer.invoke('db:notebooks:list'),
  listBookshelfTree: (): Promise<{ success: boolean; message?: string; data: NotebookRow[] }> =>
    ipcRenderer.invoke('bookshelf:tree:list'),
  createBookshelfFolder: (name: string, parentId?: number | null): Promise<ActionResult & { data?: { id: number } }> =>
    ipcRenderer.invoke('bookshelf:notebook:create', name, parentId),
  renameBookshelfFolder: (id: number, name: string): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:notebook:rename', id, name),
  deleteBookshelfFolder: (id: number): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:notebook:delete', id),
  listBookshelfItems: (notebookId: number): Promise<{ success: boolean; data: ItemRow[] }> =>
    ipcRenderer.invoke('bookshelf:items:list', notebookId),
  listAllBookshelfGlobalItems: (): Promise<{ success: boolean; message?: string; data: ItemRow[] }> =>
    ipcRenderer.invoke('bookshelf:items:list-all'),
  moveBookshelfNotebook: (notebookId: number, parentId: number | null): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:notebook:move', notebookId, parentId),
  moveBookshelfItem: (itemId: number, notebookId: number): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:item:move', itemId, notebookId),
  deleteBookshelfItem: (itemId: number): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:item:delete', itemId),
  duplicateBookshelfNote: (itemId: number): Promise<ActionResult & { data?: { id: number } }> =>
    ipcRenderer.invoke('bookshelf:note:duplicate', itemId),
  renameBookshelfItem: (itemId: number, title: string): Promise<ActionResult> =>
    ipcRenderer.invoke('bookshelf:item:rename', itemId, title),
  listBookshelfImportCandidates: (): Promise<{ success: boolean; data: ItemRow[] }> =>
    ipcRenderer.invoke('bookshelf:import:candidates'),
  importFileIntoBookshelf: (notebookId: number, filePath: string): Promise<ImportResult> =>
    ipcRenderer.invoke('bookshelf:import-file', notebookId, filePath),
  listProjectNotes: (projectId: number): Promise<{ success: boolean; data: ItemRow[] }> =>
    ipcRenderer.invoke('project:notes:list', projectId),
  listProjectDocuments: (
    projectId: number
  ): Promise<{ success: boolean; message?: string; data?: { notes: ItemRow[]; references: ItemRow[] } }> =>
    ipcRenderer.invoke('project:documents:list', projectId),
  copyBookshelfItemsToProject: (
    itemIds: number[],
    projectId: number
  ): Promise<ActionResult & { data?: { ids: number[] } }> =>
    ipcRenderer.invoke('project:documents:copy-from-bookshelf', itemIds, projectId),
  openPathWithShell: (filePath: string): Promise<ActionResult> =>
    ipcRenderer.invoke('shell:open-path', filePath),
  listProjects: (): Promise<ProjectsResult> => ipcRenderer.invoke('projects:list'),
  createProject: (name: string): Promise<ProjectResult> => ipcRenderer.invoke('projects:create', name),
  deleteProject: (projectId: number): Promise<ActionResult> => ipcRenderer.invoke('projects:delete', projectId),
  initializeStoragePath: (storagePath: string): Promise<ActionResult> =>
    ipcRenderer.invoke('app:initialize-storage', storagePath),
  getDataPaths: (): Promise<DataPaths> => ipcRenderer.invoke('app:get-data-paths'),
  openUserDataFolder: (): Promise<ActionResult> => ipcRenderer.invoke('app:open-user-data-folder'),
  openLogsFolder: (): Promise<ActionResult> => ipcRenderer.invoke('app:open-logs-folder'),
  copyText: (text: string): Promise<ActionResult> => ipcRenderer.invoke('app:copy-text', text),
  listItems: (projectId?: number): Promise<ItemRow[]> => ipcRenderer.invoke('db:items:list', projectId),
  searchItems: (keyword: string, projectId?: number): Promise<ItemRow[]> => ipcRenderer.invoke('db:items:search', keyword, projectId),
  openDirectoryDialog: (): Promise<string> => ipcRenderer.invoke('open-directory-dialog'),
  getSettings: (): Promise<SettingsResult> => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload: AppSettings): Promise<SettingsResult> => ipcRenderer.invoke('settings:save', payload),
  getNodeDetail: (nodeId: number): Promise<NodeDetailResult> => ipcRenderer.invoke('db:items:get-detail', nodeId),
  searchNodes: (keyword: string, excludeId?: number, projectId?: number): Promise<NodeSearchResultResponse> =>
    ipcRenderer.invoke('db:items:search-nodes', keyword, excludeId, projectId),
  updateNodeDetail: (payload: {
    id: number
    title: string
    contentText: string
    tags: string[]
  }): Promise<ActionResult> => ipcRenderer.invoke('db:items:update-detail', payload),
  patchNoteCover: (itemId: number, cover: string | null): Promise<ActionResult> =>
    ipcRenderer.invoke('db:items:patch-cover', itemId, cover),
  openFile: (filePath: string): Promise<ActionResult> => ipcRenderer.invoke('db:items:open-file', filePath),
  createNote: (
    title: string,
    contentText: string,
    tags: string[],
    projectId?: number | null,
    notebookId?: number,
    forceBookshelfGlobal?: boolean
  ): Promise<ActionResult> =>
    ipcRenderer.invoke('db:items:create-note', title, contentText, tags, projectId, notebookId, Boolean(forceBookshelfGlobal)),
  clearItems: (projectId?: number): Promise<ActionResult> => ipcRenderer.invoke('db:items:clear', projectId),
  pickImportFile: (): Promise<PickImportFileResult> => ipcRenderer.invoke('db:items:pick-import-file'),
  pickBookshelfDocumentFile: (): Promise<PickImportFileResult> =>
    ipcRenderer.invoke('bookshelf:pick-document-file'),
  pickProjectDocumentFile: (): Promise<PickImportFileResult> =>
    ipcRenderer.invoke('project:pick-document-file'),
  importFile: (filePath: string, title?: string, projectId?: number): Promise<ImportResult> =>
    ipcRenderer.invoke('db:items:import', filePath, title, projectId),
  importStructuredJson: (payload: {
    projectId?: number
    rows: Record<string, unknown>[]
    sourceFilePath?: string
  }): Promise<ImportResult> => ipcRenderer.invoke('db:items:import-json-array', payload),
  statsQuery: (payload: StatsQueryPayload): Promise<StatsQueryResult> => ipcRenderer.invoke('stats:query', payload),
  getAllTags: (payload?: { projectId?: number; bookshelfOnly?: boolean }): Promise<TagsResult> =>
    ipcRenderer.invoke('graph:get-all-tags', payload ?? {}),
  getGraphData: (filters?: GraphFilterInput): Promise<GraphDataResult> =>
    ipcRenderer.invoke('graph:get-graph-data', filters),
  getLocalGraphData: (
    nodeId: number,
    depth?: number,
    projectId?: number,
    bookshelfOnly?: boolean
  ): Promise<GraphDataResult> =>
    ipcRenderer.invoke('graph:get-local-graph-data', nodeId, depth, projectId, bookshelfOnly),
  getNodeEdges: (nodeId: number): Promise<NodeEdgesResult> => ipcRenderer.invoke('graph:get-node-edges', nodeId),
  addTagToNode: (nodeId: number, tagName: string, color: string): Promise<ActionResult> =>
    ipcRenderer.invoke('graph:add-tag-to-node', nodeId, tagName, color),
  removeTagFromNode: (nodeId: number, tagId: number): Promise<ActionResult> =>
    ipcRenderer.invoke('graph:remove-tag-from-node', nodeId, tagId),
  addRelation: (sourceId: number, targetId: number, label: string): Promise<ActionResult> =>
    ipcRenderer.invoke('graph:add-relation', sourceId, targetId, label),
  removeRelation: (relationId: number): Promise<ActionResult> =>
    ipcRenderer.invoke('graph:remove-relation', relationId),
  updateNodePositions: (positions: NodePositionInput[]): Promise<ActionResult> =>
    ipcRenderer.invoke('graph:update-node-positions', positions),
  summarizeNode: (nodeId: number): Promise<AiSummaryResult> => ipcRenderer.invoke('ai:summarize-node', nodeId),
  chatWithAi: (payload: {
    messages: AiChatMessage[]
    context_node_id?: number | null
    project_id?: number | null
    global_ai?: boolean
    linked_project_ids?: number[]
    raw_file_preview?: string
    raw_file_path?: string
  }): Promise<AiChatResult> => ipcRenderer.invoke('ai:chat', payload),
  getProjectUiState: (projectId: number): Promise<ProjectUiStateResult> =>
    ipcRenderer.invoke('project:ui:get', projectId),
  saveProjectUiState: (projectId: number, state: ProjectUiStateV1): Promise<ActionResult> =>
    ipcRenderer.invoke('project:ui:save', projectId, state),
  listAiTopics: (projectId: number): Promise<AiTopicsResult> => ipcRenderer.invoke('ai:topics:list', projectId),
  createAiTopic: (projectId: number, title: string): Promise<AiTopicCreateResult> =>
    ipcRenderer.invoke('ai:topic:create', projectId, title),
  renameAiTopic: (topicId: number, title: string): Promise<ActionResult> =>
    ipcRenderer.invoke('ai:topic:rename', topicId, title),
  deleteAiTopic: (topicId: number): Promise<ActionResult> => ipcRenderer.invoke('ai:topic:delete', topicId),
  listAiMessages: (topicId: number): Promise<AiMessagesResult> => ipcRenderer.invoke('ai:messages:list', topicId),
  appendAiMessage: (
    topicId: number,
    role: 'user' | 'assistant',
    content: string,
    chartJson?: string | null
  ): Promise<ActionResult> => ipcRenderer.invoke('ai:messages:append', topicId, role, content, chartJson ?? null),
  listGlobalAiTopics: (): Promise<AiTopicsResult> => ipcRenderer.invoke('ai:global:topics:list'),
  createGlobalAiTopic: (title: string): Promise<AiTopicCreateResult> =>
    ipcRenderer.invoke('ai:global:topic:create', title),
  renameGlobalAiTopic: (topicId: number, title: string): Promise<ActionResult> =>
    ipcRenderer.invoke('ai:global:topic:rename', topicId, title),
  deleteGlobalAiTopic: (topicId: number): Promise<ActionResult> => ipcRenderer.invoke('ai:global:topic:delete', topicId),
  listGlobalAiMessages: (topicId: number): Promise<AiMessagesResult> =>
    ipcRenderer.invoke('ai:global:messages:list', topicId),
  appendGlobalAiMessage: (
    topicId: number,
    role: 'user' | 'assistant',
    content: string,
    chartJson?: string | null
  ): Promise<ActionResult> =>
    ipcRenderer.invoke('ai:global:messages:append', topicId, role, content, chartJson ?? null),
  getGlobalAiCurrentTopicId: (): Promise<GlobalAiCurrentTopicResult> =>
    ipcRenderer.invoke('ai:global:current-topic:get'),
  setGlobalAiCurrentTopicId: (topicId: number | null): Promise<ActionResult> =>
    ipcRenderer.invoke('ai:global:current-topic:set', topicId),
  getGlobalAiLinkedProjectIds: (): Promise<GlobalAiLinkedProjectsResult> =>
    ipcRenderer.invoke('ai:global:linked-projects:get'),
  setGlobalAiLinkedProjectIds: (projectIds: number[]): Promise<ActionResult> =>
    ipcRenderer.invoke('ai:global:linked-projects:set', projectIds)
}

export type AppApi = typeof api
// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
