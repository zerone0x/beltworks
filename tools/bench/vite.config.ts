import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Bundles the benchmark runner (tools/bench/run.ts) and the splitter
 * micro-benchmark (tools/bench/splittersMain.ts) for Node, so they run the
 * simulation compiled the same way the game ships it. `npm run bench` and
 * `npm run bench:splitters` build both into node_modules/.cache/beltworks-bench,
 * then run their output.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  logLevel: 'warn',
  build: {
    ssr: true,
    rollupOptions: {
      input: { run: 'tools/bench/run.ts', splitters: 'tools/bench/splittersMain.ts' },
      output: { entryFileNames: '[name].js' },
    },
    outDir: 'node_modules/.cache/beltworks-bench',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
  },
});
