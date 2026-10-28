// Bridge between the control window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusrec', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: (file) => ipcRenderer.invoke('open-folder', file),

  prepare: (displayId) => ipcRenderer.invoke('prepare', displayId),
  showOverlay: () => ipcRenderer.invoke('overlay-show'),
  countdown: (n) => ipcRenderer.send('overlay-countdown', n),
  setHighlight: (on) => ipcRenderer.send('overlay-highlight', on),
  setTool: (tool) => ipcRenderer.send('overlay-tool', tool),
  setDrawMode: (on) => ipcRenderer.send('draw-mode', on),
  clearDrawing: () => ipcRenderer.send('clear-draw'),
  recordingStarted: () => ipcRenderer.invoke('recording-started'),
  recordingStopped: () => ipcRenderer.invoke('recording-stopped'),
  hudState: (s) => ipcRenderer.send('hud-state', s),

  fileOpen: (ext) => ipcRenderer.invoke('file-open', ext),
  fileChunk: (buf) => ipcRenderer.invoke('file-chunk', buf),
  fileClose: () => ipcRenderer.invoke('file-close'),
  fileAbort: () => ipcRenderer.invoke('file-abort'),

  grabScreen: () => ipcRenderer.invoke('grab-screen'),
  saveShot: (shot) => ipcRenderer.invoke('save-shot', shot),
  guideInfo: () => ipcRenderer.invoke('guide-info'),
  guideNew: () => ipcRenderer.invoke('guide-new'),
  guideOpen: (what) => ipcRenderer.invoke('guide-open', what),

  setHotkey: (action, key) => ipcRenderer.invoke('set-hotkey', { action, key }),
  resetHotkeys: () => ipcRenderer.invoke('reset-hotkeys'),
  pauseHotkeys: () => ipcRenderer.send('hotkeys-pause'),
  resumeHotkeys: () => ipcRenderer.send('hotkeys-resume'),

  fitHeight: (h) => ipcRenderer.send('window-fit', h),
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),

  on: (channel, fn) => {
    const allowed = ['mouse', 'action', 'status', 'draw-mode', 'panel-visible'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
