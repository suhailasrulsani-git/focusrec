// Bridge between the overlay window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  on: (channel, fn) => {
    const allowed = ['mouse', 'click', 'clear', 'draw-mode', 'countdown', 'highlight', 'tool', 'shot'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
