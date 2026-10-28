// Private corner panel: recording state, zoom state and your hotkeys.
// The window is hidden from screen capture, so only you see it.

const $ = (id) => document.getElementById(id);
let toastTimer = null;

const LABELS = {
  'toggle-record': 'Start / stop',
  'toggle-pause': 'Pause',
  'toggle-zoom': 'Zoom in / out',
  'zoom-more': 'Zoom more',
  'zoom-less': 'Zoom less',
  'toggle-draw': 'Draw',
  'clear-draw': 'Clear drawing',
  'toggle-highlight': 'Highlight',
  'screenshot': 'Screenshot',
  'toggle-panel': 'Hide panel',
};

const prettyKey = (k) => k.replace(/\bUp\b/, '↑').replace(/\bDown\b/, '↓');

function fit() {
  window.panel.fit(document.body.scrollWidth, document.body.scrollHeight);
}

function setVal(id, text, on) {
  $(id).textContent = text;
  $(id).classList.toggle('on', !!on);
}

window.panel.on('state', (s) => {
  $('box').classList.toggle('hidden', !s.showBox);
  $('rec').lastChild.textContent = s.paused ? 'PAUSED' : 'REC';
  $('rec').classList.toggle('paused', !!s.paused);
  $('time').textContent = s.time || '00:00';
  setVal('zoom', s.zoomOn ? `${s.zoomLevel}x  ON` : `${s.zoomLevel}x  off`, s.zoomOn);
  setVal('draw', s.draw ? 'ON' : 'off', s.draw);
  setVal('highlight', s.highlight ? 'ON' : 'off', s.highlight);
  setVal('shots', String(s.shots || 0));

  const keys = $('keys');
  keys.innerHTML = '';
  for (const [action, label] of Object.entries(LABELS)) {
    const key = s.hotkeys && s.hotkeys[action];
    if (!key) continue;
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.textContent = prettyKey(key);
    const l = document.createElement('span');
    l.textContent = label;
    row.append(k, l);
    keys.append(row);
  }
  fit();
});

window.panel.on('toast', (text) => {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  fit();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').classList.add('hidden');
    fit();
  }, 2000);
});

new ResizeObserver(fit).observe(document.body);
