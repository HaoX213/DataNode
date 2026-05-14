import { app, shell, BrowserWindow, dialog, ipcMain, clipboard, type OpenDialogOptions } from 'electron'
import { join, resolve } from 'path'
import { access } from 'node:fs/promises'
import { constants, mkdirSync } from 'node:fs'
import { appendLog } from './app-log'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  addRelation,
  addTagToNode,
  clearItemsForRetest,
  createProject,
  deleteProject,
  getDefaultNotebookId,
  getAllTags,
  getAppSettings,
  getGraphData,
  getLocalGraphData,
  getNodeDetail,
  getExcelStructuredRowsForStats,
  getMergedExcelStructuredRowsForProjects,
  initDatabase,
  insertNoteItem,
  insertStructuredJsonRows,
  listItems,
  listNotebooks,
  listProjects,
  getProjectUiState,
  saveProjectUiState,
  listAiTopics,
  createAiTopic,
  renameAiTopic,
  deleteAiTopic,
  listAiMessages,
  appendAiMessage,
  listGlobalAiTopics,
  createGlobalAiTopic,
  renameGlobalAiTopic,
  deleteGlobalAiTopic,
  listGlobalAiMessages,
  appendGlobalAiMessage,
  getGlobalAiCurrentTopicId,
  setGlobalAiCurrentTopicId,
  getGlobalAiLinkedProjectIds,
  setGlobalAiLinkedProjectIds,
  removeRelation,
  removeTagFromNode,
  getNodeEdges,
  searchItems,
  searchNodes,
  saveAppSettings,
  setStoragePath,
  updateNodeDetail,
  updateNodePositions
} from './db'
import type { ProjectUiStateV1 } from './db'
import {
  importAssetFile,
  importCsvFile,
  importDocxFile,
  importExcelFile,
  importJsonTableFile,
  readTextFilePreview
} from './importer'
import { chatWithKnowledgeBase, summarizeNodeContext, type AiChatMessage } from './ai'
import {
  statsAverage,
  statsCount,
  statsGroupBy,
  statsMax,
  statsMin,
  statsSum,
  statsUniqueValues,
  inferAllFields,
  inferNumericFields,
  type GroupAggregateType
} from './stats-engine'

function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const READ_FILE_ERROR_MESSAGE =
  '读取文件失败，请检查该文件是否正在被 Excel 等其他软件打开，或确认当前账号有权限访问该文件；也可以尝试将其移动到其他目录后重试。'

function formatImportError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
  if (['EACCES', 'EPERM', 'EBUSY', 'ENOENT'].includes(code)) {
    return READ_FILE_ERROR_MESSAGE
  }
  const message = error instanceof Error ? error.message : String(error)
  // SheetJS (xlsx) 在 Windows 上文件被占用/无权限时会抛出: "Cannot access file <path>"
  if (
    /EACCES|EPERM|EBUSY|ENOENT|permission|busy|locked|no such file|used by another process|cannot access file|cannot save file/i.test(
      message
    )
  ) {
    return READ_FILE_ERROR_MESSAGE
  }
  return `导入失败：${String(error)}`
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')
  appendLog('INFO', `Application ready (Electron ${process.versions.electron}, Node ${process.versions.node})`)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('app:initialize-storage', (_, storagePath: string) => {
    try {
      setStoragePath(storagePath)
      initDatabase()
      appendLog('INFO', `Storage initialized at ${storagePath.trim()}`)
      return { success: true, message: '存储路径初始化成功' }
    } catch (error) {
      const message = `存储路径初始化失败：${String(error)}`
      appendLog('ERROR', message)
      return { success: false, message }
    }
  })

  ipcMain.handle('app:get-data-paths', () => {
    const userData = app.getPath('userData')
    const logsDir = join(userData, 'logs')
    return {
      userData,
      logsDir,
      logFile: join(logsDir, 'datanode.log'),
      dbFile: join(userData, 'datanode.db')
    }
  })

  ipcMain.handle('app:open-user-data-folder', async () => {
    const userData = app.getPath('userData')
    const err = await shell.openPath(userData)
    if (err) return { success: false, message: err }
    return { success: true, message: '已打开数据目录' }
  })

  ipcMain.handle('app:open-logs-folder', async () => {
    const logsDir = join(app.getPath('userData'), 'logs')
    try {
      mkdirSync(logsDir, { recursive: true })
    } catch (error) {
      return { success: false, message: `无法创建日志目录：${String(error)}` }
    }
    const err = await shell.openPath(logsDir)
    if (err) return { success: false, message: err }
    return { success: true, message: '已打开日志目录' }
  })

  ipcMain.handle('app:copy-text', (_, text: string) => {
    try {
      clipboard.writeText(text ?? '')
      return { success: true, message: '已复制到剪贴板' }
    } catch (error) {
      return { success: false, message: `复制失败：${String(error)}` }
    }
  })

  ipcMain.handle('db:notebooks:list', () => listNotebooks())
  ipcMain.handle('projects:list', () => {
    try {
      return { success: true, data: toSerializable(listProjects()) }
    } catch (error) {
      return { success: false, message: `获取项目失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('projects:create', (_, name: string) => {
    try {
      return { success: true, data: toSerializable(createProject(name)), message: '项目创建成功' }
    } catch (error) {
      return { success: false, message: `创建项目失败: ${String(error)}` }
    }
  })
  ipcMain.handle('projects:delete', (_, projectId: number) => {
    try {
      deleteProject(Number(projectId))
      return { success: true, message: '项目已删除' }
    } catch (error) {
      return { success: false, message: `删除项目失败: ${String(error)}` }
    }
  })
  ipcMain.handle('project:ui:get', (_, projectId: number) => {
    try {
      return { success: true, data: toSerializable(getProjectUiState(Number(projectId))) }
    } catch (error) {
      return { success: false, message: `读取项目界面状态失败: ${String(error)}` }
    }
  })
  ipcMain.handle('project:ui:save', (_, projectId: number, state: ProjectUiStateV1) => {
    try {
      saveProjectUiState(Number(projectId), state as ProjectUiStateV1)
      return { success: true, message: '已保存' }
    } catch (error) {
      return { success: false, message: `保存项目界面状态失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:topics:list', (_, projectId: number) => {
    try {
      return { success: true, data: toSerializable(listAiTopics(Number(projectId))) }
    } catch (error) {
      return { success: false, message: `读取分支失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('ai:topic:create', (_, projectId: number, title: string) => {
    try {
      const id = createAiTopic(Number(projectId), String(title ?? ''))
      return { success: true, data: { id }, message: '分支已创建' }
    } catch (error) {
      return { success: false, message: `创建分支失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:topic:rename', (_, topicId: number, title: string) => {
    try {
      renameAiTopic(Number(topicId), String(title ?? ''))
      return { success: true, message: '已重命名' }
    } catch (error) {
      return { success: false, message: `重命名失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:topic:delete', (_, topicId: number) => {
    try {
      deleteAiTopic(Number(topicId))
      return { success: true, message: '已删除' }
    } catch (error) {
      return { success: false, message: `删除分支失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:messages:list', (_, topicId: number) => {
    try {
      return { success: true, data: toSerializable(listAiMessages(Number(topicId))) }
    } catch (error) {
      return { success: false, message: `读取消息失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle(
    'ai:messages:append',
    (_, topicId: number, role: string, content: string, chartJson?: string | null) => {
      try {
        const safeRole = role === 'assistant' ? 'assistant' : 'user'
        appendAiMessage(Number(topicId), safeRole, String(content ?? ''), chartJson ?? null)
        return { success: true, message: '已写入' }
      } catch (error) {
        return { success: false, message: `写入消息失败: ${String(error)}` }
      }
    }
  )
  ipcMain.handle('ai:global:topics:list', () => {
    try {
      return { success: true, data: toSerializable(listGlobalAiTopics()) }
    } catch (error) {
      return { success: false, message: `读取全局分支失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('ai:global:topic:create', (_, title: string) => {
    try {
      const id = createGlobalAiTopic(String(title ?? ''))
      return { success: true, data: { id }, message: '分支已创建' }
    } catch (error) {
      return { success: false, message: `创建全局分支失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:global:topic:rename', (_, topicId: number, title: string) => {
    try {
      renameGlobalAiTopic(Number(topicId), String(title ?? ''))
      return { success: true, message: '已重命名' }
    } catch (error) {
      return { success: false, message: `重命名失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:global:topic:delete', (_, topicId: number) => {
    try {
      deleteGlobalAiTopic(Number(topicId))
      return { success: true, message: '已删除' }
    } catch (error) {
      return { success: false, message: `删除失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:global:messages:list', (_, topicId: number) => {
    try {
      return { success: true, data: toSerializable(listGlobalAiMessages(Number(topicId))) }
    } catch (error) {
      return { success: false, message: `读取全局消息失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle(
    'ai:global:messages:append',
    (_, topicId: number, role: string, content: string, chartJson?: string | null) => {
      try {
        const safeRole = role === 'assistant' ? 'assistant' : 'user'
        appendGlobalAiMessage(Number(topicId), safeRole, String(content ?? ''), chartJson ?? null)
        return { success: true, message: '已写入' }
      } catch (error) {
        return { success: false, message: `写入消息失败: ${String(error)}` }
      }
    }
  )
  ipcMain.handle('ai:global:current-topic:get', () => {
    try {
      return { success: true, data: getGlobalAiCurrentTopicId() }
    } catch (error) {
      return { success: false, message: `读取失败: ${String(error)}`, data: null }
    }
  })
  ipcMain.handle('ai:global:current-topic:set', (_, topicId: number | null) => {
    try {
      if (topicId != null && Number.isFinite(Number(topicId))) {
        setGlobalAiCurrentTopicId(Number(topicId))
      } else {
        setGlobalAiCurrentTopicId(null)
      }
      return { success: true, message: '已保存' }
    } catch (error) {
      return { success: false, message: `保存失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:global:linked-projects:get', () => {
    try {
      return { success: true, data: getGlobalAiLinkedProjectIds() }
    } catch (error) {
      return { success: false, message: `读取失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('ai:global:linked-projects:set', (_, projectIds: number[]) => {
    try {
      const ids = Array.isArray(projectIds)
        ? [...new Set(projectIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
        : []
      setGlobalAiLinkedProjectIds(ids)
      return { success: true, message: '已保存', data: ids }
    } catch (error) {
      return { success: false, message: `保存失败: ${String(error)}` }
    }
  })
  ipcMain.handle('db:items:list', (_, projectId?: number) => listItems(Number(projectId)))
  ipcMain.handle('db:items:search', (_, keyword: string, projectId?: number) => searchItems(keyword ?? '', Number(projectId)))
  ipcMain.handle('settings:get', () => {
    try {
      return { success: true, data: toSerializable(getAppSettings()) }
    } catch (error) {
      return {
        success: false,
        message: `读取设置失败: ${String(error)}`,
        data: getAppSettings()
      }
    }
  })
  ipcMain.handle('open-directory-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      title: '选择本地文件存储路径',
      properties: ['openDirectory', 'createDirectory']
    }
    const picked = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options)

    if (picked.canceled || picked.filePaths.length === 0) return ''
    return picked.filePaths[0]
  })
  ipcMain.handle(
    'settings:save',
    (_, payload: {
      ai_api_key?: string
      ai_base_url?: string
      ai_model_name?: string
      ai_system_prompt?: string
      ai_temperature?: string | number
      graph_node_size?: string | number
      graph_edge_length?: string | number
      graph_repulsion?: string | number
      app_theme?: string
      app_language?: string
    }) => {
      try {
        const settings = saveAppSettings({
          ai_api_key: payload?.ai_api_key ?? '',
          ai_base_url: payload?.ai_base_url ?? '',
          ai_model_name: payload?.ai_model_name ?? '',
          ai_system_prompt: payload?.ai_system_prompt ?? '',
          ai_temperature: payload?.ai_temperature ?? '',
          graph_node_size: payload?.graph_node_size ?? '',
          graph_edge_length: payload?.graph_edge_length ?? '',
          graph_repulsion: payload?.graph_repulsion ?? '',
          app_theme: payload?.app_theme ?? '',
          app_language: payload?.app_language ?? ''
        })
        return { success: true, message: '设置保存成功', data: toSerializable(settings) }
      } catch (error) {
        return { success: false, message: `保存设置失败: ${String(error)}` }
      }
    }
  )
  ipcMain.handle('db:items:get-detail', (_, nodeId: number) => {
    try {
      return { success: true, data: getNodeDetail(nodeId) }
    } catch (error) {
      return { success: false, message: `获取节点详情失败: ${String(error)}` }
    }
  })
  ipcMain.handle('db:items:update-detail', (_, payload: { id: number; title: string; contentText: string; tags: string[] }) => {
    try {
      updateNodeDetail({
        id: Number(payload?.id),
        title: payload?.title ?? '',
        contentText: payload?.contentText ?? '',
        tags: Array.isArray(payload?.tags) ? payload.tags : []
      })
      return { success: true, message: '节点已保存' }
    } catch (error) {
      return { success: false, message: `保存节点失败: ${String(error)}` }
    }
  })
  ipcMain.handle('db:items:open-file', async (_, filePath: string) => {
    try {
      if (!filePath) return { success: false, message: '文件路径为空' }
      const errorMessage = await shell.openPath(filePath)
      if (errorMessage) return { success: false, message: errorMessage }
      return { success: true, message: '文件已打开' }
    } catch (error) {
      return { success: false, message: `打开文件失败: ${String(error)}` }
    }
  })
  ipcMain.handle('db:items:search-nodes', (_, keyword: string, excludeId?: number, projectId?: number) => {
    try {
      return { success: true, data: searchNodes(keyword ?? '', excludeId, Number(projectId)) }
    } catch (error) {
      return { success: false, message: `搜索节点失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('graph:get-node-edges', (_, nodeId: number) => {
    try {
      return { success: true, data: toSerializable(getNodeEdges(nodeId)) }
    } catch (error) {
      return { success: false, message: `获取关联失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('db:items:create-note', (_, title: string, contentText: string, tags: string[] = [], projectId?: number) => {
    try {
      const text = (contentText ?? '').trim()
      const noteTitle = (title ?? '').trim()
      if (!text) {
        return { success: false, message: '笔记内容不能为空' }
      }
      const notebookId = getDefaultNotebookId()
      const noteId = insertNoteItem({
        notebookId,
        projectId: Number(projectId),
        title: noteTitle,
        contentText: text,
        tags: Array.isArray(tags) ? tags : []
      })
      return { success: true, message: '笔记创建成功', data: { id: noteId } }
    } catch (error) {
      return { success: false, message: `笔记创建失败: ${String(error)}` }
    }
  })
  ipcMain.handle('db:items:clear', (_, projectId?: number) => {
    clearItemsForRetest(Number(projectId))
    return { success: true, message: '已清空 items 测试数据' }
  })
  ipcMain.handle('graph:get-all-tags', (_, projectId?: number) => {
    try {
      return { success: true, data: toSerializable(getAllTags(Number(projectId))) }
    } catch (error) {
      return { success: false, message: `获取标签失败: ${String(error)}`, data: [] }
    }
  })
  ipcMain.handle('graph:add-tag-to-node', (_, nodeId: number, tagName: string, color: string) => {
    try {
      const tag = addTagToNode(nodeId, tagName, color)
      return { success: true, data: toSerializable(tag), message: '标签绑定成功' }
    } catch (error) {
      return { success: false, message: `标签绑定失败: ${String(error)}` }
    }
  })
  ipcMain.handle('graph:remove-tag-from-node', (_, nodeId: number, tagId: number) => {
    try {
      removeTagFromNode(nodeId, tagId)
      return { success: true, message: '标签移除成功' }
    } catch (error) {
      return { success: false, message: `标签移除失败: ${String(error)}` }
    }
  })
  ipcMain.handle('graph:add-relation', (_, sourceId: number, targetId: number, label: string) => {
    try {
      const relationId = addRelation(sourceId, targetId, label)
      return { success: true, data: { id: relationId }, message: '关系创建成功' }
    } catch (error) {
      return { success: false, message: `关系创建失败: ${String(error)}` }
    }
  })
  ipcMain.handle('graph:remove-relation', (_, relationId: number) => {
    try {
      removeRelation(relationId)
      return { success: true, message: '关系删除成功' }
    } catch (error) {
      return { success: false, message: `关系删除失败: ${String(error)}` }
    }
  })
  ipcMain.handle('graph:get-graph-data', (_, filters?: { types?: string[]; tags?: string[]; projectId?: number }) => {
    try {
      // 返回前端知识图谱可视化所需的标准 nodes/edges 结构
      return { success: true, data: toSerializable(getGraphData(filters ?? {})) }
    } catch (error) {
      return {
        success: false,
        message: `图谱数据获取失败: ${String(error)}`,
        data: { nodes: [], edges: [] }
      }
    }
  })
  ipcMain.handle('graph:get-local-graph-data', (_, nodeId: number, depth = 1, projectId?: number) => {
    try {
      return { success: true, data: toSerializable(getLocalGraphData(Number(nodeId), Number(depth), Number(projectId))) }
    } catch (error) {
      return {
        success: false,
        message: `局部图谱获取失败: ${String(error)}`,
        data: { nodes: [], edges: [] }
      }
    }
  })
  ipcMain.handle('graph:update-node-positions', (_, positions: Array<{ id: number; x: number; y: number }>) => {
    try {
      const updated = updateNodePositions(Array.isArray(positions) ? positions : [])
      return { success: true, message: '布局保存成功', data: { updated } }
    } catch (error) {
      return { success: false, message: `布局保存失败: ${String(error)}` }
    }
  })
  ipcMain.handle('ai:summarize-node', async (_, nodeId: number) => {
    try {
      const summary = await summarizeNodeContext(Number(nodeId))
      return { success: true, message: 'AI 总结生成成功', data: { summary } }
    } catch (error) {
      return { success: false, message: `AI 总结失败: ${String(error)}`, data: { summary: '' } }
    }
  })
  ipcMain.handle(
    'ai:chat',
    async (
      _,
      payload: {
        messages?: AiChatMessage[]
        context_node_id?: number | null
        project_id?: number | null
        global_ai?: boolean
        linked_project_ids?: number[]
        raw_file_preview?: string
        raw_file_path?: string
      }
    ) => {
      try {
        const rawLinked = payload?.linked_project_ids
        const linkedProjectIds = Array.isArray(rawLinked)
          ? [...new Set(rawLinked.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
          : []
        const answer = await chatWithKnowledgeBase(
          Array.isArray(payload?.messages) ? payload.messages : [],
          payload?.context_node_id ?? undefined,
          {
            projectId: payload?.project_id,
            globalAi: Boolean(payload?.global_ai),
            linkedProjectIds: linkedProjectIds.length ? linkedProjectIds : undefined,
            rawFilePreview: payload?.raw_file_preview,
            rawFilePath: payload?.raw_file_path
          }
        )
        return { success: true, message: 'AI 回复成功', data: { answer } }
      } catch (error) {
        return { success: false, message: `AI 对话失败: ${String(error)}`, data: { answer: '' } }
      }
    }
  )
  ipcMain.handle('db:items:pick-import-file', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      title: '选择要导入的文件',
      properties: ['openFile'],
      filters: [
        { name: '表格与文档', extensions: ['xlsx', 'xls', 'csv', 'json', 'txt', 'docx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const picked = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options)

    if (picked.canceled || picked.filePaths.length === 0) {
      return { success: false, message: '已取消导入' }
    }

    return { success: true, filePath: picked.filePaths[0] }
  })
  ipcMain.handle('db:items:import', async (_, filePath: string, title = '', projectId?: number) => {
    if (!filePath) {
      return { success: false, message: '未选择文件', inserted: 0 }
    }
    const extLabel = /\.xlsx$/i.test(filePath)
      ? '.xlsx'
      : /\.xls$/i.test(filePath)
        ? '.xls'
        : /\.docx$/i.test(filePath)
          ? '.docx'
          : 'other'
    appendLog('INFO', `Import started: ${filePath} (${extLabel}) projectId=${projectId ?? 'default'}`)
    const resolvedSource = resolve(filePath)
    try {
      await access(resolvedSource, constants.R_OK)
    } catch (error) {
      const message = formatImportError(error)
      appendLog('ERROR', `Import read check failed: ${filePath} — ${message}`)
      return { success: false, message, inserted: 0 }
    }

    const ext = resolvedSource.toLowerCase()
    try {
      if (ext.endsWith('.txt')) {
        const { text } = await readTextFilePreview(resolvedSource, 120000)
        return {
          success: true,
          message:
            '文本已载入。该格式需要结合 AI 解析字段结构；请在打开的 AI 助手中说明列含义或拆分规则，并可使用「应用 JSON 入库」。',
          inserted: 0,
          mode: 'ai_text',
          preview: text,
          filePath: resolvedSource
        }
      }
      if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
        return await importExcelFile(resolvedSource, Number(projectId))
      }
      if (ext.endsWith('.csv')) {
        return await importCsvFile(resolvedSource, Number(projectId))
      }
      if (ext.endsWith('.json')) {
        return await importJsonTableFile(resolvedSource, Number(projectId))
      }
      if (ext.endsWith('.docx')) {
        return await importDocxFile(resolvedSource, Number(projectId))
      }
      return await importAssetFile(resolvedSource, title, Number(projectId))
    } catch (error) {
      const message = formatImportError(error)
      appendLog('ERROR', `Import failed: ${resolvedSource} — ${message}`)
      return { success: false, message, inserted: 0 }
    }
  })

  ipcMain.handle('db:items:import-json-array', (_, payload: { projectId?: number; rows: Record<string, unknown>[]; sourceFilePath?: string }) => {
    try {
      const rows = Array.isArray(payload?.rows) ? payload.rows : []
      const n = insertStructuredJsonRows({
        projectId: Number(payload?.projectId),
        sourceFilePath: payload?.sourceFilePath?.trim() || 'ai-structured.json',
        rows
      })
      return { success: true, message: `已写入 ${n} 行`, inserted: n }
    } catch (error) {
      return { success: false, message: String(error), inserted: 0 }
    }
  })

  ipcMain.handle(
    'stats:query',
    (
      _,
      payload: {
        op?: string
        projectId?: number | null
        /** 多项目合并统计（优先于单 projectId） */
        projectIds?: number[] | null
        field?: string
        groupField?: string
        aggregateField?: string
        aggregateType?: string
        limit?: number
      }
    ) => {
      try {
        const op = payload?.op ?? ''
        const pid = Number(payload?.projectId)
        const projectId = Number.isFinite(pid) ? pid : undefined
        const rawMulti = payload?.projectIds
        const multiIds =
          Array.isArray(rawMulti) && rawMulti.length > 0
            ? [...new Set(rawMulti.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
            : null
        const rows =
          multiIds && multiIds.length > 0
            ? getMergedExcelStructuredRowsForProjects(multiIds, 100000)
            : getExcelStructuredRowsForStats(projectId, 100000)

        if (op === 'count') {
          return { success: true, data: { value: statsCount(rows) } }
        }
        if (op === 'sum') {
          return { success: true, data: { value: statsSum(rows, String(payload.field ?? '')) } }
        }
        if (op === 'average') {
          const v = statsAverage(rows, String(payload.field ?? ''))
          return { success: true, data: { value: v } }
        }
        if (op === 'max') {
          return { success: true, data: { value: statsMax(rows, String(payload.field ?? '')) } }
        }
        if (op === 'min') {
          return { success: true, data: { value: statsMin(rows, String(payload.field ?? '')) } }
        }
        if (op === 'uniqueValues') {
          return {
            success: true,
            data: {
              entries: statsUniqueValues(rows, String(payload.field ?? ''), Math.min(payload?.limit ?? 200, 500))
            }
          }
        }
        if (op === 'groupBy') {
          let raw = String(payload.aggregateType ?? 'sum').toLowerCase()
          if (raw === 'average') raw = 'avg'
          const safeAgg: GroupAggregateType = raw === 'count' ? 'count' : raw === 'avg' ? 'avg' : 'sum'
          return {
            success: true,
            data: {
              groups: statsGroupBy(
                rows,
                String(payload.groupField ?? ''),
                String(payload.aggregateField ?? ''),
                safeAgg
              )
            }
          }
        }
        if (op === 'fields') {
          return {
            success: true,
            data: {
              numericFields: inferNumericFields(rows),
              allFields: inferAllFields(rows),
              rowCount: statsCount(rows)
            }
          }
        }
        return { success: false, message: `未知统计操作: ${op}` }
      } catch (error) {
        return { success: false, message: String(error) }
      }
    }
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
