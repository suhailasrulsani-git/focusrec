// Records each narration line once, as a clean WAV clip, from Microsoft's natural voice in Edge.
// Why not speak live in the demo: while Edge's read-aloud voice talks, Windows turns other sound down
// (the music dropped ~18 dB and stayed down). Playing recorded clips avoids that, and the timing is exact.
// Run: electron demo\voices.js [--force]   (plays the lines out loud, ~1.5 min; keep the PC quiet; needs internet)
// Writes work\voice\<line>.wav + voice.json (text, length, and when each "mark" word is said).
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { VOICE, LINES, MARKS } = require('./lines');

const work = path.join(__dirname, 'work');
const voiceDir = path.join(work, 'voice');
const jsonFile = path.join(voiceDir, 'voice.json');
const edgeProfile = path.join(work, 'edge-voice-profile');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9353;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(voiceDir, { recursive: true });
const logFile = path.join(work, 'voices.log');
fs.writeFileSync(logFile, '');
const log = (s) => fs.appendFileSync(logFile, s + '\n');

// Nothing to do when every clip already matches its line.
function upToDate() {
  try {
    const old = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    return old.voice === VOICE && Object.entries(LINES).every(([k, t]) => old.lines[k] && old.lines[k].text === t
      && fs.existsSync(path.join(voiceDir, old.lines[k].file)));
  } catch { return false; }
}

app.whenReady().then(async () => {
  if (!process.argv.includes('--force') && upToDate()) {
    log('voice clips up to date - nothing recorded');
    app.exit(0);
    return;
  }
  let edge = null;
  let failed = false;
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
      const s = await desktopCapturer.getSources({ types: ['screen'] });
      cb({ video: s[0], audio: 'loopback' });
    });
    const rec = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await rec.loadFile(path.join(__dirname, 'voices-rec.html'));
    const r = (code) => rec.webContents.executeJavaScript(code);

    // Edge in a throw-away profile, off-screen.
    fs.rmSync(edgeProfile, { recursive: true, force: true });
    edge = spawn(EDGE, ['about:blank', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${edgeProfile}`,
      `--remote-debugging-port=${PORT}`, '--window-position=-3000,-3000', '--window-size=600,400'], { stdio: 'ignore' });
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      await sleep(500);
      try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((p) => p.type === 'page'); } catch { /* not up yet */ }
    }
    if (!page) throw new Error('Edge did not open');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res) => { ws.onopen = res; });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const edgeJs = (expression) => new Promise((res) => {
      const i = ++id;
      waiting.set(i, res);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
    }).then((d) => d.result.result && d.result.result.value);

    // Speak one line in Edge; returns word times (ms after the voice started) once it has finished.
    const speak = (text, volume) => edgeJs(`new Promise((res) => {
      const u = new SpeechSynthesisUtterance(${JSON.stringify(text)});
      u.voice = speechSynthesis.getVoices().find((v) => v.name === ${JSON.stringify(VOICE)});
      u.volume = ${volume};
      window.keep = u;
      let start = 0; const words = [];
      u.onstart = () => { start = performance.now(); };
      u.onboundary = (e) => words.push([e.charIndex, Math.round(performance.now() - start)]);
      u.onend = () => res({ ok: !!u.voice, words });
      u.onerror = (e) => res({ ok: false, error: e.error, words });
      speechSynthesis.speak(u);
      setTimeout(() => res({ ok: false, error: 'timeout', words }), 30000);
    })`);

    const found = await edgeJs(`new Promise((res) => { let n = 0; const t = setInterval(() => {
      if (speechSynthesis.getVoices().some((v) => v.name === ${JSON.stringify(VOICE)}) || ++n > 40) { clearInterval(t); res(speechSynthesis.getVoices().some((v) => v.name === ${JSON.stringify(VOICE)})); } }, 250); })`);
    if (!found) throw new Error('voice not available (needs internet): ' + VOICE);
    await speak('Ready.', 0);                     // warm-up, silent

    log('recorder at ' + await r('start()') + ' Hz');
    await sleep(1500);
    const quiet = await r(`level(0, position())`);
    log('PC sound before speaking: ' + quiet.toFixed(1) + ' dBFS');
    if (quiet > -55) throw new Error('other sound is playing on the PC - stop it and run again');

    const out = { voice: VOICE, lines: {} };
    for (const [name, text] of Object.entries(LINES)) {
      const a = await r('position()');
      const s = await speak(text, 1);
      if (!s.ok) throw new Error(`"${name}" failed: ${s.error}`);
      await sleep(700);                           // let the last word ring out
      const clip = await r(`cut(${a}, position())`);
      if (!clip) throw new Error(`"${name}": no sound recorded`);
      // Word times are counted from the first word, which is where the clip's sound starts (+60 ms lead-in).
      const first = s.words.length ? s.words[0][1] : 0;
      const marks = {};
      for (const w of MARKS[name] || []) {
        const at = text.toLowerCase().search(new RegExp('\\b' + w + '\\b'));
        const hit = s.words.find(([c]) => c >= at);
        marks[w] = hit ? Math.max(0, hit[1] - first + 60) : Math.round(clip.ms * at / text.length);
      }
      const file = name + '.wav';
      fs.writeFileSync(path.join(voiceDir, file), Buffer.from(clip.wav, 'base64'));
      out.lines[name] = { text, file, ms: clip.ms, marks };
      log(`${name.padEnd(9)} ${String(clip.ms).padStart(5)} ms  gain ${clip.gainDb} dB  marks ${JSON.stringify(marks)}`);
      await sleep(500);
    }
    fs.writeFileSync(jsonFile, JSON.stringify(out, null, 2));
    log('saved ' + jsonFile);
    ws.close();
  } catch (err) {
    failed = true;
    log('VOICES ERROR: ' + err.message);
  }
  if (edge && edge.exitCode === null) execFile('taskkill', ['/PID', String(edge.pid), '/T', '/F']);
  await sleep(800);
  app.exit(failed ? 1 : 0);
});
