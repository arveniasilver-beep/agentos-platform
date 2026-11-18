import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites share one live Postgres/Redis and some operate DB-wide (e.g. the boot reaper
    // fails all running-state tasks). Run files sequentially so they can't interfere with each other.
    fileParallelism: false,
    // Enter system (RLS-bypass) context so integration tests using the raw client aren't denied.
    setupFiles: ['./vitest.setup.ts'],
  },
});
