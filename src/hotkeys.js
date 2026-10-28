// Hotkey editor (Hotkeys tab): click a key box, then press the new keys.

const Hotkeys = (() => {
  const LABELS = {
    'toggle-record': 'Start / stop recording',
    'toggle-pause': 'Pause / resume',
    'toggle-zoom': 'Zoom in / out',
    'zoom-more': 'Zoom more',
    'zoom-less': 'Zoom less',
    'toggle-draw': 'Draw on / off',
    'clear-draw': 'Clear drawing',
    'toggle-highlight': 'Highlight on / off',
    'screenshot': 'Take screenshot',
    'toggle-panel': 'Show / hide panel',
  };

  const NAMED = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  };
  const isMac = navigator.userAgent.includes('Mac');

  let keys = {};
  let listening = null;     // the key box waiting for keys
  let onChange = () => {};
  let onError = () => {};

  const pretty = (k) => (k ? k.replace(/\bUp\b/, '↑').replace(/\bDown\b/, '↓') : '');

  function keyName(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return 'num' + m[1];
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    return NAMED[code] || null;
  }

  // KeyboardEvent -> Electron accelerator, e.g. "Ctrl+Alt+S". null while only modifiers are held.
  function toAccelerator(e) {
    const key = keyName(e.code);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push(isMac ? 'Cmd' : 'Super');
    return [...mods, key].join('+');
  }

  function setBox(box, key) {
    box.textContent = key ? pretty(key) : 'Not set';
    box.classList.toggle('empty', !key);
    box.classList.remove('listening');
  }

  function render() {
    const root = document.getElementById('keyRows');
    root.innerHTML = '';
    for (const [action, label] of Object.entries(LABELS)) {
      const row = document.createElement('div');
      row.className = 'row';
      const text = document.createElement('span');
      text.textContent = label;
      const box = document.createElement('button');
      box.className = 'keybox';
      box.dataset.action = action;
      setBox(box, keys[action]);
      box.onclick = () => startListening(box);
      row.append(text, box);
      root.append(row);
    }
  }

  function startListening(box) {
    if (listening) stopListening();
    listening = box;
    box.textContent = 'Press keys...';
    box.classList.add('listening');
    box.classList.remove('empty');
    onError('');
    window.focusrec.pauseHotkeys();    // so pressing an existing hotkey does not fire it
  }

  function stopListening() {
    if (!listening) return;
    setBox(listening, keys[listening.dataset.action]);
    listening = null;
    window.focusrec.resumeHotkeys();
  }

  async function save(action, key) {
    const r = await window.focusrec.setHotkey(action, key);
    if (!r.ok) {
      onError(r.error);    // keep listening, so another combination can be tried
      return;
    }
    keys = r.hotkeys;
    onError('');
    stopListening();
    render();
    onChange(keys);
  }

  async function onKeyDown(e) {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    const action = listening.dataset.action;
    const noMods = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (noMods && e.key === 'Escape') return stopListening();
    if (noMods && (e.key === 'Delete' || e.key === 'Backspace')) return save(action, '');

    const accel = toAccelerator(e);
    if (!accel) return;
    const isFKey = /^F\d+$/.test(accel.split('+').pop());
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !isFKey) {
      onError('Add Ctrl or Alt (Shift alone is not enough), or use an F key.');
      return;
    }
    const used = Object.entries(keys).find(([a, k]) => a !== action && k && k.toLowerCase() === accel.toLowerCase());
    if (used) {
      onError(`${pretty(accel)} is already used for "${LABELS[used[0]]}".`);
      return;
    }
    await save(action, accel);
  }

  function init(opts) {
    keys = opts.keys;
    onChange = opts.onChange;
    onError = opts.onError;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', stopListening);
    document.getElementById('btnKeysReset').onclick = async () => {
      stopListening();
      keys = await window.focusrec.resetHotkeys();
      render();
      onChange(keys);
    };
    render();
  }

  return { init, pretty };
})();
