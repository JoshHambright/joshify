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
