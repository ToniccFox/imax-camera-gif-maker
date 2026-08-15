/**
 * Frame intake: decode dropped files into ImageBitmaps and put them in the
 * order the camera shot them.
 */

// VRChat writes files like `VRChat_2026-08-15_14-32-01.123_1920x1080.png`, so a
// numeric-aware sort on the filename already yields shot order. Numeric mode
// also keeps hand-named `frame2` ahead of `frame10`.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const THUMB_HEIGHT = 84;
const ACCEPTED = /\.(png|jpe?g|webp|gif|bmp)$/i;

let nextId = 1;

function isImage(file) {
  return file.type.startsWith('image/') || ACCEPTED.test(file.name);
}

async function makeThumb(bitmap) {
  const scale = THUMB_HEIGHT / bitmap.height;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, THUMB_HEIGHT);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
  return URL.createObjectURL(blob);
}

/**
 * @param {FileList|File[]} fileList
 * @returns {Promise<{frames: Array, skipped: string[]}>}
 */
export async function loadFrames(fileList) {
  const files = [...fileList].filter(isImage);
  files.sort((a, b) => collator.compare(a.name, b.name));

  const frames = [];
  const skipped = [];

  for (const file of files) {
    try {
      const bitmap = await createImageBitmap(file);
      frames.push({
        id: nextId++,
        name: file.name,
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        thumb: await makeThumb(bitmap),
      });
    } catch {
      skipped.push(file.name);
    }
  }

  return { frames, skipped };
}

/** Release a frame's bitmap and thumbnail URL. */
export function disposeFrame(frame) {
  frame.bitmap?.close?.();
  if (frame.thumb) URL.revokeObjectURL(frame.thumb);
}

/** True when every frame shares the same pixel dimensions. */
export function sameDimensions(frames) {
  if (frames.length < 2) return true;
  const { width, height } = frames[0];
  return frames.every((f) => f.width === width && f.height === height);
}
