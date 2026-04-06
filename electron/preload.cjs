const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clarityAI', {
  getSettings: () => ipcRenderer.invoke('clarityai:get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('clarityai:save-settings', payload),
  enhanceImage: (payload) => ipcRenderer.invoke('clarityai:enhance-image', payload),
  saveImage: (payload) => ipcRenderer.invoke('clarityai:save-image', payload),
  onEnhancementStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('clarityai:enhancement-status', listener);

    return () => {
      ipcRenderer.removeListener('clarityai:enhancement-status', listener);
    };
  }
});