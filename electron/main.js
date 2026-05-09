const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('node:path')

try {
  require('../out/main/index.js')
} catch {
  const createWindow = () => {
    const mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    } else {
      mainWindow.loadFile(path.join(__dirname, '../out/renderer/index.html'))
    }
  }

  ipcMain.handle('open-directory-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options = {
      title: '选择本地文件存储路径',
      properties: ['openDirectory', 'createDirectory']
    }
    const picked = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options)

    if (picked.canceled || picked.filePaths.length === 0) return ''
    return picked.filePaths[0]
  })

  app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
