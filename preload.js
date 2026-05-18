const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docgen', {
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_, s) => cb(s)),
  getClaudeStatus: () => ipcRenderer.invoke('get-claude-status'),
  refreshClaudeStatus: () => ipcRenderer.invoke('refresh-claude-status'),
});
