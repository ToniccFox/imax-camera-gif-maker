/**
 * The render pipeline, in two stages.
 *
 *   1. gifski   - builds the GIF with per-frame palettes and temporal dithering.
 *                 Great looking, but it optimizes for quality over size.
 *   2. gifsicle - squeezes the finished file: inter-frame differencing, lossy
 *                 LZW, optional palette reduction. This is the stage ezgif
 *                 leans on, and it's where most of the size drop comes from.
 *
 * Stage 2 is best-effort. If it fails or comes back bigger, we ship stage 1's
 * output rather than failing the whole render.
 */
import gifsicle from 'gifsicle-wasm-browser';
import GifskiWorker from './gifski.worker.js?worker';

/**
 * Point the canvas at the requested orientation. Exported so the preview builds
 * the identical matrix - the two cannot disagree about which way is up.
 */
export function applyFlip(ctx, width, height, flipH, flipV) {
  ctx.setTransform(
    flipH ? -1 : 1, 0,
    0, flipV ? -1 : 1,
    flipH ? width : 0, flipV ? height : 0,
  );
}

/** Reset to an untransformed canvas. */
export function resetTransform(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Draw every frame to the output size and hand back raw RGBA buffers. Color
 * correction and mirroring are baked in here using the exact same filter string
 * and transform the preview drew with.
 */
function rasterize(frames, width, height, filter, flipH, flipV) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = filter;

  return frames.map((frame) => {
    // Clear rather than fill: VRChat can emit PNGs with alpha, and gifski maps
    // that onto GIF's single transparent index.
    resetTransform(ctx);
    ctx.clearRect(0, 0, width, height);
    applyFlip(ctx, width, height, flipH, flipV);
    ctx.drawImage(frame.bitmap, 0, 0, width, height);
    resetTransform(ctx);
    return ctx.getImageData(0, 0, width, height).data.buffer;
  });
}

function runGifski(payload, transfer) {
  return new Promise((resolve, reject) => {
    const worker = new GifskiWorker();

    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.ok) resolve(data.gif);
      else reject(new Error(data.error));
    };

    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The GIF encoder crashed.'));
    };

    worker.postMessage(payload, transfer);
  });
}

/** Restate the loop setting for gifsicle rather than trusting it to survive -O3. */
function loopFlag(repeat) {
  if (repeat < 0) return '--loopcount=forever';
  if (repeat === 0) return '--no-loopcount';
  return `--loopcount=${repeat}`;
}

async function runGifsicle(bytes, { lossy, colors, repeat }) {
  // -O3 is gifsicle's most aggressive lossless pass: it rewrites each frame as
  // a diff against the previous one and drops redundant pixels to transparency.
  const flags = ['-O3', loopFlag(repeat)];
  if (lossy > 0) flags.push(`--lossy=${lossy}`);
  if (colors > 0) flags.push(`--colors=${colors}`);

  const output = await gifsicle.run({
    input: [{ file: new Blob([bytes], { type: 'image/gif' }), name: 'in.gif' }],
    command: [`${flags.join(' ')} in.gif -o /out/out.gif`],
  });

  if (!output?.length) throw new Error('gifsicle returned no output');
  return new Uint8Array(await output[0].arrayBuffer());
}

/**
 * @param {object} options
 * @param {(label: string, determinate: boolean) => void} options.onStage
 * @returns {Promise<{blob: Blob, size: number, rawSize: number, optimized: boolean}>}
 */
export async function renderGif({
  frames,
  width,
  height,
  delayMs,
  quality,
  repeat,
  filter,
  flipH,
  flipV,
  optimize,
  lossy,
  colors,
  onStage,
}) {
  onStage('Preparing frames', true);
  const buffers = rasterize(frames, width, height, filter, flipH, flipV);

  // Explicit per-frame durations rather than an fps figure. The speed control
  // reaches fractional rates (1% of 12 fps is 0.12 fps), and passing the delay
  // directly guarantees the file carries exactly the timing the UI reported.
  const frameDurations = new Array(buffers.length).fill(Math.round(delayMs));

  onStage('Encoding with gifski', false);
  const raw = await runGifski(
    { buffers, width, height, frameDurations, quality, repeat },
    buffers, // zero-copy handoff
  );

  let final = raw;
  let optimized = false;

  if (optimize) {
    onStage('Compressing with gifsicle', false);
    try {
      const squeezed = await runGifsicle(raw, { lossy, colors, repeat });
      // Optimization can backfire on already-tight files; keep the winner.
      if (squeezed.byteLength < raw.byteLength) {
        final = squeezed;
        optimized = true;
      }
    } catch (error) {
      console.warn('gifsicle pass failed; keeping gifski output.', error);
    }
  }

  return {
    blob: new Blob([final], { type: 'image/gif' }),
    size: final.byteLength,
    rawSize: raw.byteLength,
    optimized,
  };
}
