import { defineConfig } from 'vitest/config';

// TICKET-6: enable the automatic JSX runtime so component smoke tests (.tsx) compile without an explicit
// React import. Node environment is fine — the mobile smoke test uses react-dom/server (no DOM needed).
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: { environment: 'node' },
});
