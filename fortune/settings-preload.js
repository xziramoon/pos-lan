const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fortuneApi', {
  get: () => ipcRenderer.invoke('fortune:get'),
  set: (patch) => ipcRenderer.invoke('fortune:set', patch),
  test: () => ipcRenderer.invoke('fortune:test'),
  printers: () => ipcRenderer.invoke('fortune:printers'),
  couponCheck: (code) => ipcRenderer.invoke('fortune:coupon-check', code),
  couponUse: (code) => ipcRenderer.invoke('fortune:coupon-use', code)
});
