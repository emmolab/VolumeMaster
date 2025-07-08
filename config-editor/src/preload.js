const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  openExeDialog: () => ipcRenderer.invoke('open-exe-dialog'),
  getAppIcon: (nameOrPath) => ipcRenderer.invoke('get-app-icon', nameOrPath),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  getComPort: () => ipcRenderer.invoke('get-com-port'),
  setComPort: (port) => ipcRenderer.invoke('set-com-port', port),
  saveAndRun: () => ipcRenderer.invoke('save-and-run'),
    onBackendStatus: (callback) => ipcRenderer.on('backend-status', (_, data) => callback(data)),
});



