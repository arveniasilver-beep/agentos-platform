import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { loadServerEnv } from '@agentos/config';
import { BRAND } from '@agentos/brand';

const exec = promisify(execFile);

/**
 * Coding workspace lifecycle + filesystem checkpoint/rollback (TICKET-CODING). There is ONE real
 * directory per (workspace, project) under CODING_WORKSPACE_ROOT — the same host directory the edit
 * tools write to AND the Docker runner bind-mounts at /work, so edited === tested.
 *
 * Checkpoints are git commits (task-scoped, content-addressed) with HOOKS BYPASSED (empty
 * core.hooksPath + --no-verify) so a repo's own hooks can never run during our trusted checkpoint
 * commands. When git is unavailable, a directory-copy snapshot is used as a fallback.
 *
 * NOTE: git here runs ONLY our fixed, trusted commands on the host — it is the checkpoint primitive,
 * not agent-controlled shell. Untrusted agent commands (run_*) run in the hardened Docker runner.
 */
@Injectable()
export class CodingWorkspaceService {
  private readonly log = new Logger(CodingWorkspaceService.name);
  private readonly base: string;
  private readonly hooksPath: string;
  private gitOk: boolean | undefined;

  constructor() {
    const env = loadServerEnv();
    this.base = env.CODING_WORKSPACE_ROOT ?? join(tmpdir(), 'agentos-coding');
    // An empty directory used as core.hooksPath so git finds NO hooks to run (cross-platform).
    this.hooksPath = join(this.base, '.no-hooks');
  }

  /** The single real directory for a (workspace, project). Ids are sanitized to safe path segments. */
  resolveDir(workspaceId: string, projectId?: string | null): string {
    const safe = (s: string) => (s || 'default').replace(/[^a-zA-Z0-9_.-]/g, '-');
    return normalize(join(this.base, safe(workspaceId), safe(projectId ?? 'default')));
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: BRAND.appName,
      GIT_AUTHOR_EMAIL: 'agentos@local',
      GIT_COMMITTER_NAME: BRAND.appName,
      GIT_COMMITTER_EMAIL: 'agentos@local',
    };
  }

  /** Run git with hooks disabled + gpg-signing off, in `cwd`. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const safeArgs = ['-c', `core.hooksPath=${this.hooksPath}`, '-c', 'commit.gpgsign=false', ...args];
    const { stdout } = await exec('git', safeArgs, { cwd, env: this.gitEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  }

  private async gitAvailable(): Promise<boolean> {
    if (this.gitOk !== undefined) return this.gitOk;
    try {
      await exec('git', ['--version'], { timeout: 10_000 });
      this.gitOk = true;
    } catch {
      this.gitOk = false;
      this.log.warn('git not found — coding checkpoints fall back to directory snapshots');
    }
    return this.gitOk;
  }

  /** Ensure the workspace dir exists and (if git is available) is a git repo with hooks disabled. */
  async ensureWorkspace(workspaceId: string, projectId?: string | null): Promise<{ dir: string; git: boolean }> {
    const dir = this.resolveDir(workspaceId, projectId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.hooksPath, { recursive: true });
    const git = await this.gitAvailable();
    if (git && !existsSync(join(dir, '.git'))) {
      await this.git(dir, ['init', '-q']);
      // A baseline commit so the first checkpoint/rollback always has a parent ref.
      await this.git(dir, ['add', '-A']);
      await this.git(dir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'agentos: workspace init']);
    }
    return { dir, git };
  }

  /** Create a restorable checkpoint. Git: a commit (ref = short hash). Fallback: a directory snapshot. */
  async checkpoint(dir: string, label: string): Promise<{ ref: string; label: string }> {
    if (await this.gitAvailable()) {
      await this.git(dir, ['add', '-A']);
      await this.git(dir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `agentos checkpoint: ${label}`.slice(0, 200)]);
      const ref = await this.git(dir, ['rev-parse', '--short', 'HEAD']);
      return { ref, label };
    }
    return this.snapshot(dir, label);
  }

  /** Roll back to a prior checkpoint ref (destructive: discards uncommitted changes + untracked files). */
  async rollback(dir: string, ref: string): Promise<{ ref: string }> {
    if (await this.gitAvailable()) {
      await this.git(dir, ['reset', '--hard', ref]);
      await this.git(dir, ['clean', '-fd']);
      return { ref };
    }
    return this.restoreSnapshot(dir, ref);
  }

  // --- snapshot fallback (no git) ---------------------------------------------------------------
  private snapDir(dir: string): string {
    return join(this.base, '.snapshots', dir.replace(/[^a-zA-Z0-9_.-]/g, '-'));
  }
  private snapshot(dir: string, label: string): { ref: string; label: string } {
    const snapBase = this.snapDir(dir);
    mkdirSync(snapBase, { recursive: true });
    const seq = readdirSync(snapBase).length;
    const ref = `snap-${seq}-${label.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40)}`;
    cpSync(dir, join(snapBase, ref), { recursive: true });
    return { ref, label };
  }
  private restoreSnapshot(dir: string, ref: string): { ref: string } {
    const src = join(this.snapDir(dir), ref);
    if (!existsSync(src)) throw new Error(`unknown checkpoint snapshot: ${ref}`);
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    cpSync(src, dir, { recursive: true });
    return { ref };
  }
}
