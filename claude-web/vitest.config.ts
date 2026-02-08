import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000, // Some tests involve timers and real server
    hookTimeout: 15_000,
  },
});
