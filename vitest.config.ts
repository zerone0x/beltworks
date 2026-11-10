import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/sim/**/*.test.ts',
      'tests/worker/**/*.test.ts',
      'tests/render/**/*.test.ts',
      'tests/audio/**/*.test.ts',
      'tests/blueprint/**/*.test.ts',
      'tests/gpu/**/*.test.ts',
    ],
    environment: 'node',
  },
});
