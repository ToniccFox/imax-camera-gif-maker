import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './style.css';

import { loadFrames, disposeFrame, sameDimensions } from './frames.js';
import { renderGif } from './encoder.js';

// gifski (AGPL-3.0) and gifsicle (GPL-2.0) are both copyleft, so a public
// deployment has to offer its source. This is the link rendered in the footer;
// a fork needs to repoint it at its own repository.
const SOURCE_URL = 'https://github.com/ToniccFox/imax-camera-gif-maker';

// Past this, holding every decoded frame in memory starts to hurt.
const FRAME_SOFT_LIMIT = 120;

// The IMAX Camera trips the shutter every 5 keyframes of a Unity animation, and
// Unity animates at 60 fps by default. So 100% speed - real time - is 12 fps.
// Everything else is a percentage of that.
const UNITY_FPS = 60;
const KEYFRAMES_PER_CAPTURE = 5;
const BASE_FPS = UNITY_FPS / KEYFRAMES_PER_CAPTURE;

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  stripPanel: $('stripPanel'),
  frameList: $('frameList'),
  frameCount: $('frameCount'),
  addMoreBtn: $('addMoreBtn'),
  clearBtn: $('clearBtn'),
  sizeWarn: $('sizeWarn'),

  previewPanel: $('previewPanel'),
  previewCanvas: $('previewCanvas'),
  previewMeta: $('previewMeta'),
  playBtn: $('playBtn'),
  scrub: $('scrub'),
  scrubLabel: $('scrubLabel'),

  speed: $('speed'),
  speedReadout: $('speedReadout'),
  speedPresets: $('speedPresets'),
  fpsWarn: $('fpsWarn'),
  fpsFact: $('fpsFact'),
  delayFact: $('delayFact'),
  lengthFact: $('lengthFact'),

  sizePreset: $('sizePreset'),
  customWidthField: $('customWidthField'),
  customWidth: $('customWidth'),
  sizeReadout: $('sizeReadout'),

  quality: $('quality'),
  qualityReadout: $('qualityReadout'),

  optimize: $('optimize'),
  optimizeLabel: $('optimizeLabel'),
  optBody: $('optBody'),
  lossy: $('lossy'),
  lossyReadout: $('lossyReadout'),
  colors: $('colors'),
  loop: $('loop'),

  renderBtn: $('renderBtn'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressLabel: $('progressLabel'),
  error: $('error'),

  resultPanel: $('resultPanel'),
  resultImg: $('resultImg'),
  savedBadge: $('savedBadge'),
  rSize: $('rSize'),
  rDims: $('rDims'),
  rFrames: $('rFrames'),
  rDuration: $('rDuration'),
  rCompression: $('rCompression'),
  downloadBtn: $('downloadBtn'),

  sourceLink: $('sourceLink'),
};

const state = {
  frames: [],
  speed: 100, // percent of capture speed
  quality: 80,
  optimize: true,
  lossy: 30,
  colors: 0,
  loop: -1, // gifski: -1 = loop forever
  playing: true,
  playIndex: 0,
  busy: false,
  resultUrl: null,
};

const ctx = el.previewCanvas.getContext('2d');
ctx.imageSmoothingQuality = 'high';

/* ─────────────────────────── helpers ─────────────────────────── */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Frame rate the current speed percentage works out to. */
function effectiveFps() {
  return (BASE_FPS * state.speed) / 100;
}

/**
 * GIF stores delays in hundredths of a second, so the real playback rate is
 * quantised. Report - and encode - what viewers will actually do, not the
 * nominal rate.
 */
function frameDelayMs() {
  return Math.max(10, Math.round(100 / effectiveFps()) * 10);
}

/** Trim a rate to something readable: 12, 8.4, 0.12. */
function formatFps(fps) {
  return Number.isInteger(fps) ? String(fps) : String(Number(fps.toFixed(2)));
}

/** Output dimensions, derived from the first frame's aspect ratio. */
function outputSize() {
  const first = state.frames[0];
  if (!first) return null;

  const choice = el.sizePreset.value;
  let width;
  if (choice === 'native') width = first.width;
  else if (choice === 'custom') width = clamp(Number(el.customWidth.value) || 800, 16, 2048);
  else width = Number(choice);

  width = Math.max(2, Math.round(width / 2) * 2);
  const height = Math.max(2, Math.round((width * first.height) / first.width / 2) * 2);
  return { width, height };
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = !message;
}

/* ─────────────────────────── frame list ─────────────────────────── */

function renderFrameList() {
  el.frameList.replaceChildren(
    ...state.frames.map((frame, index) => {
      const li = document.createElement('li');
      li.className = 'frame';
      li.draggable = true;
      li.dataset.id = String(frame.id);
      li.title = frame.name;

      const img = document.createElement('img');
      img.src = frame.thumb;
      img.alt = '';

      const idx = document.createElement('span');
      idx.className = 'frame-idx';
      idx.textContent = index + 1;

      const remove = document.createElement('button');
      remove.className = 'frame-x';
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove frame ${index + 1}`);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeFrame(frame.id);
      });

      li.append(img, idx, remove);
      return li;
    }),
  );
}

function removeFrame(id) {
  const index = state.frames.findIndex((f) => f.id === id);
  if (index === -1) return;
  disposeFrame(state.frames[index]);
  state.frames.splice(index, 1);
  state.playIndex = 0;
  renderFrameList();
  syncUI();
}

async function addFiles(fileList) {
  showError('');
  const { frames, skipped } = await loadFrames(fileList);

  if (!frames.length) {
    showError(
      skipped.length
        ? `Couldn't read ${skipped.length === 1 ? 'that file' : 'those files'}. PNG, JPG and WebP work best.`
        : 'No images found in that drop.',
    );
    return;
  }

  state.frames.push(...frames);
  if (skipped.length) {
    showError(`Skipped ${skipped.length} unreadable file${skipped.length === 1 ? '' : 's'}.`);
  }

  renderFrameList();
  syncUI();
}

/* ─────────────────────────── drag to reorder ─────────────────────────── */

let dragId = null;

el.frameList.addEventListener('dragstart', (event) => {
  const li = event.target.closest('.frame');
  if (!li) return;
  dragId = Number(li.dataset.id);
  li.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  // Firefox needs data set for the drag to start at all.
  event.dataTransfer.setData('text/plain', li.dataset.id);
});

el.frameList.addEventListener('dragover', (event) => {
  if (dragId === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const over = event.target.closest('.frame');
  for (const node of el.frameList.children) {
    node.classList.toggle('drop-target', node === over && Number(node.dataset.id) !== dragId);
  }
});

el.frameList.addEventListener('drop', (event) => {
  if (dragId === null) return;
  event.preventDefault();

  const over = event.target.closest('.frame');
  if (over) {
    const from = state.frames.findIndex((f) => f.id === dragId);
    const to = state.frames.findIndex((f) => f.id === Number(over.dataset.id));
    if (from !== -1 && to !== -1 && from !== to) {
      const [moved] = state.frames.splice(from, 1);
      state.frames.splice(to, 0, moved);
    }
  }

  dragId = null;
  renderFrameList();
  syncUI();
});

el.frameList.addEventListener('dragend', () => {
  dragId = null;
  renderFrameList();
});

/* ─────────────────────────── dropzone ─────────────────────────── */

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.addMoreBtn.addEventListener('click', () => el.fileInput.click());

el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.fileInput.click();
  }
});

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files?.length) addFiles(el.fileInput.files);
  el.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('hot');
  });
}

for (const type of ['dragleave', 'dragend']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('hot'));
}

el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  el.dropzone.classList.remove('hot');
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

// Stop stray drops elsewhere on the page from navigating away.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

el.clearBtn.addEventListener('click', () => {
  state.frames.forEach(disposeFrame);
  state.frames = [];
  state.playIndex = 0;
  renderFrameList();
  clearResult();
  showError('');
  syncUI();
});

/* ─────────────────────────── settings ─────────────────────────── */

function setSpeed(value) {
  state.speed = clamp(Math.round(value), 1, 200);
  el.speed.value = state.speed;
  for (const button of el.speedPresets.children) {
    button.classList.toggle('on', Number(button.dataset.speed) === state.speed);
  }
  syncUI();
}

el.speed.addEventListener('input', () => setSpeed(Number(el.speed.value)));

el.speedPresets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-speed]');
  if (button) setSpeed(Number(button.dataset.speed));
});

el.sizePreset.addEventListener('change', () => {
  el.customWidthField.hidden = el.sizePreset.value !== 'custom';
  syncUI();
});
el.customWidth.addEventListener('input', syncUI);

el.quality.addEventListener('input', () => {
  state.quality = Number(el.quality.value);
  syncUI();
});

el.optimize.addEventListener('change', () => {
  state.optimize = el.optimize.checked;
  syncUI();
});

el.lossy.addEventListener('input', () => {
  state.lossy = Number(el.lossy.value);
  syncUI();
});

el.colors.addEventListener('change', () => {
  state.colors = Number(el.colors.value);
});

el.loop.addEventListener('change', () => {
  state.loop = Number(el.loop.value);
});

/* ─────────────────────────── preview ─────────────────────────── */

function setPlaying(playing) {
  state.playing = playing;
  el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  el.playBtn.innerHTML = playing
    ? '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3.5" y="2.5" width="3.4" height="11" rx="1"/><rect x="9.1" y="2.5" width="3.4" height="11" rx="1"/></svg>'
    : '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 2.6v10.8a.7.7 0 0 0 1.07.6l8.4-5.4a.7.7 0 0 0 0-1.2l-8.4-5.4A.7.7 0 0 0 4 2.6Z"/></svg>';
}

el.playBtn.addEventListener('click', () => setPlaying(!state.playing));

el.scrub.addEventListener('input', () => {
  setPlaying(false);
  state.playIndex = Number(el.scrub.value);
  drawPreview();
});

function drawPreview() {
  const frame = state.frames[state.playIndex];
  if (!frame) return;

  ctx.clearRect(0, 0, el.previewCanvas.width, el.previewCanvas.height);
  ctx.drawImage(frame.bitmap, 0, 0, el.previewCanvas.width, el.previewCanvas.height);

  el.scrub.value = state.playIndex;
  el.scrubLabel.textContent = `${state.playIndex + 1} / ${state.frames.length}`;

  for (const [index, node] of [...el.frameList.children].entries()) {
    node.classList.toggle('active', index === state.playIndex);
  }
}

let lastAdvance = 0;

function tick(now) {
  if (state.playing && state.frames.length > 1 && now - lastAdvance >= frameDelayMs()) {
    lastAdvance = now;
    state.playIndex = (state.playIndex + 1) % state.frames.length;
    drawPreview();
  }
  requestAnimationFrame(tick);
}

/* ─────────────────────────── render ─────────────────────────── */

function setStage(label, determinate) {
  el.progress.hidden = false;
  el.progressLabel.textContent = label;
  el.progressFill.classList.toggle('pulse', !determinate);
  if (determinate) el.progressFill.style.width = '18%';
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  el.resultPanel.hidden = true;
}

el.renderBtn.addEventListener('click', async () => {
  const size = outputSize();
  if (!size || state.frames.length < 2 || state.busy) return;

  state.busy = true;
  showError('');
  clearResult();
  syncUI();

  try {
    const result = await renderGif({
      frames: state.frames,
      width: size.width,
      height: size.height,
      delayMs: frameDelayMs(),
      quality: state.quality,
      repeat: state.loop,
      optimize: state.optimize,
      lossy: state.lossy,
      colors: state.colors,
      onStage: setStage,
    });

    state.resultUrl = URL.createObjectURL(result.blob);
    el.resultImg.src = state.resultUrl;
    el.downloadBtn.href = state.resultUrl;
    el.downloadBtn.download = `imax-${size.width}x${size.height}-${formatFps(effectiveFps())}fps.gif`;

    el.rSize.textContent = formatBytes(result.size);
    el.rDims.textContent = `${size.width} × ${size.height}`;
    el.rFrames.textContent = String(state.frames.length);
    el.rDuration.textContent = `${((state.frames.length * frameDelayMs()) / 1000).toFixed(2)} s`;

    if (result.optimized) {
      const saved = Math.round((1 - result.size / result.rawSize) * 100);
      el.savedBadge.textContent = `-${saved}%`;
      el.savedBadge.hidden = saved < 1;
      el.rCompression.hidden = false;
      el.rCompression.textContent = `gifsicle took this from ${formatBytes(result.rawSize)} down to ${formatBytes(result.size)}.`;
    } else {
      el.savedBadge.hidden = true;
      el.rCompression.hidden = !state.optimize;
      el.rCompression.textContent = 'Compression made no difference here, so the original encode was kept.';
    }

    el.resultPanel.hidden = false;
  } catch (error) {
    showError(error?.message ?? 'Something went wrong while rendering.');
  } finally {
    state.busy = false;
    el.progress.hidden = true;
    el.progressFill.classList.remove('pulse');
    syncUI();
  }
});

/* ─────────────────────────── sync ─────────────────────────── */

function syncUI() {
  const count = state.frames.length;
  const size = outputSize();

  el.stripPanel.hidden = count === 0;
  el.previewPanel.hidden = count === 0;
  el.dropzone.classList.toggle('slim', count > 0);
  el.frameCount.textContent = `${count} frame${count === 1 ? '' : 's'}`;

  // Speed
  el.speedReadout.textContent = `${state.speed}%`;
  el.fpsFact.textContent = `${formatFps(effectiveFps())} fps`;
  el.delayFact.textContent = `${frameDelayMs()} ms`;
  el.lengthFact.textContent = count
    ? `${((count * frameDelayMs()) / 1000).toFixed(2)} s`
    : '-';
  el.fpsWarn.hidden = effectiveFps() <= 20;

  // Size
  el.sizeReadout.textContent = size ? `${size.width} × ${size.height}` : '-';
  el.qualityReadout.textContent = String(state.quality);
  el.lossyReadout.textContent = state.lossy === 0 ? 'off' : String(state.lossy);
  el.optBody.classList.toggle('off', !state.optimize);
  el.optimizeLabel.textContent = state.optimize ? 'On' : 'Off';

  // Preview canvas follows the output size so what you see is what you get.
  if (size && (el.previewCanvas.width !== size.width || el.previewCanvas.height !== size.height)) {
    el.previewCanvas.width = size.width;
    el.previewCanvas.height = size.height;
    ctx.imageSmoothingQuality = 'high';
  }

  el.previewMeta.textContent = size ? `${size.width} × ${size.height} · ${count} frames` : '-';
  el.scrub.max = Math.max(0, count - 1);
  if (state.playIndex >= count) state.playIndex = 0;
  if (count) drawPreview();

  // Warnings
  const warnings = [];
  if (count && !sameDimensions(state.frames)) {
    warnings.push("Your frames aren't all the same size - they'll be stretched to match the first one.");
  }
  if (count > FRAME_SOFT_LIMIT) {
    warnings.push(`${count} frames is a lot to hold in memory; encoding may be slow.`);
  }
  el.sizeWarn.hidden = warnings.length === 0;
  el.sizeWarn.textContent = warnings.join(' ');

  // Render button
  el.renderBtn.disabled = state.busy || count < 2;
  if (state.busy) el.renderBtn.textContent = 'Rendering…';
  else if (count < 2) el.renderBtn.textContent = count === 1 ? 'Need at least 2 frames' : 'Render GIF';
  else el.renderBtn.textContent = `Render GIF · ${count} frames`;
}

/* ─────────────────────────── boot ─────────────────────────── */

el.sourceLink.href = SOURCE_URL;
setPlaying(true);
syncUI();
requestAnimationFrame(tick);
