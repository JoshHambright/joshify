import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * The review build: the real panel in one self-contained file.
 *
 * Everything is inlined — JS, CSS, the covers are data URIs already — so the
 * page opens from a file path or a published URL with no network at all. A
 * prototype that needs a server is a prototype nobody looks at (D-016).
 */
export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: './',
  plugins: [svelte()],
  resolve: {
    alias: {
      '@joshify/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-demo', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    // One file: no separate chunk or stylesheet to lose.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
