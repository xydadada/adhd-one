const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, handler) => {
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('adhdOne', Object.freeze({
  getAppSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openKnownPath: kind => ipcRenderer.invoke('path:open', kind),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart'),
  checkUpdates: target => ipcRenderer.invoke('update:check', target),
  confirmUpdate: target => ipcRenderer.invoke('update:confirm', target),
  runDoctor: mode => ipcRenderer.invoke('doctor:run', mode),
  cancelDoctor: () => ipcRenderer.invoke('doctor:cancel'),
  copyDoctorReport: () => ipcRenderer.invoke('doctor:copy'),
  onRuntimeChanged: handler => on('runtime:changed', handler),
  onUpdateChanged: handler => on('update:changed', handler),
  onDoctorProgress: handler => on('doctor:progress', handler),
  onNavigate: handler => on('control:navigate', handler)
}));
