import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFile, buildAppUrl, APP_SCHEME } from './app-protocol';

describe('buildAppUrl', () => {
  it('builds an app://local URL, adding a leading slash', () => {
    expect(buildAppUrl('/')).toBe(`${APP_SCHEME}://local/`);
    expect(buildAppUrl('settings')).toBe(`${APP_SCHEME}://local/settings`);
  });
});

describe('resolveFile', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'webroot-'));
    writeFileSync(join(root, 'index.html'), '<html></html>');
    mkdirSync(join(root, '_next'), { recursive: true });
    writeFileSync(join(root, '_next', 'app.js'), '//js');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('serves index.html for the root path', () => {
    expect(resolveFile(root, '/')).toBe(join(root, 'index.html'));
  });

  it('serves an existing asset', () => {
    expect(resolveFile(root, '/_next/app.js')).toBe(join(root, '_next', 'app.js'));
  });

  it('falls back to index.html for an extension-less client route (SPA)', () => {
    expect(resolveFile(root, '/library')).toBe(join(root, 'index.html'));
  });

  it('returns null for a missing asset with an extension', () => {
    expect(resolveFile(root, '/missing.js')).toBeNull();
  });

  it('refuses a path-traversal attempt', () => {
    expect(resolveFile(root, '/../../etc/passwd')).toBeNull();
    expect(resolveFile(root, '/..%2f..%2fsecret')).toBeNull();
  });

  it('refuses a malformed percent-encoding instead of throwing', () => {
    expect(resolveFile(root, '/%E0%A4%A')).toBeNull();
    expect(resolveFile(root, '/%')).toBeNull();
  });
});
