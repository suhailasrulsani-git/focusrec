// FocusRec control window: buttons, settings, timer, screenshots and hotkey actions.

const api = window.focusrec;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings = null;
let phase = 'idle';          // idle | starting | recording | paused | stopping
let cancelStart = false;
let elapsedMs = 0;
let lastTick = 0;
let tickTimer = null;
let zoomOn = false;
let drawOn = false;
let tool = 'pen';
let color = '#ff3b30';
let guideInfo = null;
let shots = Promise.resolve();

// ---------- small helpers ----------

function status(text, isError = false) {
  $('status').textContent = text || '';
  $('status').classList.toggle('error', !!isError);
}
const problem = (text) => status(text, !!text);

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

// Tell the private corner panel what is going on.
function pushPanel() {
  api.hudState({
    paused: phase === 'paused',
    time: formatTime(elapsedMs),
    zoomOn,
    zoomLevel: Number(settings.zoomLevel),
    draw: drawOn,
    highlight: settings.highlight,
    shots: guideInfo ? guideInfo.count : 0,
  });
}

function tick() {
  const now = performance.now();
  if (phase === 'recording') elapsedMs += now - lastTick;
  lastTick = now;
  $('timer').textContent = formatTime(elapsedMs);
  pushPanel();
}

function setPhase(p) {
  phase = p;
  const live = p === 'recording' || p === 'paused';
  document.body.classList.toggle('recording', p === 'recording');
  document.body.classList.toggle('paused', p === 'paused');

  $('state').textContent = {
    idle: 'Ready', starting: 'Starting...', recording: 'Recording', paused: 'Paused', stopping: 'Saving...',
  }[p];
  $('badges').classList.toggle('hidden', !live);

  $('btnRecord').disabled = p !== 'idle';
  $('btnPause').disabled = !live;
  $('btnPause').textContent = p === 'paused' ? 'Resume' : 'Pause';
  $('btnStop').disabled = !(live || p === 'starting');

  for (const id of ['selScreen', 'selMic', 'chkSystem', 'chkCountdown']) $(id).disabled = p !== 'idle';
  $('btnZoom').disabled = !live;
  $('btnDraw').disabled = !live;
  $('btnClear').disabled = !live;
  document.querySelectorAll('.tool, .swatch').forEach((b) => { b.disabled = !live; });

  if (!live) {
    setZoomState(false);
    setDrawState(false);
  }
  pushPanel();
}

function setZoomState(on) {
  zoomOn = on;
  const level = `${Number(settings.zoomLevel)}x`;
  $('btnZoom').textContent = on ? 'Zoom out' : 'Zoom in';
  $('btnZoom').classList.toggle('on', on);
  $('badgeZoom').textContent = on ? `Zoom ${level} ON` : `Zoom off (${level})`;
  $('badgeZoom').classList.toggle('on', on);
  pushPanel();
}

function setDrawState(on) {
  drawOn = on;
  $('btnDraw').textContent = on ? 'Draw: on' : 'Draw: off';
  $('btnDraw').classList.toggle('on', on);
  $('badgeDraw').textContent = on ? 'Draw ON' : 'Draw off';
  $('badgeDraw').classList.toggle('on', on);
  pushPanel();
}

async function save(patch) {
  settings = await api.setSettings(patch);
}

// ---------- lists ----------

async function fillScreens() {
  const displays = await api.getDisplays();
  const sel = $('selScreen');
  sel.innerHTML = '';
  for (const d of displays) sel.add(new Option(d.label, d.id));
}

async function fillMics() {
  const sel = $('selMic');
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  sel.innerHTML = '';
  sel.add(new Option('No microphone', 'none'));
  sel.add(new Option('Default microphone', 'default'));
  devices.forEach((d, i) => sel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  sel.value = [...sel.options].some((o) => o.value === settings.micId) ? settings.micId : 'default';
}

function showFolder() {
  $('folder').textContent = settings.outputDir;
  $('folder').title = settings.outputDir;
}

function showSaved(file) {
  const el = $('saved');
  if (!file) { el.classList.add('hidden'); return; }
  el.textContent = 'Saved: ' + file.split(/[\\/]/).pop() + '  (click to show)';
  el.title = file;
  el.onclick = () => api.openFolder(file);
  el.classList.remove('hidden');
}

function showGuide(g) {
  guideInfo = g;
  $('guideCount').textContent = g ? `${g.count} screenshot${g.count === 1 ? '' : 's'}` : 'No screenshots yet';
  $('guideName').textContent = g ? g.name : 'A new guide starts with the next screenshot.';
  $('btnGuidePage').disabled = !g;
  pushPanel();
}

function showShotKey() {
  $('shotKey').textContent = Hotkeys.pretty(settings.hotkeys.screenshot) || 'not set';
}

// ---------- record / pause / stop ----------

async function startRecording() {
  if (phase !== 'idle') return;
  cancelStart = false;
  elapsedMs = 0;
  setPhase('starting');
  status('');
  showSaved(null);
  let fileOpen = false;

  try {
    await api.prepare($('selScreen').value);
    await api.showOverlay();
    api.setHighlight(settings.highlight);
    api.setTool({ tool, color });

    const info = await Recorder.prepare({
      micId: settings.micId,
      systemAudio: settings.systemAudio,
      zoomLevel: Number(settings.zoomLevel),
      ended: () => stopRecording(),
    });
    if (info.warnings.length) problem(info.warnings.join(' '));
    await api.recordingStarted();

    if (settings.countdown) {
      for (let n = 3; n > 0 && !cancelStart; n--) {
        api.countdown(n);
        $('state').textContent = 'Starting in ' + n;
        await sleep(1000);
      }
      api.countdown(0);
      await sleep(150);   // let the number disappear before the first frame
    }
    if (cancelStart) throw new Error('cancelled');

    await api.fileOpen(info.ext);
    fileOpen = true;
    Recorder.begin();
    lastTick = performance.now();
    $('timer').textContent = '00:00';
    tickTimer = setInterval(tick, 250);
    setPhase('recording');
  } catch (err) {
    Recorder.release();
    if (fileOpen) await api.fileAbort();
    await api.recordingStopped();
    setPhase('idle');
    if (err.message !== 'cancelled') problem('Could not start: ' + err.message);
  }
}

async function stopRecording() {
  if (phase === 'starting') { cancelStart = true; return; }
  if (phase !== 'recording' && phase !== 'paused') return;
  setPhase('stopping');
  clearInterval(tickTimer);
  try {
    await Recorder.stop();
    showSaved(await api.fileClose());
  } catch (err) {
    problem('Save failed: ' + err.message);
  }
  await api.recordingStopped();
  setPhase('idle');
}

function togglePause() {
  if (phase === 'recording') {
    Recorder.pause();
    setPhase('paused');
  } else if (phase === 'paused') {
    Recorder.resume();
    lastTick = performance.now();
    setPhase('recording');
  }
}

function toggleZoom() {
  if (phase !== 'recording' && phase !== 'paused') return;
  setZoomState(Recorder.toggleZoom());
}

async function setZoomLevel(level) {
  level = Recorder.setZoomLevel(level);
  $('selZoom').value = String(level);
  await save({ zoomLevel: level });
  setZoomState(zoomOn);
}

async function toggleHighlight() {
  $('chkHighlight').checked = !$('chkHighlight').checked;
  await save({ highlight: $('chkHighlight').checked });
  api.setHighlight(settings.highlight);
  pushPanel();
}

// ---------- screenshots ----------

async function doShot() {
  const grab = await api.grabScreen();
  const g = await api.saveShot(Shot.captionBand(grab));
  showGuide(g);
  status(`Screenshot saved - step ${g.step}`);
}

// One at a time, in order, even if the hotkey is pressed quickly.
function takeShot() {
  shots = shots.then(doShot).catch((err) => problem('Screenshot failed: ' + err.message));
}

// ---------- tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== 'page-' + name));
}

// ---------- wire up ----------

async function init() {
  settings = await api.getSettings();
  await fillScreens();
  await fillMics();
  navigator.mediaDevices.addEventListener('devicechange', fillMics);

  $('chkSystem').checked = settings.systemAudio;
  $('chkHighlight').checked = settings.highlight;
  $('chkCountdown').checked = settings.countdown;
  $('chkPanel').checked = settings.panelVisible;
  $('selCorner').value = settings.panelCorner;
  $('selZoom').value = String(settings.zoomLevel);
  showFolder();
  showGuide(await api.guideInfo());
  document.querySelectorAll('.swatch').forEach((b) => b.style.setProperty('--c', b.dataset.color));

  Hotkeys.init({
    keys: settings.hotkeys,
    onChange: (keys) => { settings.hotkeys = keys; showShotKey(); },
    onError: problem,
  });
  showShotKey();

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

  $('btnRecord').onclick = startRecording;
  $('btnStop').onclick = stopRecording;
  $('btnPause').onclick = togglePause;
  $('btnZoom').onclick = toggleZoom;
  $('btnDraw').onclick = () => api.setDrawMode(!drawOn);
  $('btnClear').onclick = () => api.clearDrawing();
  $('btnMin').onclick = () => api.minimize();
  $('btnClose').onclick = async () => { await stopRecording(); api.close(); };
  $('btnFolder').onclick = async () => { settings.outputDir = await api.chooseFolder(); showFolder(); };
  $('btnOpen').onclick = () => api.openFolder(null);

  $('btnShot').onclick = takeShot;
  $('btnGuideNew').onclick = async () => { showGuide(await api.guideNew()); status('Next screenshot starts a new guide.'); };
  $('btnGuidePage').onclick = () => api.guideOpen('page');
  $('btnGuideFolder').onclick = () => api.guideOpen('folder');

  $('selMic').onchange = () => save({ micId: $('selMic').value });
  $('chkSystem').onchange = () => save({ systemAudio: $('chkSystem').checked });
  $('chkCountdown').onchange = () => save({ countdown: $('chkCountdown').checked });
  $('chkPanel').onchange = () => save({ panelVisible: $('chkPanel').checked });
  $('selCorner').onchange = () => save({ panelCorner: $('selCorner').value });
  $('chkHighlight').onchange = async () => {
    await save({ highlight: $('chkHighlight').checked });
    api.setHighlight(settings.highlight);
    pushPanel();
  };
  $('selZoom').onchange = () => setZoomLevel(Number($('selZoom').value));

  document.querySelectorAll('.tool').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('active', x === b));
      tool = b.dataset.tool;
      api.setTool({ tool });
    };
  });
  document.querySelectorAll('.swatch').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === b));
      color = b.dataset.color;
      api.setTool({ color });
    };
  });

  api.on('mouse', (m) => Recorder.setMouse(m));
  api.on('status', problem);
  api.on('draw-mode', setDrawState);
  api.on('panel-visible', (on) => { settings.panelVisible = on; $('chkPanel').checked = on; });
  api.on('action', (action) => {
    switch (action) {
      case 'toggle-record': phase === 'idle' ? startRecording() : stopRecording(); break;
      case 'toggle-pause': togglePause(); break;
      case 'toggle-zoom': toggleZoom(); break;
      case 'zoom-more': setZoomLevel(Number(settings.zoomLevel) + 0.5); break;
      case 'zoom-less': setZoomLevel(Number(settings.zoomLevel) - 0.5); break;
      case 'toggle-highlight': toggleHighlight(); break;
      case 'screenshot': takeShot(); break;
    }
  });

  // Grow / shrink the window to fit its content (e.g. when switching tabs).
  new ResizeObserver(() => api.fitHeight(document.body.scrollHeight)).observe(document.body);

  setPhase('idle');
}

init();
