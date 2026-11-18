// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat ESLint config for the AgentOS monorepo.
 * Key rule: the brand-literal guard (§34.6) — the product display name and deep-link
 * scheme may ONLY be authored in packages/brand. CI fails if a literal sneaks in elsewhere,
 * guaranteeing trivial rename via a single source of truth.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/release/**',
      '_research/**',
      'docs/**',
      '**/*.config.{js,cjs,mjs,ts}',
      '**/next-env.d.ts',
      'tooling/scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Brand-literal guard — applies everywhere EXCEPT the single source of truth.
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: ['packages/brand/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='AgentOS']",
          message:
            "Do not hard-code the product name 'AgentOS'. Import BRAND from '@agentos/brand' (single source of identity — keeps the product trivially renameable).",
        },
        {
          selector: "Literal[value='agentos']",
          message:
            "Do not hard-code the brand slug/scheme 'agentos'. Import BRAND from '@agentos/brand' instead.",
        },
      ],
    },
  },
);
