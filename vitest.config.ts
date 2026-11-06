import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/sim/**/*.test.ts', 'tests/worker/**/*.test.ts', 'tests/render/**/*.test.ts'],
    environment: 'node',
  },
});
