import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enter system (RLS-bypass) context so the live-DB integration test isn't denied by Row-Level
    // Security when creating/reading workspace-scoped rows.
    setupFiles: ['./vitest.setup.ts'],
  },
});
