import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Multithreaded gifski needs SharedArrayBuffer, which browsers only expose to
// cross-origin-isolated pages. Cloudflare Pages sends these in production from
// public/_headers; the dev and preview servers need them set here to match, or
// gifski silently falls back to its (much slower) single-threaded path.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },

  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // The gifski wasm binaries are ~300KB each; don't inline them.
    assetsInlineLimit: 4096,
  },

  // gifski-wasm resolves its own .wasm relative to the glue code. Prebundling
  // rewrites that path and breaks the fetch, so leave it alone.
  optimizeDeps: { exclude: ['gifski-wasm'] },

  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'IMAX Camera GIF Maker',
        short_name: 'GIF Maker',
        description:
          'Turn frames captured with the IMAX Camera VRChat avatar addon into a GIF, entirely in your browser.',
        theme_color: '#0c0c0e',
        background_color: '#0c0c0e',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,woff2,svg}'],
        // gifsicle's bundle and the gifski wasm blobs are well over the default cap.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});
