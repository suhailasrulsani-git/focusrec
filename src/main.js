// FocusRec - main process.
// Owns the windows, global hotkeys, mouse tracking, screenshots and writing files to disk.

const { app, BrowserWindow, Menu, ipcMain, globalShortcut, screen, desktopCapturer, session, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { fixMp4 } = require('./mp4fix');
const guide = require('./guide');
const { foregroundApp } = require('./activeapp');

let controlWin = null;
let overlayWin = null;
let panelWin = null;
let mouseTimer = null;
let appTimer = null;
let hook = null;          // uiohook-napi, loaded on first use
let hookStarted = false;
let lastApp = null;       // last app in front that is not FocusRec (for screenshot captions)

const state = {
  displayId: null,        // screen being recorded
  recording: false,
  drawMode: false,
};

// ---------- settings (small JSON file in the user profile) ----------

const HOTKEY_DEFAULTS = {
  'toggle-record': 'Alt+Shift+R',
  'toggle-pause': 'Alt+Shift+P',
  'toggle-zoom': 'Alt+Shift+Z',
  'zoom-more': 'Alt+Shift+Up',
  'zoom-less': 'Alt+Shift+Down',
  'toggle-draw': 'Alt+Shift+D',
  'clear-draw': 'Alt+Shift+C',
  'toggle-highlight': 'Alt+Shift+H',
  'screenshot': 'Alt+Shift+S',
  'toggle-panel': 'Alt+Shift+K',
};
// These work all the time. The rest only while recording.
const ALWAYS_ON = ['toggle-record', 'screenshot'];

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = () => ({
  outputDir: path.join(app.getPath('videos'), 'FocusRec'),
  micId: 'default',
  systemAudio: true,
  highlight: true,
  countdown: true,
  zoomLevel: 2,
  hotkeys: { ...HOTKEY_DEFAULTS },
  panelVisible: true,
  panelCorner: 'top-right',
  currentGuide: null,
});

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...defaultSettings(), ...saved, hotkeys: { ...HOTKEY_DEFAULTS, ...(saved.hotkeys || {}) } };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch { /* settings are a convenience only */ }
}

let settings = null;

// ---------- windows ----------

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 380,
    height: 560,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'FocusRec',
    backgroundColor: '#F5F7FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      backgroundThrottling: false,   // keep recording smooth when minimised
    },
  });
  controlWin.setAlwaysOnTop(true, 'screen-saver');
  // Hide this window from the recording itself.
  controlWin.setContentProtection(true);
  controlWin.loadFile(path.join(__dirname, 'control.html'));
  controlWin.on('closed', () => { controlWin = null; app.quit(); });
}

function selectedDisplay() {
  const all = screen.getAllDisplays();
  return all.find(d => d.id === state.displayId) || screen.getPrimaryDisplay();
}

function createOverlay() {
  const d = selectedDisplay();
  overlayWin = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      backgroundThrottling: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.on('closed', () => { overlayWin = null; });
  return new Promise((resolve) => {
    overlayWin.once('ready-to-show', () => {
      overlayWin.showInactive();
      // Keep the panel and control bar above the overlay so they stay visible / clickable in draw mode.
      if (panelWin) panelWin.moveTop();
      if (controlWin) controlWin.moveTop();
      resolve();
    });
    overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  });
}

function closeOverlay() {
  if (overlayWin) overlayWin.destroy();
  overlayWin = null;
}

const sendControl = (ch, data) => controlWin && controlWin.webContents.send(ch, data);
const sendOverlay = (ch, data) => overlayWin && overlayWin.webContents.send(ch, data);

// ---------- private corner panel (hidden from capture, only you see it) ----------

let panelState = {};
let panelSize = { w: 240, h: 100 };
let toastUntil = 0;
let toastTimer = null;

function createPanel() {
  panelWin = new BrowserWindow({
    width: 240,
    height: 100,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.js'),
      backgroundThrottling: false,
    },
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.setIgnoreMouseEvents(true);
  panelWin.setContentProtection(true);
  panelWin.loadFile(path.join(__dirname, 'panel.html'));
  panelWin.on('closed', () => { panelWin = null; });
}

function placePanel() {
  if (!panelWin) return;
  const d = state.recording ? selectedDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  const margin = 16;
  const w = Math.max(1, Math.ceil(panelSize.w));
  const h = Math.max(1, Math.ceil(panelSize.h));
  const x = settings.panelCorner.endsWith('left') ? wa.x + margin : wa.x + wa.width - w - margin;
  const y = settings.panelCorner.startsWith('top') ? wa.y + margin : wa.y + wa.height - h - margin;
  panelWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

function updatePanel() {
  if (!panelWin) return;
  const showBox = state.recording && settings.panelVisible;
  panelWin.webContents.send('state', { ...panelState, showBox, hotkeys: settings.hotkeys });
  const visible = showBox || Date.now() < toastUntil;
  if (visible && !panelWin.isVisible()) {
    placePanel();
    panelWin.showInactive();
    if (controlWin) controlWin.moveTop();
  } else if (!visible && panelWin.isVisible()) {
    panelWin.hide();
  }
}

function panelToast(text) {
  if (!panelWin) return;
  toastUntil = Date.now() + 2100;
  panelWin.webContents.send('toast', text);
  updatePanel();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(updatePanel, 2200);
}

ipcMain.on('panel-fit', (_e, size) => {
  panelSize = size;
  placePanel();
});

ipcMain.on('hud-state', (_e, s) => {
  panelState = s;
  updatePanel();
});

// ---------- mouse: position (polled) and clicks (uiohook) ----------

function startMouseTracking() {
  const d = selectedDisplay();
  const b = d.bounds;
  mouseTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const msg = {
      x: p.x - b.x,                    // pixels inside the screen (for the overlay)
      y: p.y - b.y,
      nx: (p.x - b.x) / b.width,       // 0..1 across the screen (for zoom)
      ny: (p.y - b.y) / b.height,
      inside: p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height,
    };
    sendOverlay('mouse', msg);
    sendControl('mouse', msg);
  }, 16);

  try {
    if (!hook) hook = require('uiohook-napi').uIOhook;
    hook.removeAllListeners('mousedown');
    hook.on('mousedown', (e) => {
      const p = screen.getCursorScreenPoint();
      sendOverlay('click', { x: p.x - b.x, y: p.y - b.y, button: e.button });
    });
    hook.start();
    hookStarted = true;
  } catch (err) {
    sendControl('status', 'Click highlight not available: ' + err.message);
  }
}

function stopMouseTracking() {
  clearInterval(mouseTimer);
  mouseTimer = null;
  if (hook && hookStarted) {
    try { hook.stop(); } catch { /* already stopped */ }
    hookStarted = false;
  }
}

// ---------- hotkeys (set by the user, saved in settings) ----------

let registered = [];      // keys we registered (Escape for draw mode is handled on its own)
let hotkeysPaused = false;

function applyHotkeys() {
  for (const key of registered) globalShortcut.unregister(key);
  registered = [];
  if (hotkeysPaused) return;
  const failed = [];
  for (const [action, key] of Object.entries(settings.hotkeys)) {
    if (!key || (!state.recording && !ALWAYS_ON.includes(action))) continue;
    let ok = false;
    try { ok = globalShortcut.register(key, () => handleAction(action)); } catch { ok = false; }
    if (ok) registered.push(key);
    else failed.push(key);
  }
  if (failed.length) sendControl('status', 'Hotkey in use by another app: ' + failed.join(', '));
}

function handleAction(action) {
  switch (action) {
    case 'toggle-draw':
      setDrawMode(!state.drawMode);
      break;
    case 'exit-draw':
      setDrawMode(false);
      break;
    case 'clear-draw':
      sendOverlay('clear');
      break;
    case 'toggle-panel':
      settings.panelVisible = !settings.panelVisible;
      saveSettings(settings);
      updatePanel();
      sendControl('panel-visible', settings.panelVisible);
      break;
    default:
      // record / pause / zoom / highlight / screenshot are handled in the control window
      sendControl('action', action);
  }
}

function setDrawMode(on) {
  if (!overlayWin) on = false;
  state.drawMode = on;
  if (overlayWin) {
    // Draw mode: overlay catches the mouse. Normal: clicks pass through to your apps.
    overlayWin.setIgnoreMouseEvents(!on);
    sendOverlay('draw-mode', on);
  }
  if (on) globalShortcut.register('Escape', () => handleAction('exit-draw'));
  else globalShortcut.unregister('Escape');
  if (controlWin) controlWin.moveTop();
  sendControl('draw-mode', on);
}

// Pause all hotkeys while the user is typing a new one in the Hotkeys tab.
ipcMain.on('hotkeys-pause', () => { hotkeysPaused = true; applyHotkeys(); });
ipcMain.on('hotkeys-resume', () => { hotkeysPaused = false; applyHotkeys(); });

// Save one hotkey. The control window already checked it is not used twice inside FocusRec.
ipcMain.handle('set-hotkey', (_e, { action, key }) => {
  if (!(action in HOTKEY_DEFAULTS)) return { ok: false, error: 'Unknown action' };
  if (key) {
    let free = false;
    try {
      free = globalShortcut.register(key, () => {});
    } catch {
      return { ok: false, error: `${key} is not a key FocusRec can use` };
    }
    if (!free) return { ok: false, error: `${key} is taken by another app or by Windows` };
    globalShortcut.unregister(key);
  }
  settings.hotkeys = { ...settings.hotkeys, [action]: key || '' };
  saveSettings(settings);
  updatePanel();
  return { ok: true, hotkeys: settings.hotkeys };
});

ipcMain.handle('reset-hotkeys', () => {
  settings.hotkeys = { ...HOTKEY_DEFAULTS };
  saveSettings(settings);
  applyHotkeys();
  updatePanel();
  return settings.hotkeys;
});

// ---------- IPC from the control window ----------

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('set-settings', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  if ('panelCorner' in patch) placePanel();
  if ('panelVisible' in patch) updatePanel();
  return settings;
});

ipcMain.handle('get-displays', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Screen ${i + 1} - ${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}` +
      (d.id === primary ? ' (main)' : ''),
  }));
});

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(controlWin, {
    title: 'Save recordings to',
    defaultPath: settings.outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return settings.outputDir;
  settings.outputDir = r.filePaths[0];
  saveSettings(settings);
  return settings.outputDir;
});

ipcMain.handle('open-folder', (_e, file) => {
  if (file && fs.existsSync(file)) return shell.showItemInFolder(file);
  fs.mkdirSync(settings.outputDir, { recursive: true });
  return shell.openPath(settings.outputDir);
});

// Called just before getDisplayMedia: remember which screen to capture.
ipcMain.handle('prepare', (_e, displayId) => {
  state.displayId = Number(displayId);
  const d = selectedDisplay();
  return { width: d.bounds.width, height: d.bounds.height, scaleFactor: d.scaleFactor };
});

ipcMain.handle('overlay-show', async () => {
  if (!overlayWin) await createOverlay();
  return true;
});

ipcMain.on('overlay-countdown', (_e, n) => sendOverlay('countdown', n));
ipcMain.on('overlay-highlight', (_e, on) => sendOverlay('highlight', on));
ipcMain.on('overlay-tool', (_e, tool) => sendOverlay('tool', tool));
ipcMain.on('draw-mode', (_e, on) => setDrawMode(on));
ipcMain.on('clear-draw', () => sendOverlay('clear'));

ipcMain.handle('recording-started', () => {
  state.recording = true;
  applyHotkeys();
  startMouseTracking();
  placePanel();
  updatePanel();
  return true;
});

ipcMain.handle('recording-stopped', () => {
  state.recording = false;
  applyHotkeys();
  setDrawMode(false);
  stopMouseTracking();
  closeOverlay();
  updatePanel();
  return true;
});

ipcMain.on('window-fit', (_e, height) => controlWin && controlWin.setContentSize(380, Math.ceil(height)));
ipcMain.on('window-minimize', () => controlWin && controlWin.minimize());
ipcMain.on('window-close', () => controlWin && controlWin.close());

// ---------- screenshots + guide ----------

let pendingShot = null;   // screenshot waiting for its caption strip from the control window

// Draw an anti-aliased ring straight into a BGRA bitmap.
function drawRing(buf, W, H, cx, cy, r, width, [red, green, blue, alpha]) {
  const reach = r + width / 2 + 1;
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(H - 1, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(W - 1, Math.ceil(cx + reach)); x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.min(1, Math.max(0, width / 2 + 0.5 - Math.abs(dist - r))) * alpha;
      if (cover <= 0) continue;
      const i = (y * W + x) * 4;
      buf[i] = buf[i] * (1 - cover) + blue * cover;
      buf[i + 1] = buf[i + 1] * (1 - cover) + green * cover;
      buf[i + 2] = buf[i + 2] * (1 - cover) + red * cover;
    }
  }
}

// Step 1: grab the whole screen the mouse is on, and work out the caption.
ipcMain.handle('grab-screen', async () => {
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  const b = d.bounds;
  const fg = foregroundApp();
  const front = fg && fg.pid !== process.pid ? fg : lastApp;
  // While recording, take the yellow cursor circle off the screen for the moment of the shot.
  const hideHighlight = !!overlayWin;
  if (hideHighlight) {
    sendOverlay('shot', true);
    await new Promise((r) => setTimeout(r, 100));
  }
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(b.width * d.scaleFactor), height: Math.round(b.height * d.scaleFactor) },
    });
  } finally {
    if (hideHighlight) sendOverlay('shot', false);
  }
  const src = sources.find(s => s.display_id === String(d.id)) || sources[0];
  if (!src) throw new Error('no screen found');
  const { width, height } = src.thumbnail.getSize();
  pendingShot = {
    bitmap: src.thumbnail.toBitmap(),      // BGRA pixels
    width,
    height,
    x: (cursor.x - b.x) / b.width * width,
    y: (cursor.y - b.y) / b.height * height,
    scale: d.scaleFactor,
    app: front ? front.name : null,
    time: guide.niceTime(),
  };
  const { app: appName, time } = pendingShot;
  return { width, height, app: appName, time, step: guide.nextStep(settings.currentGuide) };
});

// Step 2: add the red circle and the caption strip, save the PNGs, rebuild the guide.
ipcMain.handle('save-shot', async (_e, band) => {
  const s = pendingShot;
  pendingShot = null;
  if (!s) throw new Error('no screenshot waiting');
  const { width: W, height: H } = s;

  drawRing(s.bitmap, W, H, s.x, s.y, 26 * s.scale, 8 * s.scale, [255, 255, 255, 0.85]);
  drawRing(s.bitmap, W, H, s.x, s.y, 26 * s.scale, 4.5 * s.scale, [200, 16, 46, 1]);   // deep red #C8102E
  const marked = nativeImage.createFromBitmap(s.bitmap, { width: W, height: H }).toPNG();

  // Caption strip comes as RGBA; the bitmap is BGRA, so swap red and blue.
  const full = Buffer.alloc(W * (H + band.height) * 4);
  s.bitmap.copy(full, 0);
  const rgba = Buffer.from(band.rgba.buffer, band.rgba.byteOffset, band.rgba.byteLength);
  for (let i = 0, o = W * H * 4; i < rgba.length; i += 4, o += 4) {
    full[o] = rgba[i + 2];
    full[o + 1] = rgba[i + 1];
    full[o + 2] = rgba[i];
    full[o + 3] = 255;
  }
  const captioned = nativeImage.createFromBitmap(full, { width: W, height: H + band.height }).toPNG();

  const g = await guide.addStep(settings.currentGuide, settings.outputDir, { marked, captioned, app: s.app, time: s.time });
  if (settings.currentGuide !== g.folder) {
    settings.currentGuide = g.folder;
    saveSettings(settings);
  }
  panelToast(`Screenshot saved - step ${g.step}`);
  return g;
});

ipcMain.handle('guide-info', () => guide.info(settings.currentGuide));

ipcMain.handle('guide-new', () => {
  settings.currentGuide = null;
  saveSettings(settings);
  return null;
});

ipcMain.handle('guide-open', (_e, what) => {
  const g = guide.info(settings.currentGuide);
  if (!g) {
    fs.mkdirSync(settings.outputDir, { recursive: true });
    return shell.openPath(settings.outputDir);
  }
  return shell.openPath(what === 'page' ? path.join(g.folder, 'guide.html') : g.folder);
});

// ---------- writing the video file in chunks (no big video kept in memory) ----------

let out = null; // { stream, partPath, finalPath }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

ipcMain.handle('file-open', (_e, ext) => {
  fs.mkdirSync(settings.outputDir, { recursive: true });
  const finalPath = path.join(settings.outputDir, `FocusRec_${stamp()}.${ext}`);
  const partPath = finalPath + '.part';
  out = { stream: fs.createWriteStream(partPath), partPath, finalPath };
  return finalPath;
});

ipcMain.handle('file-chunk', (_e, buf) => {
  if (!out) return false;
  out.stream.write(Buffer.from(buf));
  return true;
});

ipcMain.handle('file-close', () => new Promise((resolve) => {
  if (!out) return resolve(null);
  const { stream, partPath, finalPath } = out;
  out = null;
  stream.end(async () => {
    // Rewrite the fragmented MP4 as a normal one so every player sees the length and can seek.
    if (finalPath.endsWith('.mp4')) {
      const tmpPath = finalPath + '.tmp';
      try {
        if (await fixMp4(partPath, tmpPath)) {
          fs.rmSync(partPath);
          fs.renameSync(tmpPath, finalPath);
          return resolve(finalPath);
        }
      } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        sendControl('status', 'Saved, but could not tidy the MP4 (' + err.message + '). It plays in browsers and VLC.');
      }
    }
    fs.renameSync(partPath, finalPath);
    resolve(finalPath);
  });
}));

ipcMain.handle('file-abort', () => new Promise((resolve) => {
  if (!out) return resolve(true);
  const { stream, partPath } = out;
  out = null;
  stream.end(() => {
    fs.rmSync(partPath, { force: true });
    resolve(true);
  });
}));

// ---------- app start ----------

app.whenReady().then(() => {
  settings = loadSettings();
  // No app menu: its built-in keys (Ctrl+R reload, Ctrl+W close) would get in the way.
  Menu.setApplicationMenu(null);

  // Answer getDisplayMedia() with the chosen screen, plus PC sound if asked.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const d = selectedDisplay();
    const src = sources.find(s => s.display_id === String(d.id)) || sources[0];
    const answer = { video: src };
    if (request.audioRequested) answer.audio = 'loopback';
    callback(answer);
  });

  createControlWindow();
  createPanel();
  applyHotkeys();

  // Remember the last app you used, so a screenshot taken from the control bar still names it.
  appTimer = setInterval(() => {
    const fg = foregroundApp();
    if (fg && fg.name && fg.pid !== process.pid) lastApp = fg;
  }, 700);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(appTimer);
  stopMouseTracking();
});

app.on('window-all-closed', () => app.quit());
