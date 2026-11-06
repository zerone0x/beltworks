// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Purity rules for the simulation (`src/sim/**`): it must stay deterministic and
 * runnable in Node, so no rendering/UI/DOM imports and no ambient clocks or randomness.
 * See docs/ARCHITECTURE.md and docs/TOOLING.md.
 */
const simPurity = {
  files: ['src/sim/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'pixi.js', message: 'src/sim must not depend on rendering.' }],
        patterns: [
          {
            group: ['pixi.js/*', '@pixi/*'],
            message: 'src/sim must not depend on rendering.',
          },
          {
            group: ['**/render', '**/render/**', '**/ui', '**/ui/**'],
            message: 'src/sim must not import from src/render or src/ui.',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      ...['window', 'document', 'navigator', 'localStorage', 'sessionStorage'].map((name) => ({
        name,
        message: 'src/sim must not touch the DOM or browser APIs.',
      })),
      ...['requestAnimationFrame', 'setTimeout', 'setInterval'].map((name) => ({
        name,
        message: 'src/sim must not schedule work; ticks are driven by the worker.',
      })),
    ],
    'no-restricted-properties': [
      'error',
      {
        object: 'Math',
        property: 'random',
        message: 'Use the seeded Rng from src/sim/rng.ts.',
      },
      {
        object: 'Date',
        property: 'now',
        message: 'src/sim has no clock; use the tick counter.',
      },
      {
        object: 'performance',
        property: 'now',
        message: 'src/sim has no clock; use the tick counter.',
      },
      ...['window', 'document'].map((property) => ({
        object: 'globalThis',
        property,
        message: 'src/sim must not touch the DOM.',
      })),
    ],
  },
};

export default defineConfig(
  { ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/sim/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/sim/**/*.ts'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  {
    files: ['*.config.{js,ts}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  simPurity,
  prettier,
);
