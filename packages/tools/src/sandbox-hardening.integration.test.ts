import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import { SandboxSession } from './sandbox';

// Real-container proof of TICKET-3 hardening. Skips cleanly when Docker is unavailable.
let dockerOk = false;
try {
  await new Docker().ping();
  dockerOk = true;
} catch {
  dockerOk = false;
}
const suite = dockerOk ? describe : describe.skip;

suite('Sandbox hardening (live Docker, TICKET-3)', () => {
  let s: SandboxSession;

  beforeAll(() => {
    // 4 MiB scratch quota so the disk-quota assertion is fast.
    s = new SandboxSession({ image: 'alpine:3', hardened: true, tmpfsBytes: 4 * 1024 * 1024 });
  });
  afterAll(async () => {
    await s?.dispose().catch(() => undefined);
  });

  it('read-only root: writing to / fails; /work and /tmp (tmpfs) are writable', async () => {
    const root = await s.exec('echo x > /rootfile.txt');
    expect(root.exitCode).not.toBe(0); // read-only root filesystem

    const work = await s.exec('echo ok > /work/a.txt && cat /work/a.txt');
    expect(work.exitCode).toBe(0);
    expect(work.stdout).toContain('ok');

    const tmp = await s.exec('echo t > /tmp/t.txt && cat /tmp/t.txt');
    expect(tmp.exitCode).toBe(0);
    expect(tmp.stdout).toContain('t');
  }, 60_000);

  it('disk quota: exceeding the tmpfs scratch size is a controlled failure (not a host fill)', async () => {
    const big = await s.exec('dd if=/dev/zero of=/work/big bs=1M count=32 2>&1; echo RC=$?');
    // Either dd fails (non-zero) or the shell reports a non-zero RC — the write is bounded by the 4 MiB tmpfs.
    expect(big.stdout + big.stderr).toMatch(/No space left|RC=[1-9]/);
  }, 60_000);

  it('describeHardening reports the applied posture', () => {
    const h = s.describeHardening();
    expect(h.hardened).toBe(true);
    expect(h.readonlyRootfs).toBe(true);
    expect(h.networkDeny).toBe(true);
  });
});
