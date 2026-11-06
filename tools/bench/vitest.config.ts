import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Tests of the benchmark tooling (tests/bench), run by `npm run test:bench`. */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/bench/**/*.test.ts'],
    environment: 'node',
  },
});
