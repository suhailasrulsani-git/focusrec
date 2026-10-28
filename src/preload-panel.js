// Bridge between the private corner panel and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  fit: (w, h) => ipcRenderer.send('panel-fit', { w, h }),
  on: (channel, fn) => {
    const allowed = ['state', 'toast'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
