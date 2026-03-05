const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getPlatform: () => process.platform,
  getAppVersion: () => require('../package.json').version,
  openPath: (dirPath) => ipcRenderer.invoke('open-path', dirPath),
});
