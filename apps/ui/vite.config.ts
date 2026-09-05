import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * The kiosk bundle.
 *
 * `base: './'` because the panel is served from a local file path as often as
 * from the server's own origin, and an absolute base breaks the first case
 * silently.
 *
 * Everything is bundled and self-hosted. The device has no guarantee of
 * reaching a CDN, and a UI that degrades to a fallback font would break every
 * measurement in SCREENS.md.
 */
export default defineConfig({
  base: './',
  plugins: [svelte()],
  resolve: {
    alias: {
      // Same rule as the test config: resolve the workspace package to source,
      // so a dev build can never run against a stale `dist`.
      '@joshify/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The server is the only origin the panel talks to; proxying in dev keeps
    // the UI's URLs identical to the ones it will use on the device.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist-web',
    // The Pi 5 runs a current Chromium; there is no older target to serve.
    target: 'chrome120',
    sourcemap: true,
  },
});
