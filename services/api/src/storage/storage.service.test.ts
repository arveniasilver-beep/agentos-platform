import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Unit test for the local-durable blob backend (no DB / no network).
describe('StorageService (local backend)', () => {
  let root = '';
  let StorageService: typeof import('./storage.service').StorageService;
  let svc: InstanceType<typeof StorageService>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aos-store-'));
    process.env.ARTIFACT_STORE_ROOT = root;
    delete process.env.S3_ENDPOINT; // ensure the local backend is selected
    ({ StorageService } = await import('./storage.service'));
    svc = new StorageService();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects the local backend when S3 is not configured', () => {
    expect(svc.backendName).toBe('local');
  });

  it('derives a safe slash-key from server ids only', () => {
    expect(svc.keyFor('ws1', 't1', 'a1', 2)).toBe('ws1/t1/a1/v2');
  });

  it('round-trips bytes (put -> get) preserving sha256', async () => {
    const data = Buffer.from('hello durable world');
    const key = svc.keyFor('ws1', 't1', 'a1', 1);
    await svc.put(key, data, 'text/plain');
    const got = await svc.get(key);
    expect(got.equals(data)).toBe(true);
    expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('delete removes the blob', async () => {
    const key = svc.keyFor('ws1', 't1', 'a2', 1);
    await svc.put(key, Buffer.from('x'), 'text/plain');
    await svc.delete(key);
    await expect(svc.get(key)).rejects.toThrow();
  });

  it('rejects traversal / unsafe keys (no path escape)', async () => {
    await expect(svc.put('../escape', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(svc.get('a/../../b')).rejects.toThrow();
    await expect(svc.get('a//b')).rejects.toThrow();
  });
});
