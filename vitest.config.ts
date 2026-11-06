import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/sim/**/*.test.ts'],
    environment: 'node',
  },
});
