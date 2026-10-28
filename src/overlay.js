// FocusRec overlay: see-through layer on top of the screen.
// Draws the cursor circle, click ripples, pen/box/arrow marks and the countdown.
// Everything drawn here ends up in the recording, because it is on the screen.

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const view = {
  mouse: { x: -100, y: -100, inside: false },
  highlight: true,
  ripples: [],            // { x, y, color, start }
  strokes: [],            // { tool, color, points: [{x,y}] }
  current: null,          // stroke being drawn now
  drawMode: false,
  hideForShot: false,     // screenshot in progress: leave the yellow circle out
  tool: 'pen',
  color: '#ff3b30',
  countdown: 0,
};

const RIPPLE_MS = 500;
const CLICK_COLORS = { 1: '#ff3b30', 2: '#0a84ff', 3: '#30d158' };  // left, right, middle

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- messages from the main process ----------

overlay.on('mouse', (m) => { view.mouse = m; });
overlay.on('click', (c) => {
  view.ripples.push({ x: c.x, y: c.y, color: CLICK_COLORS[c.button] || CLICK_COLORS[1], start: performance.now() });
});
overlay.on('highlight', (on) => { view.highlight = on; });
overlay.on('shot', (on) => { view.hideForShot = on; });
overlay.on('clear', () => { view.strokes = []; view.current = null; });
overlay.on('countdown', (n) => { view.countdown = n; });
overlay.on('tool', (t) => {
  if (t.tool) view.tool = t.tool;
  if (t.color) view.color = t.color;
});
overlay.on('draw-mode', (on) => {
  view.drawMode = on;
  document.body.classList.toggle('drawing', on);
  if (!on) view.current = null;
});

// ---------- drawing with the mouse (only gets events in draw mode) ----------

canvas.addEventListener('pointerdown', (e) => {
  if (!view.drawMode || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  view.current = { tool: view.tool, color: view.color, points: [{ x: e.clientX, y: e.clientY }] };
});

canvas.addEventListener('pointermove', (e) => {
  if (!view.current) return;
  const p = { x: e.clientX, y: e.clientY };
  if (view.current.tool === 'pen') view.current.points.push(p);
  else view.current.points[1] = p;   // box and arrow only need start + end
});

canvas.addEventListener('pointerup', () => {
  if (!view.current) return;
  if (view.current.points.length > 1) view.strokes.push(view.current);
  view.current = null;
});

// ---------- painting ----------

function drawStroke(s) {
  const pts = s.points;
  if (pts.length < 2) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (s.tool === 'pen') {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  } else if (s.tool === 'box') {
    const [a, b] = pts;
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (s.tool === 'arrow') {
    const [a, b] = pts;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 18;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
}

function drawHighlight() {
  const { x, y, inside } = view.mouse;
  if (!view.highlight || !inside || view.drawMode || view.hideForShot) return;
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 214, 10, 0.35)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 214, 10, 0.9)';
  ctx.stroke();
}

function drawRipples(now) {
  view.ripples = view.ripples.filter(r => now - r.start < RIPPLE_MS);
  for (const r of view.ripples) {
    const t = (now - r.start) / RIPPLE_MS;          // 0 -> 1
    ctx.beginPath();
    ctx.arc(r.x, r.y, 12 + t * 38, 0, Math.PI * 2);
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 1 - t;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawCountdown() {
  if (!view.countdown) return;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 90, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(11, 31, 58, 0.85)';     // navy
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 110px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(view.countdown), cx, cy + 6);
}

function frame(now) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (const s of view.strokes) drawStroke(s);
  if (view.current) drawStroke(view.current);
  drawRipples(now);
  drawHighlight();
  drawCountdown();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
