import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ActionResult,
  AiChatMessage,
  AiChatResult,
  AppSettings,
  AiSummaryResult,
  GraphDataResult,
  GraphFilterInput,
  ImportResult,
  ItemRow,
  NodeDetailResult,
  NodeEdgesResult,
  NodePositionInput,
  NodeSearchResultResponse,
  NotebookRow,
  PickImportFileResult,
  ProjectResult,
  ProjectsResult,
  SettingsResult,
  TagsResult
} from './index'

type DataNodeApi = {
  listNotebooks: () => Promise<NotebookRow[]>
  listProjects: () => Promise<ProjectsResult>
  createProject: (name: string) => Promise<ProjectResult>
  deleteProject: (projectId: number) => Promise<ActionResult>
  initializeStoragePath: (storagePath: string) => Promise<ActionResult>
  listItems: (projectId?: number) => Promise<ItemRow[]>
  searchItems: (keyword: string, projectId?: number) => Promise<ItemRow[]>
  openDirectoryDialog: () => Promise<string>
  getSettings: () => Promise<SettingsResult>
  saveSettings: (payload: AppSettings) => Promise<SettingsResult>
  getNodeDetail: (nodeId: number) => Promise<NodeDetailResult>
  searchNodes: (keyword: string, excludeId?: number, projectId?: number) => Promise<NodeSearchResultResponse>
  updateNodeDetail: (payload: { id: number; title: string; contentText: string; tags: string[] }) => Promise<ActionResult>
  openFile: (filePath: string) => Promise<ActionResult>
  createNote: (title: string, contentText: string, tags: string[], projectId?: number) => Promise<ActionResult>
  clearItems: (projectId?: number) => Promise<ActionResult>
  pickImportFile: () => Promise<PickImportFileResult>
  importFile: (filePath: string, title?: string, projectId?: number) => Promise<ImportResult>
  getAllTags: (projectId?: number) => Promise<TagsResult>
  getGraphData: (filters?: GraphFilterInput) => Promise<GraphDataResult>
  getLocalGraphData: (nodeId: number, depth?: number, projectId?: number) => Promise<GraphDataResult>
  getNodeEdges: (nodeId: number) => Promise<NodeEdgesResult>
  addTagToNode: (nodeId: number, tagName: string, color: string) => Promise<ActionResult>
  removeTagFromNode: (nodeId: number, tagId: number) => Promise<ActionResult>
  addRelation: (sourceId: number, targetId: number, label: string) => Promise<ActionResult>
  removeRelation: (relationId: number) => Promise<ActionResult>
  updateNodePositions: (positions: NodePositionInput[]) => Promise<ActionResult>
  summarizeNode: (nodeId: number) => Promise<AiSummaryResult>
  chatWithAi: (payload: { messages: AiChatMessage[]; context_node_id?: number | null }) => Promise<AiChatResult>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: DataNodeApi
  }
}
