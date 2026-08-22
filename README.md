# Tonicc's VRChat IMAX GIF Maker

A static web app that turns frames captured with the IMAX Camera VRChat avatar
addon into an animated GIF. Everything - decoding, resizing, color correction,
encoding, compression - runs in the visitor's browser. Nothing is uploaded,
there is no backend, and there is no account.

## How it works

Two stages, which is the trick to getting good quality *and* small files:

1. **[gifski](https://github.com/ImageOptim/gifski)** (WebAssembly, in a Web
   Worker) encodes the frames. It builds a separate palette per frame and
   applies temporal dithering, so it looks far better than a typical GIF encoder.
2. **[gifsicle](https://www.lcdf.org/gifsicle/)** (WebAssembly) then squeezes the
   result with `-O3` inter-frame differencing plus optional lossy LZW and palette
   reduction. This is the same approach ezgif uses, and it's where most of the
   size reduction comes from - typically 30-40% at the default `--lossy=30`.

If the gifsicle stage fails, or returns a *larger* file, the app keeps gifski's
output rather than failing the render.

## Controls

| Control | What it does |
| --- | --- |
| **Speed** | Percentage of the capture rate. 100% is real time; range is 1-200%. |
| **File name** | What the GIF is called when downloaded. Sanitized for Windows. |
| **Size** | Output width. Defaults to 800 px, the camera's native capture width. |
| **Quality** | gifski's encoding quality, 1-100. Default 80. |
| **Compression** | The gifsicle pass: lossy amount and optional palette reduction. |
| **Color** | Brightness, contrast and saturation, each as a percentage. |
| **Flip** | Mirror horizontally or vertically, from the preview's transport row. |

## If you fork this

gifski is **AGPL-3.0-or-later** and gifsicle is **GPL-2.0**. Both are copyleft,
and this app ships both to every visitor, so any public deployment has to make
its own source available. Point the constant at the top of `src/main.js` at your
repository, or the footer's source link will lead back here:

```js
const SOURCE_URL = 'https://github.com/YOUR-USERNAME/imax-camera-gif-maker';
```

## Local development

```bash
npm install
```

```bash
npm run dev
```

To check the production build the way it will actually be served:

```bash
npm run build && npm run preview
```

## Deploying to Cloudflare Pages

Connect the repo and use:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(leave blank)* |

No `NODE_VERSION` variable is needed: `.nvmrc` pins Node 22, which Cloudflare
reads automatically. Cloudflare's default is older than Vite supports, so
without that file the build fails with an unhelpful error.

`public/_headers` is copied into `dist` automatically and does two important
things:

- **`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`** - these make
  the page cross-origin isolated, which is what unlocks `SharedArrayBuffer` and
  therefore gifski's *multithreaded* encoder. Without them everything still
  works, just several times slower on a single thread.
- **A strict `Content-Security-Policy`** - `default-src 'self'` with no external
  origins permitted. This is what makes "your photos stay on your machine" an
  enforced property rather than a promise. Fonts and both WASM binaries are
  bundled and served from the same origin, so nothing needs to reach out.

After deploying, open the live site and check `crossOriginIsolated` in the
console. It must return `true`; if it doesn't, the headers aren't being applied
and gifski has quietly fallen back to single-threaded.

> **On GitHub Pages:** the app works, but GH Pages cannot send custom response
> headers, so you lose cross-origin isolation and gifski silently drops to
> single-threaded. That's the main reason this targets Cloudflare Pages.

## Project layout

```
index.html               markup and copy
public/_headers          Cloudflare headers: COOP/COEP + CSP
public/ToniccHeart.ico   favicon
public/icon.svg          PWA icon
src/main.js              state, UI wiring, preview player
src/frames.js            file intake, natural-order sorting, thumbnails
src/encoder.js           the two-stage render pipeline
src/gifski.worker.js     gifski, off the main thread
src/style.css            all styling
vite.config.js           build config, dev-server headers, PWA
.nvmrc                   Node version for Cloudflare Pages
```

## Notes

- **Frame order** comes from a numeric-aware sort on the filename. VRChat's
  `VRChat_2026-08-15_14-32-01.123_800x450.png` naming already sorts into shot
  order, and `frame2` correctly precedes `frame10`. Frames can be dragged to
  reorder if anything lands wrong.
- **Speed.** The control is a percentage of the capture rate, not a raw frame
  rate. The camera trips the shutter every 5 keyframes of a Unity animation and
  Unity animates at 60 fps, so 100% is 60/5 = 12 fps - real time. The range runs
  1% to 200%, i.e. 0.12 fps to 24 fps. Those constants live at the top of
  `src/main.js`; if the addon's capture interval ever changes, change
  `KEYFRAMES_PER_CAPTURE` and everything else follows.
- **Timing.** GIF stores frame delays in hundredths of a second, so the app
  reports the *quantized* delay (12 fps → 80 ms) rather than the nominal one,
  and encodes that exact value via `frameDurations` so the file matches what the
  UI showed. Above 20 fps (167% speed) the grid gets coarse enough that playback
  turns uneven, and the UI says so.
- **Color correction** is a canvas filter string built by `colorFilter()`. The
  same string is used for the on-screen preview and for rasterizing frames on
  the way into the encoder, so the preview cannot drift away from the export.
  At neutral it resolves to `'none'` and the filter work is skipped entirely.
- **Flipping** works the same way. `applyFlip()` in `src/encoder.js` builds one
  canvas matrix that both the preview and the rasterizer use, so orientation
  cannot diverge between what you see and what you download. The buttons sit on
  the preview's transport row rather than in a drawer, so the result is visible
  the instant you click - which is what you want for a correction you apply by
  eye, usually to undo a mirrored capture.
- **Looping.** Every GIF loops forever; there is no control for it. Worth
  knowing if you add one back: gifski's `repeat` is `-1` for infinite, `0` for
  play-once, and `n` for n extra loops - the opposite of what you'd guess. The
  gifsicle stage restates the loop count explicitly so it can't be lost during
  optimization.
- **Layout.** The whole page is zoomed to 110% via `zoom` on the root element.
  CSS `zoom` does not affect media-query evaluation, so every breakpoint in
  `style.css` is its design width multiplied by 1.1. Change one and change the
  other.
- **Console warnings.** gifsicle prints `too many colors, using local colormaps`
  during the compression pass. That is expected and harmless: it means gifski's
  per-frame palettes were preserved instead of being flattened into one global
  palette.
- **Offline.** The app registers a service worker and precaches itself, so it
  works with no connection once loaded. Note that after you deploy an update,
  visitors get it on their *second* load - that's normal service-worker
  behavior.

## License

This project is **AGPL-3.0-or-later**, inherited from gifski.

Everything below is bundled into the build and served from this origin - nothing
is fetched from a third party at runtime.

| Component | License |
| --- | --- |
| [gifski](https://github.com/ImageOptim/gifski), via [gifski-wasm](https://github.com/jamsinclair/gifski-wasm) | AGPL-3.0-or-later |
| [gifsicle](https://www.lcdf.org/gifsicle/), via [gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser) | GPL-2.0 only |
| [IBM Plex Sans and IBM Plex Mono](https://github.com/IBM/plex) | OFL-1.1 |

One thing worth knowing: `gifsicle-wasm-browser` declares MIT in its
`package.json`. That covers the JavaScript wrapper only - the gifsicle binary
embedded inside it is still GPL-2.0, and a wrapper cannot relicense what it
wraps.
