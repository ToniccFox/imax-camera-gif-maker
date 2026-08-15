/**
 * gifski runs off the main thread so the UI keeps painting.
 *
 * The `/multi-thread` entry point detects SharedArrayBuffer + cross-origin
 * isolation at init time and transparently falls back to the single-threaded
 * build when either is missing, so this one import covers both cases.
 */
import encode from 'gifski-wasm/multi-thread';

self.onmessage = async ({ data }) => {
  const { buffers, width, height, frameDurations, quality, repeat } = data;

  try {
    // Frames arrive as transferred RGBA buffers; gifski accepts raw Uint8Arrays.
    const frames = buffers.map((buffer) => new Uint8Array(buffer));

    const gif = await encode({ frames, width, height, frameDurations, quality, repeat });

    self.postMessage({ ok: true, gif });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message ?? String(error) });
  }
};
