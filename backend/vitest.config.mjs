import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    testTimeout: 15000,
    // Each test file gets its own process so module-level state
    // (better-sqlite3 handle, license mock) never bleeds across files.
    pool: 'forks',
    isolate: true,
  },
});
