const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  retry: () => ipcRenderer.invoke('runtime:retry'),
  chooseWorkspace: () => ipcRenderer.invoke('runtime:choose-workspace'),
  details: () => ipcRenderer.invoke('runtime:details'),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  }
});
