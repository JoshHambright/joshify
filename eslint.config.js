import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import svelteConfig from './apps/ui/svelte.config.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-web/**',
      '**/dist-demo/**',
      '**/dist-visualiser/**',
      '**/coverage/**',
      'site/**',
      'spikes/**',
      'eslint.config.js',
      'vitest.config.ts',
      'apps/ui/svelte.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // `.svelte` is not a extension the project service recognises on its
        // own, and without this every component is a parse error.
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    /*
     * The one-file packer that folds the visualiser build into an artifact
     * page. Plain `.mjs` and outside every tsconfig on purpose: it is a build
     * step, not application code, and putting it in the UI's project would
     * drag Node's fs types into a browser bundle's type graph.
     */
    ...tseslint.configs.disableTypeChecked,
    files: ['apps/ui/demo/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', URL: 'readonly' },
      parserOptions: { projectService: false, project: false },
    },
  },
  {
    // The end-to-end suite and its harness. Node globals, and the harness is
    // deliberately plain `.mjs` — adding a TypeScript loader to start a
    // process would put a second build path between the test and the artefact
    // it is meant to be testing.
    files: ['e2e/**/*.{ts,mjs}', 'playwright.config.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
      parserOptions: {
        projectService: false,
        project: ['./e2e/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        // The Svelte parser needs the TS parser for `<script lang="ts">`, and
        // the compiler config so it agrees with the build about runes mode.
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
        svelteConfig,
      },
    },
    rules: {
      // TypeScript resolves the DOM lib for these files; core's `no-undef` does
      // not know about it and would flag every browser global.
      'no-undef': 'off',
      // A template is full of `{value ?? fallback}` on values the compiler
      // already knows are nullable; these two fire on almost every one and
      // say nothing a reader of the markup does not already see.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
