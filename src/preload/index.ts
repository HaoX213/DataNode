import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export type NotebookRow = {
  id: number
  name: string
  created_at: string
}

export type ItemRow = {
  id: number
  project_id: number | null
  type: 'note' | 'excel_row' | 'document' | 'file'
  title: string
  content_text: string
  content_json: string
  source_file_path: string
  created_at: string
}

export type ImportResult = {
  success: boolean
  message: string
  inserted: number
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
  openFile: (filePath: string): Promise<ActionResult> => ipcRenderer.invoke('db:items:open-file', filePath),
  createNote: (title: string, contentText: string, tags: string[], projectId?: number): Promise<ActionResult> =>
    ipcRenderer.invoke('db:items:create-note', title, contentText, tags, projectId),
  clearItems: (projectId?: number): Promise<ActionResult> => ipcRenderer.invoke('db:items:clear', projectId),
  pickImportFile: (): Promise<PickImportFileResult> => ipcRenderer.invoke('db:items:pick-import-file'),
  importFile: (filePath: string, title?: string, projectId?: number): Promise<ImportResult> =>
    ipcRenderer.invoke('db:items:import', filePath, title, projectId),
  getAllTags: (projectId?: number): Promise<TagsResult> => ipcRenderer.invoke('graph:get-all-tags', projectId),
  getGraphData: (filters?: GraphFilterInput): Promise<GraphDataResult> =>
    ipcRenderer.invoke('graph:get-graph-data', filters),
  getLocalGraphData: (nodeId: number, depth?: number, projectId?: number): Promise<GraphDataResult> =>
    ipcRenderer.invoke('graph:get-local-graph-data', nodeId, depth, projectId),
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
  chatWithAi: (payload: { messages: AiChatMessage[]; context_node_id?: number | null }): Promise<AiChatResult> =>
    ipcRenderer.invoke('ai:chat', payload)
}

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
