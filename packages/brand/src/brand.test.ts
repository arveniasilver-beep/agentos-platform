import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND, BRAND_REQUIRED_KEYS } from './index';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const REPO_ROOT = findRepoRoot(process.cwd());
const SCAN_ROOTS = ['apps', 'services', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.next', '.turbo', 'coverage', 'release']);
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|jsx)$/;

// Match the brand name/slug ONLY as a quoted string literal — this mirrors the ESLint AST
// guard, so comments or docs mentioning the product never false-positive.
const BANNED = [/["'`]AgentOS["'`]/, /["'`]agentos["'`]/];

function walk(dir: string, out: string[]): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return; // dir may not exist yet in early phases
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (CODE_EXT.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
}

describe('brand identity', () => {
  it('defines every required key as a non-empty string', () => {
    for (const key of BRAND_REQUIRED_KEYS) {
      expect(typeof BRAND[key]).toBe('string');
      expect(BRAND[key].length).toBeGreaterThan(0);
    }
  });

  it('uses a valid deep-link scheme and reverse-DNS app id', () => {
    expect(BRAND.protocol).toMatch(/^[a-z][a-z0-9+.-]*$/);
    expect(BRAND.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
  });
});

describe('rename-guard (single source of identity)', () => {
  it('no brand-name string literal exists outside packages/brand', () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);

    const brandDir = join(REPO_ROOT, 'packages', 'brand');
    const offenders: string[] = [];
    for (const file of files) {
      if (file.startsWith(brandDir)) continue; // the single source is allowed
      const text = readFileSync(file, 'utf8');
      if (BANNED.some((re) => re.test(text))) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(
      offenders,
      `Hard-coded brand literal found outside packages/brand:\n${offenders.join('\n')}\n` +
        'Import BRAND from "@agentos/brand" instead.',
    ).toEqual([]);
  });
});
