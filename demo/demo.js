// FocusRec demo video: FocusRec records itself while this script drives it on a made-up app page.
// A natural voice (Microsoft Andrew, clips made by voices.js) reads each part and a soft original tune plays
// underneath; FocusRec records them with its own "PC sound" option.
// Run: electron demo\voices.js, then electron demo\demo.js [--copy-to=<folder>] [--calibrate]
// Hands off the mouse while it runs (~1.5 min, sound plays out loud). If the mouse is moved by hand, the demo stops.
const { app, BrowserWindow, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');

const work = path.join(__dirname, 'work');
const userData = path.join(work, 'userdata-demo');
const outDir = path.join(work, 'out');
const edgeProfile = path.join(work, 'edge-profile');
const pictures = path.join(work, 'pictures');
const copyTo = (process.argv.find((a) => a.startsWith('--copy-to=')) || '').slice('--copy-to='.length);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9352;
const voiceDir = path.join(work, 'voice');
const { LINES } = require('./lines');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = path.join(work, 'demo.log');
let t0 = Date.now();
const log = (s) => fs.appendFileSync(logFile, `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}\n`);

for (const d of [userData, outDir, edgeProfile]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [userData, outDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(logFile, '');
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  outputDir: outDir, micId: 'none', systemAudio: true, highlight: true, countdown: false, zoomLevel: 2,
  panelVisible: true, panelCorner: 'top-right',
}));
app.setPath('userData', userData);

require('../src/main.js');
const { foregroundApp } = require('../src/activeapp.js');

// ---------- real mouse (so the highlight, ripples and drawing are the real thing) ----------

const mouseEvent = koffi.load('user32.dll')
  .func('void __stdcall mouse_event(uint32_t flags, int32_t dx, int32_t dy, uint32_t data, uintptr_t extra)');
const MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000;
let expected = null;     // where the mouse should be; anything else = someone moved it

function sendMove(x, y) {
  const b = screen.getPrimaryDisplay().bounds;
  mouseEvent(MOVE | ABSOLUTE, Math.round(x * 65535 / (b.width - 1)), Math.round(y * 65535 / (b.height - 1)), 0, 0);
  expected = { x: Math.round(x), y: Math.round(y) };
}

function checkHands() {
  if (!expected) return;
  const p = screen.getCursorScreenPoint();
  if (Math.hypot(p.x - expected.x, p.y - expected.y) > 25) throw new Error(`mouse moved by hand (at ${p.x},${p.y}) - demo stopped`);
}

// Smooth move along a slight curve, like a hand.
async function moveTo(x, y, ms = 700) {
  checkHands();
  const a = expected || screen.getCursorScreenPoint();
  const bend = 0.08 * Math.hypot(x - a.x, y - a.y);
  const len = Math.hypot(x - a.x, y - a.y) || 1;
  const cx = (a.x + x) / 2 - ((y - a.y) / len) * bend;
  const cy = (a.y + y) / 2 + ((x - a.x) / len) * bend;
  const steps = Math.max(1, Math.round(ms / 15));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    sendMove((1 - e) ** 2 * a.x + 2 * (1 - e) * e * cx + e ** 2 * x, (1 - e) ** 2 * a.y + 2 * (1 - e) * e * cy + e ** 2 * y);
    await sleep(15);
  }
}

async function click() {
  checkHands();
  mouseEvent(LEFTDOWN, 0, 0, 0, 0);
  await sleep(70);
  mouseEvent(LEFTUP, 0, 0, 0, 0);
}

async function drag(points, ms) {
  await moveTo(points[0].x, points[0].y, 400);
  mouseEvent(LEFTDOWN, 0, 0, 0, 0);
  const wait = Math.max(8, ms / points.length);
  for (const p of points.slice(1)) {
    sendMove(p.x, p.y);
    await sleep(wait);
  }
  mouseEvent(LEFTUP, 0, 0, 0, 0);
}

// ---------- Edge (the stage) over its debug port ----------

let edge = null;
let cdp = null;

async function openStage() {
  const url = pathToFileURL(path.join(__dirname, 'stage.html')).href;
  edge = spawn(EDGE, ['--kiosk', url, '--edge-kiosk-type=fullscreen', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${edgeProfile}`, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((p) => p.type === 'page' && p.url.includes('stage.html'));
    } catch { /* not up yet */ }
  }
  if (!page) throw new Error('Edge did not open the stage page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cannot reach Edge')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  };
  cdp = { ws, send: (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) };
}

// userGesture: counts as a click, so the page may play sound and speak.
async function stage(expression) {
  const d = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (d.result && d.result.exceptionDetails) throw new Error('stage: ' + d.result.exceptionDetails.text + ' in ' + expression.slice(0, 80));
  return d.result && d.result.result && d.result.result.value;
}
const call = (fn, ...args) => stage(`stage.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
const rect = (sel) => call('rect', sel);

// Hand every recorded voice clip to the page. Stops if a clip is missing or its line was changed since.
async function loadVoice() {
  const v = JSON.parse(fs.readFileSync(path.join(voiceDir, 'voice.json'), 'utf8'));
  for (const [name, text] of Object.entries(LINES)) {
    const clip = v.lines[name];
    if (!clip || clip.text !== text) throw new Error(`voice clip "${name}" missing or out of date - run voices.js first`);
    const b64 = fs.readFileSync(path.join(voiceDir, clip.file)).toString('base64');
    await call('voice.load', name, b64, clip.marks);
  }
  return Object.keys(LINES).length;
}

// Start a voice clip. .mark(word) waits for that word, .done() for the end.
let lineNo = 0;
async function say(name) {
  const id = name + '-' + (++lineNo);
  await call('voice.speak', id, name);
  return { mark: (word) => call('voice.mark', id, word), done: () => call('voice.end', id) };
}

async function closeStage() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch { /* already gone */ }
  if (edge && edge.exitCode === null) execFile('taskkill', ['/PID', String(edge.pid), '/T', '/F']);
}

// ---------- the demo ----------

app.whenReady().then(async () => {
  let control = null;
  let recording = false;
  let ok = false;
  try {
    await sleep(2500);
    control = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'FocusRec');
    const js = (code) => control.webContents.executeJavaScript(code);
    const text = (id) => js(`$('${id}').textContent`);

    await openStage();
    await sleep(2500);
    const size = await stage(`[innerWidth, innerHeight, devicePixelRatio]`);
    log('stage size ' + size.join(' x '));
    if (size[0] !== 1920 || size[1] !== 1080) throw new Error('stage is not full screen 1920x1080');
    await call('setPictures', {
      control: pathToFileURL(path.join(pictures, 'control.png')).href,
      keys: pathToFileURL(path.join(pictures, 'hotkeys.png')).href,
      panel: pathToFileURL(path.join(pictures, 'panel.png')).href,
    });
    log('voice clips loaded: ' + await loadVoice());

    // Bring Edge to the front with a click on an empty spot, then check.
    await moveTo(120, 1000, 300);
    await click();
    await sleep(500);
    const front = foregroundApp();
    log('front app ' + JSON.stringify(front));
    if (!front || !/edge/i.test(front.name)) throw new Error('Edge is not in front');
    await moveTo(1480, 860, 500);

    // Record (with PC sound). The control bar is hidden from the video anyway; minimise it so it is not in the mouse's way.
    await js(`$('btnRecord').click()`);
    for (let i = 0; i < 40 && await text('state') !== 'Recording'; i++) await sleep(100);
    if (await text('state') !== 'Recording') throw new Error('recording did not start: ' + await text('status'));
    recording = true;
    t0 = Date.now();
    log('recording | status: "' + await text('status') + '"');
    if (/PC sound not available/.test(await text('status'))) throw new Error('PC sound not available');
    control.minimize();
    log('music ' + await call('music.start', 1500));

    if (process.argv.includes('--calibrate')) {
      // Sound check only: music alone, voice + music, music again. Nothing is copied.
      await sleep(7000);
      log('calibrate: voice line');
      const q = await say('draw');
      await q.done();
      log('calibrate: voice line ended');
      await sleep(3500);
      log('history ' + JSON.stringify(await call('music.history')));
      throw new Error('calibrate run - not a demo');
    }

    // 0 - title
    await sleep(1600);
    let s = await say('title');
    await moveTo(1300, 760, 1400);
    await s.done();
    await sleep(500);

    // 1 - highlight + clicks
    await call('scene', 'app');
    await sleep(500);
    await call('caption', 'Cursor highlight + click ripples', '', '1');
    log('1 highlight + clicks');
    s = await say('highlight');
    let r = await rect('#name');
    await moveTo(r.left + 60, r.y, 800);
    await click();
    await call('type', '#name', 'Alex Tan', 70);
    r = await rect('#cat');
    await moveTo(r.left + 90, r.y, 600);
    await click();
    await sleep(400);
    r = await rect('#optTravel');
    await moveTo(r.left + 70, r.y, 450);
    await click();
    r = await rect('#amount');
    await moveTo(r.left + 60, r.y, 600);
    await click();
    await call('type', '#amount', '86.40', 90);
    await s.done();
    await sleep(400);

    // 2 - zoom
    await call('caption', 'Zoom in - follows your mouse, 1.5x to 3x', 'Alt+Shift+Z', '2');
    log('2 zoom');
    const table = await rect('#table');
    s = await say('zoom1');
    await moveTo(table.left + 40, table.top + 60, 900);
    await s.done();
    await call('caption', null);
    await js(`toggleZoom()`);
    s = await say('zoom2');
    await moveTo(table.left + 560, table.top + 100, 1500);
    await s.mark('three');
    const total = await rect('#total');
    await moveTo(total.x, total.y, 900);
    await js(`setZoomLevel(3)`);
    await s.done();
    await sleep(1300);
    await js(`setZoomLevel(2)`);
    const policy = await rect('.policy');
    s = await say('zoom3');
    await moveTo(policy.left + 120, policy.y, 800);
    await s.mark('out');
    await js(`toggleZoom()`);
    await s.done();
    await sleep(700);

    // 3 - draw (each mark starts on its word)
    await call('caption', 'Draw on screen - pen, box, arrow', 'Alt+Shift+D', '3');
    log('3 draw');
    await js(`$('btnDraw').click()`);
    s = await say('draw');
    const ring = [];
    const rx = (total.right - total.left) / 2 + 40, ry = (total.bottom - total.top) / 2 + 8;
    for (let i = 0; i <= 64; i++) {
      const a = -2.2 + (i / 64) * Math.PI * 2.15;
      ring.push({ x: total.x + Math.cos(a) * rx * (1 + i / 900), y: total.y + Math.sin(a) * ry });
    }
    await s.mark('circle');
    await drag(ring, 900);
    await js(`document.querySelector('.tool[data-tool=box]').click(); document.querySelector('.swatch[data-color="#0a84ff"]').click()`);
    const amount = await rect('#amount');
    const box = [];
    for (let i = 0; i <= 20; i++) box.push({ x: amount.left - 10 + (amount.right - amount.left + 20) * i / 20, y: amount.top - 10 + (amount.bottom - amount.top + 20) * i / 20 });
    await s.mark('box');
    await drag(box, 600);
    await js(`document.querySelector('.tool[data-tool=arrow]').click(); document.querySelector('.swatch[data-color="#30d158"]').click()`);
    const submit = await rect('#submit');
    // Arrow from below-left into the bottom-left corner of "Submit claim", then move the cursor off its tip.
    const arrow = [];
    const from = { x: submit.left - 230, y: submit.bottom + 125 }, to = { x: submit.left + 22, y: submit.bottom - 6 };
    for (let i = 0; i <= 20; i++) arrow.push({ x: from.x + (to.x - from.x) * i / 20, y: from.y + (to.y - from.y) * i / 20 });
    await s.mark('arrow');
    await drag(arrow, 600);
    await moveTo(from.x - 60, from.y + 70, 450);
    await s.mark('then');
    await call('caption', 'Clear the drawing with one key', 'Alt+Shift+C', '3');
    await s.mark('clears');
    await js(`$('btnClear').click()`);
    await s.done();
    await sleep(500);
    await js(`$('btnDraw').click(); document.querySelector('.tool[data-tool=pen]').click(); document.querySelector('.swatch[data-color="#ff3b30"]').click()`);
    await sleep(300);

    // 4 - screenshots + guide
    await call('caption', 'Screenshot guide - with or without recording', 'Alt+Shift+S', '4');
    log('4 screenshots');
    s = await say('shot1');
    await moveTo(submit.x - 20, submit.y + 4, 900);
    await s.done();
    await call('caption', null);
    await sleep(500);
    const shot = async (n) => {
      await js(`takeShot()`);
      for (let i = 0; i < 40 && !(await text('guideCount')).startsWith(String(n)); i++) await sleep(100);
      log('shot ' + n + ': ' + await text('guideCount') + ' | ' + await text('status'));
    };
    await shot(1);
    await sleep(400);
    await click();
    await sleep(900);
    const ref = await rect('#ref');
    await moveTo(ref.x + 10, ref.y + 4, 800);
    await sleep(500);
    await shot(2);
    await sleep(400);

    const g = await js(`window.focusrec.guideInfo()`);
    const steps = JSON.parse(fs.readFileSync(path.join(g.folder, 'guide.json'), 'utf8')).steps;
    log('guide ' + g.folder + ' | ' + steps.map((x) => x.png).join(' | '));
    // Result pages: no yellow circle, mouse parked in the corner.
    await js(`$('chkHighlight').click()`);
    await moveTo(1912, 1072, 700);
    await call('showShot', pathToFileURL(path.join(g.folder, steps[0].png)).href, steps[0].png);
    await call('scene', 'shot');
    await sleep(500);
    await call('caption', 'Each one: red circle on the mouse + step, app name and time', '', '4');
    s = await say('shot2');
    await s.done();
    await sleep(700);
    await call('showGuide', fs.readFileSync(path.join(g.folder, 'guide.html'), 'utf8'));
    await call('scene', 'guide');
    await call('caption', 'A guide is made for you - HTML page + Word file + PNGs', '', '4');
    await sleep(500);
    s = await say('guide');
    await Promise.all([s.done(), call('scrollGuide', 5500)]);
    await sleep(600);

    // 5 - what only you see
    await call('scene', 'extras');
    await call('caption', 'Zoom state, your own hotkeys and a private panel', '', '5');
    log('5 extras');
    await sleep(500);
    s = await say('extras');
    await s.done();
    await sleep(900);

    // end card, music fades out
    await call('caption', null);
    await call('scene', 'end');
    log('end card');
    await sleep(700);
    s = await say('end');
    await s.done();
    await call('music.fadeOut', 2500);
    await sleep(300);
    ok = true;
  } catch (err) {
    log('DEMO ERROR: ' + err.message);
  }

  try {
    if (recording) {
      const js = (code) => control.webContents.executeJavaScript(code);
      await js(`$('btnStop').click()`);
      let file = '';
      for (let i = 0; i < 80 && !file; i++) { await sleep(250); file = await js(`$('saved').title`); }
      log('saved ' + file);
      if (file && copyTo && ok) {
        fs.mkdirSync(copyTo, { recursive: true });
        fs.copyFileSync(file, path.join(copyTo, 'FocusRec-demo.mp4'));
        log('copied to ' + path.join(copyTo, 'FocusRec-demo.mp4'));
      } else if (!ok) {
        log('NOT copied: demo did not finish');
      }
    }
  } catch (err) {
    log('STOP ERROR: ' + err.message);
  }
  await closeStage();
  log('done');
  app.exit(0);
});
