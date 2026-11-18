import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import { SandboxSession, createSandboxTools } from './sandbox';
import { ToolRegistryExecutor } from './runtime';

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

describe('sandbox session (isolated Docker container)', () => {
  it('runs commands, persists the session filesystem, and blocks the network', async () => {
    if (!(await dockerAvailable())) {
      console.warn('sandbox integration: Docker unavailable, skipping');
      return;
    }
    const session = new SandboxSession({ image: 'alpine:3', execTimeoutMs: 15_000 });
    const tools = new ToolRegistryExecutor(createSandboxTools(session));

    try {
      expect(tools.list().map((t) => t.name)).toEqual(['shell_exec']);
      // shell_exec is high risk -> approval-gated by default.
      expect(tools.list()[0]?.riskLevel).toBe('high');

      // 1) Basic execution + stdout capture.
      const hello = await tools.execute('shell_exec', { command: 'echo hello-sandbox' });
      expect(hello.ok).toBe(true);
      const h = hello.output as { stdout: string; exitCode: number };
      expect(h.stdout.trim()).toBe('hello-sandbox');
      expect(h.exitCode).toBe(0);

      // 2) The filesystem persists across commands in the same session.
      await session.exec('echo secret-123 > /work/note.txt');
      const read = await session.exec('cat /work/note.txt');
      expect(read.stdout.trim()).toBe('secret-123');
      expect(read.exitCode).toBe(0);

      // 3) Networking is disabled — an outbound request must fail.
      const net = await session.exec('wget -q -T 3 -O- http://1.1.1.1 2>&1; echo "rc=$?"');
      expect(net.stdout).toContain('rc=');
      expect(net.stdout.trim().endsWith('rc=0')).toBe(false);

      // 4) Non-zero exit codes surface.
      const fail = await session.exec('exit 7');
      expect(fail.exitCode).toBe(7);
    } finally {
      await session.dispose();
    }
  }, 90_000);

  it('persists a named volume across sessions (persistent computer)', async () => {
    if (!(await dockerAvailable())) {
      console.warn('sandbox persistence: Docker unavailable, skipping');
      return;
    }
    const docker = new Docker();
    const volume = 'agentos-test-persist-vol';
    // Start clean (a previous failed run may have left it behind).
    await docker.getVolume(volume).remove({ force: true }).catch(() => undefined);

    try {
      // Session A writes to /persist, then is fully disposed (its container is removed).
      const a = new SandboxSession({ image: 'alpine:3', execTimeoutMs: 15_000, persistVolume: volume });
      expect(a.persistentDir()).toBe('/persist');
      await a.exec('echo across-tasks > /persist/state.txt');
      // A scratch file outside the volume must NOT survive.
      await a.exec('echo scratch > /work/tmp.txt');
      await a.dispose();

      // Session B mounts the SAME volume and sees the file; the scratch file is gone.
      const b = new SandboxSession({ image: 'alpine:3', execTimeoutMs: 15_000, persistVolume: volume });
      try {
        const persisted = await b.exec('cat /persist/state.txt');
        expect(persisted.stdout.trim()).toBe('across-tasks');
        const scratch = await b.exec('cat /work/tmp.txt 2>&1; echo "rc=$?"');
        expect(scratch.stdout.trim().endsWith('rc=0')).toBe(false);
        // The tool description advertises the persistent path so the agent knows what survives.
        expect(createSandboxTools(b)[0]!.definition.description).toContain('/persist');
      } finally {
        await b.dispose();
      }
    } finally {
      await docker.getVolume(volume).remove({ force: true }).catch(() => undefined);
    }
  }, 120_000);

  it('bounds output and kills runaway/timed-out commands', async () => {
    if (!(await dockerAvailable())) {
      console.warn('sandbox integration: Docker unavailable, skipping');
      return;
    }
    const session = new SandboxSession({ image: 'alpine:3', maxOutputBytes: 500, execTimeoutMs: 2000 });
    try {
      // Output flood is capped + flagged truncated (no unbounded heap growth).
      const flood = await session.exec('seq 1 1000000');
      expect(flood.truncated).toBe(true);
      expect(flood.stdout.length).toBeLessThanOrEqual(500);

      // A long-running command is killed by the container-side timeout.
      const slow = await session.exec('sleep 30');
      expect(slow.timedOut).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
