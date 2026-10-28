// FocusRec recorder.
// Screen -> canvas (where the zoom happens) -> MediaRecorder -> MP4 chunks -> main process writes the file.
// Mic and PC sound are mixed into one audio track.

const Recorder = (() => {
  const FPS = 30;
  const MIME_TYPES = [
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm', 'webm'],
  ];

  let screenStream = null;
  let micStream = null;
  let audioCtx = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let drawTimer = null;
  let mediaRecorder = null;
  let writes = Promise.resolve();
  let onEnded = null;

  const mouse = { nx: 0.5, ny: 0.5 };
  const zoom = { on: false, level: 2, z: 1, cx: 0, cy: 0 };

  function pickFormat() {
    return MIME_TYPES.find(([type]) => MediaRecorder.isTypeSupported(type)) || ['', 'webm'];
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // One frame: move the "camera" toward the mouse and draw the zoomed part of the screen.
  function drawFrame() {
    const W = canvas.width;
    const H = canvas.height;
    const target = zoom.on ? zoom.level : 1;
    zoom.z += (target - zoom.z) * 0.15;
    if (Math.abs(target - zoom.z) < 0.002) zoom.z = target;

    zoom.cx += (mouse.nx * W - zoom.cx) * 0.12;
    zoom.cy += (mouse.ny * H - zoom.cy) * 0.12;

    const cw = W / zoom.z;
    const ch = H / zoom.z;
    const sx = clamp(zoom.cx - cw / 2, 0, W - cw);
    const sy = clamp(zoom.cy - ch / 2, 0, H - ch);
    ctx.drawImage(video, sx, sy, cw, ch, 0, 0, W, H);
  }

  // PC sound as it is: by default Chromium treats it like a mic (auto-gain, noise suppression,
  // echo cancellation, mono), which pumps music up and down and can remove it. Mic keeps its clean-up.
  const PC_SOUND = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };

  async function getScreen(withSystemAudio) {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: withSystemAudio ? PC_SOUND : false });
    } catch (err) {
      if (!withSystemAudio) throw err;
      // Some PCs cannot capture PC sound. Record without it rather than fail.
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: false });
      s.warning = 'PC sound not available, recording without it.';
      return s;
    }
  }

  async function getMic(micId) {
    if (!micId || micId === 'none') return null;
    const audio = micId === 'default' ? true : { deviceId: { exact: micId } };
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }

  // Get the screen + audio ready and start drawing to the canvas. Nothing is saved yet.
  async function prepare({ micId, systemAudio, zoomLevel, ended }) {
    const warnings = [];
    onEnded = ended;
    zoom.on = false;
    zoom.z = 1;
    zoom.level = zoomLevel;

    screenStream = await getScreen(systemAudio);
    if (screenStream.warning) warnings.push(screenStream.warning);
    screenStream.getVideoTracks()[0].addEventListener('ended', () => onEnded && onEnded());

    try {
      micStream = await getMic(micId);
    } catch (err) {
      warnings.push('Microphone not available: ' + err.message);
      micStream = null;
    }

    video = document.createElement('video');
    video.muted = true;
    video.srcObject = screenStream;
    await video.play();

    canvas = document.createElement('canvas');
    canvas.width = video.videoWidth & ~1;     // H.264 wants even sizes
    canvas.height = video.videoHeight & ~1;
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    zoom.cx = canvas.width / 2;
    zoom.cy = canvas.height / 2;
    drawFrame();
    drawTimer = setInterval(drawFrame, 1000 / FPS);

    // Mix PC sound + mic into one track.
    const tracks = [...canvas.captureStream(FPS).getVideoTracks()];
    const audioSources = [screenStream, micStream].filter(s => s && s.getAudioTracks().length);
    if (audioSources.length) {
      audioCtx = new AudioContext({ sampleRate: 48000 });
      const mix = audioCtx.createMediaStreamDestination();
      for (const s of audioSources) audioCtx.createMediaStreamSource(s).connect(mix);
      tracks.push(...mix.stream.getAudioTracks());
    }

    const [mimeType, ext] = pickFormat();
    const pixels = canvas.width * canvas.height;
    mediaRecorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: clamp(Math.round(pixels * FPS * 0.1), 4e6, 20e6),
      audioBitsPerSecond: 160000,
    });
    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      // Keep chunks in order: each write waits for the one before it.
      writes = writes.then(() => e.data.arrayBuffer()).then((buf) => window.focusrec.fileChunk(buf));
    };

    return { ext, width: canvas.width, height: canvas.height, hasAudio: audioSources.length > 0, warnings };
  }

  function begin() {
    writes = Promise.resolve();
    mediaRecorder.start(1000);   // hand over a chunk every second
  }

  function pause() { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause(); }
  function resume() { if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume(); }

  function release() {
    mediaRecorder = null;
    clearInterval(drawTimer);
    drawTimer = null;
    for (const s of [screenStream, micStream]) if (s) s.getTracks().forEach(t => t.stop());
    screenStream = micStream = null;
    if (audioCtx) audioCtx.close();
    audioCtx = null;
    if (video) video.srcObject = null;
    video = canvas = ctx = null;
    onEnded = null;
  }

  // Stop recording and wait until every chunk is written.
  async function stop() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        mediaRecorder.addEventListener('stop', resolve, { once: true });
        mediaRecorder.stop();
      });
    }
    await writes;
    release();
  }

  function setMouse(m) {
    if (!m.inside) return;
    mouse.nx = clamp(m.nx, 0, 1);
    mouse.ny = clamp(m.ny, 0, 1);
  }

  function toggleZoom() {
    zoom.on = !zoom.on;
    return zoom.on;
  }

  function setZoomLevel(level) {
    zoom.level = clamp(level, 1.5, 3);
    return zoom.level;
  }

  return { prepare, begin, pause, resume, stop, release, setMouse, toggleZoom, setZoomLevel, get zoomLevel() { return zoom.level; } };
})();
