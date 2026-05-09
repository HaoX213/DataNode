const { contextBridge, ipcRenderer } = require('electron')

const openDirectoryDialog = () => ipcRenderer.invoke('open-directory-dialog')

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectoryDialog
})

contextBridge.exposeInMainWorld('api', {
  openDirectoryDialog
})
