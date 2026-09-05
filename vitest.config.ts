import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Components are compiled for the test run the same way the bundle compiles
  // them, so a template that would not build cannot pass a test either.
  plugins: [
    svelte({
      configFile: fileURLToPath(new URL('./apps/ui/svelte.config.js', import.meta.url)),
    }),
  ],
  resolve: {
    // Svelte ships server and browser builds; the component tests need the
    // browser one, and without this the client runtime is never loaded.
    conditions: ['browser'],
    alias: {
      // Resolve the workspace package to its source, not dist. Tests then see
      // edits immediately and can never pass against a stale build.
      '@joshify/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts'],
    // Node by default. Only the component tests need a DOM, and they opt in
    // with a `@vitest-environment jsdom` docblock — which keeps the default a
    // standing check that the logic has no DOM in it.
    environment: 'node',
    server: {
      deps: {
        // The testing library's helpers are themselves `.svelte.js` modules, so
        // they have to go through the Svelte compiler rather than being
        // pre-bundled by esbuild — otherwise their runes throw at mount.
        inline: [/@testing-library\/svelte/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['{packages,apps}/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/testing/**', '**/main.ts'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
