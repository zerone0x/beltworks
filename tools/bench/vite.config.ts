import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Bundles the benchmark runner (tools/bench/run.ts) for Node, so it runs the
 * simulation compiled the same way the game ships it. `npm run bench` builds
 * this into node_modules/.cache/beltworks-bench, then runs the output.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  logLevel: 'warn',
  build: {
    ssr: 'tools/bench/run.ts',
    outDir: 'node_modules/.cache/beltworks-bench',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
  },
});
