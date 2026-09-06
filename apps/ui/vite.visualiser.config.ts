import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The visualiser review build: the real shaders in one self-contained file.
 *
 * No Svelte plugin — nothing here is a component. Everything is inlined so the
 * page opens from a file path or a published URL with no network at all, which
 * matters more here than for the panel: every effect reads the album art, so a
 * cover that fails to load makes the whole library look broken.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@joshify/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-visualiser', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./demo/visualiser.html', import.meta.url)),
    },
  },
});
