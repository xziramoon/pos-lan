const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('amountApi', {
  get: () => ipcRenderer.invoke('fortune:amount-get'),
  set: (raw) => ipcRenderer.invoke('fortune:amount-set', raw),
  clear: () => ipcRenderer.invoke('fortune:amount-clear')
});
