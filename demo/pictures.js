// Makes the still pictures for the demo: control bar (zoom ON), Hotkeys tab, private panel.
// These windows are hidden from every recording, so the demo shows them as pictures.
// Run: electron demo\pictures.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const work = path.join(__dirname, 'work');
const outDir = path.join(work, 'pictures');
const userData = path.join(work, 'userdata-pictures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
// Electron prints nothing to a PowerShell window, so write a log file.
const logFile = path.join(work, 'pictures.log');
fs.writeFileSync(logFile, '');
const log = (s) => fs.appendFileSync(logFile, s + '\n');
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  outputDir: path.join(app.getPath('videos'), 'FocusRec'),
  micId: 'default', systemAudio: true, highlight: true, countdown: true, zoomLevel: 2,
}));
app.setPath('userData', userData);

require('../src/main.js');

app.whenReady().then(async () => {
  try {
    await sleep(2500);
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'FocusRec');
    const js = (code) => win.webContents.executeJavaScript(code);
    const save = async (w, name) => fs.writeFileSync(path.join(outDir, name), (await w.webContents.capturePage()).toPNG());

    // Looks like a recording with zoom on - only the screen is changed, nothing is recorded.
    await js(`setPhase('recording'); setZoomState(true); $('timer').textContent = '00:42';`);
    await sleep(400);
    await save(win, 'control.png');
    await js(`showTab('keys')`);
    await sleep(500);
    await save(win, 'hotkeys.png');
    await js(`showTab('record'); setPhase('idle');`);

    // The panel, drawn twice as big so it stays sharp in the video.
    const settings = await js(`window.focusrec.getSettings()`);
    const look = new BrowserWindow({ width: 560, height: 820, show: false, backgroundColor: '#F5F7FA',
      webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload-panel.js'), zoomFactor: 2 } });
    await look.loadFile(path.join(__dirname, '..', 'src', 'panel.html'));
    look.webContents.send('state', { showBox: true, time: '00:42', zoomOn: true, zoomLevel: 2, draw: false, highlight: true, shots: 2,
      hotkeys: settings.hotkeys });
    look.webContents.send('toast', 'Screenshot saved - step 2');
    await sleep(600);
    const r = await look.webContents.executeJavaScript(`(() => { const b = document.body.getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
    const img = await look.webContents.capturePage({ x: 0, y: 0, width: Math.ceil(r.w * 2) + 8, height: Math.ceil(r.h * 2) + 8 });
    fs.writeFileSync(path.join(outDir, 'panel.png'), img.toPNG());
    look.destroy();
    log('pictures saved: ' + fs.readdirSync(outDir).join(', '));
  } catch (err) {
    log('PICTURES ERROR: ' + err.stack);
  }
  app.exit(0);
});
