import { describe, it, expect } from 'vitest';
import { buildSandboxHostConfig, type SandboxHostConfigParams } from './sandbox';
import { safeResolve } from './fs-tools';

const base: SandboxHostConfigParams = {
  memoryBytes: 256 * 1024 * 1024,
  pidsLimit: 256,
  cpus: 1,
  maxFileBytes: 128 * 1024 * 1024,
  networkDisabled: true,
  hardened: false,
  tmpfsBytes: 256 * 1024 * 1024,
  workdir: '/work',
  persistPath: '/persist',
};

describe('buildSandboxHostConfig (TICKET-3)', () => {
  it('always-on hardening holds regardless of the flag', () => {
    const c = buildSandboxHostConfig({ ...base, hardened: false });
    expect(c.CapDrop).toEqual(['ALL']);
    expect(c.SecurityOpt).toEqual(['no-new-privileges']);
    expect(c.NetworkMode).toBe('none'); // default-deny egress
    expect(c.Memory).toBe(256 * 1024 * 1024);
    expect(c.PidsLimit).toBe(256);
    // flag off => no new behavior (byte-identical to legacy)
    expect(c.ReadonlyRootfs).toBeUndefined();
    expect(c.Tmpfs).toBeUndefined();
    expect(c.OomKillDisable).toBeUndefined();
  });

  it('hardened: read-only root + writable tmpfs scratch for /work and /tmp + explicit OOM', () => {
    const c = buildSandboxHostConfig({ ...base, hardened: true });
    expect(c.ReadonlyRootfs).toBe(true);
    expect(c.OomKillDisable).toBe(false);
    expect(c.Tmpfs?.['/tmp']).toMatch(/size=268435456/);
    expect(c.Tmpfs?.['/work']).toMatch(/rw,nosuid,nodev,size=268435456/);
  });

  it('hardened + coding bind at workdir: /work is the writable bind (not tmpfs); /tmp still tmpfs', () => {
    const c = buildSandboxHostConfig({ ...base, hardened: true, hostMount: { source: '/host/x', target: '/work' } });
    expect(c.Tmpfs?.['/work']).toBeUndefined(); // bind already writable — not double-mounted
    expect(c.Tmpfs?.['/tmp']).toBeDefined();
    expect(c.Binds).toContain('/host/x:/work');
    expect(c.ReadonlyRootfs).toBe(true);
  });

  it('hardened + persistent volume: persistPath is the volume (not tmpfs)', () => {
    const c = buildSandboxHostConfig({ ...base, hardened: true, persistVolume: 'vol', persistPath: '/persist' });
    expect(c.Tmpfs?.['/persist']).toBeUndefined();
    expect(c.Binds).toContain('vol:/persist');
  });

  it('read-only host bind keeps its :ro suffix', () => {
    const c = buildSandboxHostConfig({ ...base, hardened: true, hostMount: { source: '/host/x', target: '/ref', readOnly: true } });
    expect(c.Binds).toContain('/host/x:/ref:ro');
  });

  it('network stays bridge only when explicitly enabled', () => {
    expect(buildSandboxHostConfig({ ...base, hardened: true, networkDisabled: false }).NetworkMode).toBe('bridge');
  });
});

describe('safeResolve path-escape (TICKET-3 coverage)', () => {
  const root = process.cwd();
  it('blocks ../ traversal and absolute escapes; allows in-root paths', () => {
    expect(safeResolve(root, '../etc/passwd')).toBeNull();
    expect(safeResolve(root, '../../..')).toBeNull();
    expect(safeResolve(root, 'sub/dir/ok.txt')).not.toBeNull();
    expect(safeResolve(root, '.')).toBe(root);
  });
});
