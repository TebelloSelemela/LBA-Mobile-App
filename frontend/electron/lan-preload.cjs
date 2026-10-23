const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lesbadLAN', {
  currentServer: () => ipcRenderer.invoke('lesbad:get-server'),
  connectServer: address => ipcRenderer.invoke('lesbad:set-server', address)
});
