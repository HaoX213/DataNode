import { app, shell, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { join } from 'path'
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
  initDatabase,
  insertNoteItem,
  listItems,
  listNotebooks,
  listProjects,
  removeRelation,
  removeTagFromNode,
  getNodeEdges,
  searchItems,
  searchNodes,
  saveAppSettings,
  updateNodeDetail,
  updateNodePositions
} from './db'
import { importAssetFile, importDocxFile, importExcelFile } from './importer'
import { chatWithKnowledgeBase, summarizeNodeContext, type AiChatMessage } from './ai'

function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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
  initDatabase()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
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
    async (_, payload: { messages?: AiChatMessage[]; context_node_id?: number | null }) => {
      try {
        const answer = await chatWithKnowledgeBase(
          Array.isArray(payload?.messages) ? payload.messages : [],
          payload?.context_node_id ?? undefined
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
      filters: [{ name: '所有文件', extensions: ['*'] }]
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
    const ext = filePath.toLowerCase()

    try {
      if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
        return importExcelFile(filePath, Number(projectId))
      }
      if (ext.endsWith('.docx')) {
        return importDocxFile(filePath, Number(projectId))
      }
      return importAssetFile(filePath, title, Number(projectId))
    } catch (error) {
      return { success: false, message: `导入失败: ${String(error)}`, inserted: 0 }
    }
  })

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
