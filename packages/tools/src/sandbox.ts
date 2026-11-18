import { z } from 'zod';
import Docker from 'dockerode';
import type { Container } from 'dockerode';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

export interface SandboxOptions {
  /** Base image for the session container (must contain a POSIX shell). */
  image?: string;
  /** Hard memory cap in bytes (default 256 MiB). */
  memoryBytes?: number;
  /** Max processes (fork-bomb guard, default 256). */
  pidsLimit?: number;
  /** CPU cap as a fraction of one core (default 1.0 = one core). */
  cpus?: number;
  /** Max bytes written to a single file (ulimit fsize) — disk-fill guard (default 128 MiB). */
  maxFileBytes?: number;
  /** Cap on captured stdout+stderr bytes returned to the caller (default 1 MiB). */
  maxOutputBytes?: number;
  /** Disable networking entirely (default true). */
  networkDisabled?: boolean;
  /** Per-command wall-clock timeout (default 30s). */
  execTimeoutMs?: number;
  /** Working directory inside the container. */
  workdir?: string;
  /**
   * "Persistent computer": a Docker NAMED volume (not a host path) mounted into the container so its
   * contents survive between sessions/tasks. When set, the volume is mounted at `persistPath`
   * (default /persist) and is NOT removed on dispose(). Auto-created by Docker on first use.
   */
  persistVolume?: string;
  /** Mount point for persistVolume inside the container (default /persist). */
  persistPath?: string;
  /**
   * Coding workspace (TICKET-CODING): bind-mount ONE host directory into the container so the agent's
   * edits (made by the host file tools at `source`) are the exact files the runner tests at `target`
   * (default workdir /work). This is the ONLY host path ever mounted, and only when a coding workspace
   * explicitly opts in — generic shell_exec sessions never set it (no host access, unchanged).
   */
  hostMount?: { source: string; target: string; readOnly?: boolean };
  /**
   * Sandbox Hardening (TICKET-3). When true: read-only root filesystem + writable tmpfs scratch for the
   * workdir/tmp (also a disk quota) + explicit OOM behavior. Defaults to SANDBOX_HARDENING_ENABLED so
   * flag-off keeps today's writable-root behavior byte-identical.
   */
  hardened?: boolean;
  /** Size cap (bytes) of each writable tmpfs scratch mount when hardened — the scratch disk quota. */
  tmpfsBytes?: number;
  /** Hosts the orchestrator may permit egress to (recorded for the trace/future proxy; default-deny
   * egress via NetworkMode 'none' is always enforced when networking is disabled). */
  egressAllowlist?: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface SandboxHostConfigParams {
  memoryBytes: number;
  pidsLimit: number;
  cpus: number;
  maxFileBytes: number;
  networkDisabled: boolean;
  hardened: boolean;
  tmpfsBytes: number;
  workdir: string;
  persistVolume?: string | undefined;
  persistPath: string;
  hostMount?: { source: string; target: string; readOnly?: boolean } | undefined;
}

/**
 * Pure builder for the container HostConfig (TICKET-3) — isolated + deterministic so the hardening can
 * be unit/eval-tested without Docker. Base config (always on): memory/PID/CPU/fsize/nofile limits, all
 * caps dropped, no-new-privileges, default-deny network. Hardened adds: read-only root filesystem +
 * writable tmpfs scratch for the workdir/tmp (a disk quota) + explicit OOM behavior. Writable host/volume
 * mounts (coding bind, persistent volume) are NOT tmpfs'd — they stay the single writable surfaces.
 */
export function buildSandboxHostConfig(p: SandboxHostConfigParams): Docker.HostConfig {
  const binds = [
    ...(p.persistVolume ? [`${p.persistVolume}:${p.persistPath}`] : []),
    // Normalize host source to forward slashes (Windows backslashes break the bind parse).
    ...(p.hostMount ? [`${p.hostMount.source.replace(/\\/g, '/')}:${p.hostMount.target}${p.hostMount.readOnly ? ':ro' : ''}`] : []),
  ];
  const base: Docker.HostConfig = {
    Memory: p.memoryBytes,
    PidsLimit: p.pidsLimit,
    NanoCpus: Math.round(p.cpus * 1e9), // CPU cap (1e9 = one core)
    NetworkMode: p.networkDisabled ? 'none' : 'bridge',
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Ulimits: [
      { Name: 'fsize', Soft: p.maxFileBytes, Hard: p.maxFileBytes },
      { Name: 'nofile', Soft: 1024, Hard: 1024 },
    ],
    AutoRemove: false,
    Binds: binds,
  };
  if (!p.hardened) return base;
  // Writable mounts already provide writable space; everything else (root) becomes read-only. The
  // workdir gets a writable tmpfs unless it's already a writable bind/volume mount.
  const writableTargets = new Set<string>(
    [p.hostMount?.target, p.persistVolume ? p.persistPath : undefined].filter((t): t is string => Boolean(t)),
  );
  const tmpfsOpt = `rw,nosuid,nodev,size=${p.tmpfsBytes}`;
  const Tmpfs: Record<string, string> = { '/tmp': tmpfsOpt };
  if (!writableTargets.has(p.workdir)) Tmpfs[p.workdir] = tmpfsOpt;
  return { ...base, ReadonlyRootfs: true, Tmpfs, OomKillDisable: false };
}

/**
 * A throwaway, isolated container for one task's code execution. Hardened by default: no network,
 * all Linux capabilities dropped, no-new-privileges, a memory + PID cap, and no host mounts — so
 * code runs only inside the container's own writable layer. Created lazily on the first exec and
 * torn down by dispose().
 */
export class SandboxSession {
  private readonly docker: Docker;
  private container: Container | undefined;
  private readonly image: string;
  private readonly workdir: string;
  private readonly persistVolume: string | undefined;
  private readonly persistPath: string;
  private readonly hostMount: { source: string; target: string; readOnly?: boolean } | undefined;
  private readonly opts: Required<Omit<SandboxOptions, 'image' | 'workdir' | 'persistVolume' | 'persistPath' | 'hostMount' | 'egressAllowlist'>>;
  private readonly egressAllowlist: string[];

  constructor(options: SandboxOptions = {}, docker?: Docker) {
    this.docker = docker ?? new Docker();
    this.image = options.image ?? 'alpine:3';
    this.workdir = options.workdir ?? '/work';
    this.persistVolume = options.persistVolume;
    this.persistPath = options.persistPath ?? '/persist';
    this.hostMount = options.hostMount;
    this.egressAllowlist = options.egressAllowlist ?? [];
    this.opts = {
      memoryBytes: options.memoryBytes ?? 256 * 1024 * 1024,
      pidsLimit: options.pidsLimit ?? 256,
      cpus: options.cpus ?? 1.0,
      maxFileBytes: options.maxFileBytes ?? 128 * 1024 * 1024,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      networkDisabled: options.networkDisabled ?? true,
      execTimeoutMs: options.execTimeoutMs ?? 30_000,
      hardened: options.hardened ?? process.env.SANDBOX_HARDENING_ENABLED === 'true',
      tmpfsBytes: options.tmpfsBytes ?? 256 * 1024 * 1024,
    };
  }

  /** Observability/health: the hardening actually applied to this session's container. */
  describeHardening(): { hardened: boolean; readonlyRootfs: boolean; tmpfsBytes: number; networkDeny: boolean; egressAllowlist: string[] } {
    return {
      hardened: this.opts.hardened,
      readonlyRootfs: this.opts.hardened,
      tmpfsBytes: this.opts.tmpfsBytes,
      networkDeny: this.opts.networkDisabled,
      egressAllowlist: this.egressAllowlist,
    };
  }

  private async ensureImage(): Promise<void> {
    const images = await this.docker.listImages({ filters: { reference: [this.image] } });
    if (images.length > 0) return;
    const stream = await this.docker.pull(this.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  private async ensureContainer(): Promise<Container> {
    if (this.container) return this.container;
    await this.ensureImage();
    const container = await this.docker.createContainer({
      Image: this.image,
      // Keep the container alive so multiple commands share one session/filesystem.
      Cmd: ['sh', '-c', 'while true; do sleep 3600; done'],
      WorkingDir: this.workdir,
      Tty: false,
      NetworkDisabled: this.opts.networkDisabled,
      HostConfig: buildSandboxHostConfig({
        memoryBytes: this.opts.memoryBytes,
        pidsLimit: this.opts.pidsLimit,
        cpus: this.opts.cpus,
        maxFileBytes: this.opts.maxFileBytes,
        networkDisabled: this.opts.networkDisabled,
        hardened: this.opts.hardened,
        tmpfsBytes: this.opts.tmpfsBytes,
        workdir: this.workdir,
        persistVolume: this.persistVolume,
        persistPath: this.persistPath,
        hostMount: this.hostMount,
      }),
    });
    await container.start();
    const mkdirs = this.persistVolume ? `${this.workdir} ${this.persistPath}` : this.workdir;
    await container.exec({ Cmd: ['sh', '-c', `mkdir -p ${mkdirs}`] }).then((e) => e.start({ hijack: false }));
    this.container = container;
    return container;
  }

  async exec(command: string): Promise<ExecResult> {
    const container = await this.ensureContainer();
    const timeoutSec = Math.max(1, Math.ceil(this.opts.execTimeoutMs / 1000));
    // Wrap in busybox `timeout -s KILL`: the process tree is killed INSIDE the container if it runs
    // long, so a runaway command can't keep burning CPU/PIDs after the caller stops waiting.
    const exec = await container.exec({
      Cmd: ['timeout', '-s', 'KILL', String(timeoutSec), 'sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.workdir,
    });
    const stream = await exec.start({ hijack: true, stdin: false });

    // Bound captured output so a flood (`yes`, `cat /dev/urandom`) can't exhaust the API heap.
    const cap = this.opts.maxOutputBytes;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    const sink = (chunks: Buffer[]) => ({
      write: (b: Buffer) => {
        if (captured >= cap) {
          truncated = true;
          return;
        }
        const remaining = cap - captured;
        chunks.push(b.length > remaining ? b.subarray(0, remaining) : b);
        captured += Math.min(b.length, remaining);
        if (captured >= cap) {
          truncated = true;
          stream.destroy();
        }
      },
    });
    this.docker.modem.demuxStream(stream, sink(stdoutChunks) as never, sink(stderrChunks) as never);

    // Backstop wall-clock (slightly beyond the container-side timeout) in case the stream stalls.
    let timedOut = false;
    const finished = new Promise<void>((resolve) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', () => resolve());
    });
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.opts.execTimeoutMs + 2000),
    );
    await Promise.race([finished, timer]);

    const info = await exec.inspect().catch(() => ({ ExitCode: null as number | null }));
    const exitCode = typeof info.ExitCode === 'number' ? info.ExitCode : timedOut ? 124 : 0;
    // busybox `timeout -s KILL` exits 137 (128+SIGKILL) when it kills the command.
    if (exitCode === 137 || exitCode === 124) timedOut = true;
    return {
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      exitCode,
      timedOut,
      truncated,
    };
  }

  /** The in-container path that survives between tasks, or undefined when the sandbox is throwaway. */
  persistentDir(): string | undefined {
    return this.persistVolume ? this.persistPath : undefined;
  }

  async dispose(): Promise<void> {
    const container = this.container;
    this.container = undefined;
    if (!container) return;
    // Remove the container but NOT the named volume — that is the point of a persistent computer.
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** Code-execution tool that runs shell commands inside the isolated session container. */
export function createSandboxTools(session: SandboxSession): RuntimeTool[] {
  const persist = session.persistentDir();
  const shellExec: RuntimeTool = {
    definition: defineTool({
      id: 'shell_exec',
      name: 'shell_exec',
      description:
        'Run a shell command inside an isolated, network-less sandbox container and return its ' +
        'stdout, stderr and exit code. Use for code execution, file processing, and computation.' +
        (persist
          ? ` Files under ${persist} persist across tasks (your persistent computer); everything else is scratch.`
          : ''),
      inputSchema: z.object({ command: z.string().min(1).max(10_000) }),
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
      }),
      // Executing arbitrary code is high risk — approval-gated by default.
      riskLevel: 'high',
      permissions: ['shell.exec'],
      timeoutMs: 45_000,
    }),
    run: (input) => session.exec((input as { command: string }).command),
  };

  return [shellExec];
}
