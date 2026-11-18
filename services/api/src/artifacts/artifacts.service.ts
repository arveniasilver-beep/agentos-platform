import { Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, normalize, sep, extname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { loadServerEnv } from '@agentos/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export interface Artifact {
  path: string; // relative to the task sandbox root
  size: number;
  modifiedAt: Date;
}

/** Durable-artifact metadata (DB-backed). `sizeBytes` is a JS number (≤ MAX_ARTIFACT_BYTES, well
 * within Number.MAX_SAFE_INTEGER) so it serializes to JSON without the Prisma BigInt error. */
export interface ArtifactMeta {
  id: string;
  taskId: string;
  name: string;
  kind: string;
  versionId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: Date;
}

/** The only sandbox subdirectories scanned for durable registration (no arbitrary host paths). */
const ALLOWED_ARTIFACT_DIRS = ['deliverables', 'downloads', 'uploads'] as const;

/** A workspace-wide artifact (cross-task Library entry), tagged with its originating task. */
export interface LibraryItem extends Artifact {
  taskId: string;
  taskTitle: string;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/**
 * Resolve a relative path inside `root`, returning null on any traversal outside it. The agent
 * (untrusted) writes the sandbox, so it could plant a symlink pointing outside its folder; a lexical
 * check alone would pass and readFileSync would then follow the link to a host file. So after the
 * lexical pre-check we realpath-canonicalize BOTH root and the (existing) target and re-verify
 * containment — a symlink escape resolves outside realRoot and is rejected.
 */
function safeResolve(root: string, rel: string): string | null {
  const target = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  try {
    const realRoot = realpathSync.native(root);
    const realRootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    const realTarget = realpathSync.native(target); // throws if the target doesn't exist
    if (realTarget !== realRoot && !realTarget.startsWith(realRootSep)) return null;
    return realTarget;
  } catch {
    return null; // nonexistent target or unresolvable symlink
  }
}

/**
 * Lists + serves the files an agent produced in its per-task sandbox directory
 * (AGENT_SANDBOX_ROOT/<taskId>) as downloadable artifacts. All access is tenancy-guarded and
 * path-canonicalized (no traversal out of the task's own folder).
 */
@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);
  private readonly base: string;
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    const env = loadServerEnv();
    this.base = env.AGENT_SANDBOX_ROOT ?? join(tmpdir(), 'agentos-sandbox');
    this.maxBytes = env.MAX_ARTIFACT_BYTES;
  }

  private taskRoot(taskId: string): string {
    return normalize(join(this.base, taskId));
  }

  async list(workspaceId: string, taskId: string): Promise<Artifact[]> {
    await this.requireTask(workspaceId, taskId);
    return this.walkTask(taskId, 500);
  }

  /** Walk a task's sandbox dir into a flat, size-bounded artifact list (newest first). */
  private walkTask(taskId: string, cap: number): Artifact[] {
    const root = this.taskRoot(taskId);
    if (!existsSync(root)) return [];
    const out: Artifact[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || out.length >= cap) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const st = statSync(full);
          out.push({ path: relative(root, full).split(sep).join('/'), size: st.size, modifiedAt: st.mtime });
        }
        if (out.length >= cap) return;
      }
    };
    walk(root, 0);
    return out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /**
   * Cross-task "Library" (Manus's Kütüphane): the artifacts across the workspace's MOST RECENT tasks,
   * each tagged with its task. Bounded so a huge workspace can't make this unbounded: it scans the
   * newest MAX_TASKS and keeps up to MAX_ITEMS files (so when truncated, the kept set is files from the
   * newest tasks — the banner says so). `truncated` is true only when at least one task or file was
   * actually dropped (detected with a +1 sentinel on both caps, so an exact-fit list isn't a false
   * positive). Within the kept set, files are returned newest-first.
   */
  async listAll(
    workspaceId: string,
  ): Promise<{ items: LibraryItem[]; truncated: boolean }> {
    const MAX_TASKS = 300;
    const MAX_ITEMS = 1000;
    // Fetch one extra task to tell whether the task scan itself dropped anything.
    const tasks = await this.prisma.task.findMany({
      where: { workspaceId },
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_TASKS + 1,
    });
    const moreTasks = tasks.length > MAX_TASKS;
    const scan = moreTasks ? tasks.slice(0, MAX_TASKS) : tasks;

    const items: LibraryItem[] = [];
    let moreItems = false;
    for (const task of scan) {
      const remaining = MAX_ITEMS - items.length;
      if (remaining <= 0) break;
      // Walk one past the remaining budget so we can detect a genuine overflow (vs an exact fit).
      const got = this.walkTask(task.id, remaining + 1);
      if (got.length > remaining) {
        moreItems = true;
        got.length = remaining;
      }
      for (const a of got) items.push({ taskId: task.id, taskTitle: task.title, ...a });
      if (moreItems) break;
    }
    items.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return { items, truncated: moreItems || moreTasks };
  }

  async read(
    workspaceId: string,
    taskId: string,
    relPath: string,
  ): Promise<{ path: string; contentType: string; data: Buffer }> {
    await this.requireTask(workspaceId, taskId);
    const root = this.taskRoot(taskId);
    const file = safeResolve(root, relPath);
    if (!file || !existsSync(file)) {
      throw new NotFoundException('Artifact not found.');
    }
    const stat = statSync(file);
    if (!stat.isFile()) {
      throw new NotFoundException('Artifact not found.');
    }
    if (stat.size > this.maxBytes) {
      throw new PayloadTooLargeException(`Artifact exceeds the ${this.maxBytes}-byte download limit.`);
    }
    return { path: relPath, contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', data: readFileSync(file) };
  }

  /**
   * Write an uploaded file into the task's sandbox (under `uploads/`), so the agent can read it
   * with its fs tools and it shows up as an artifact. The filename is reduced to its basename and
   * sanitized, so no path component can escape the folder. Size-capped.
   */
  async upload(
    workspaceId: string,
    taskId: string,
    filename: string,
    data: Buffer,
  ): Promise<Artifact> {
    await this.requireTask(workspaceId, taskId);
    if (data.byteLength > this.maxBytes) {
      throw new PayloadTooLargeException(`Upload exceeds the ${this.maxBytes}-byte limit.`);
    }
    const root = this.taskRoot(taskId);
    const dir = join(root, 'uploads');
    mkdirSync(dir, { recursive: true });
    // Strip path, replace unsafe chars, and trim leading/trailing dots+spaces BEFORE the fallback,
    // so '   ', '.', '..' don't collapse to '' or '.' (which would resolve to the uploads dir and
    // EISDIR-500). The result is always a plain basename inside the folder.
    const cleaned = basename(filename)
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 200);
    const safeName = cleaned || 'file';
    const target = join(dir, safeName);
    writeFileSync(target, data);
    const st = statSync(target);
    return { path: relative(root, target).split(sep).join('/'), size: st.size, modifiedAt: st.mtime };
  }

  private async requireTask(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Task not found in this workspace.');
  }

  // ---- Durable Artifact Persistence (TICKET-ART) ----

  /** Enumerate files in ONLY the allowed sandbox subdirs (deliverables/downloads/uploads). */
  private collectArtifactFiles(taskId: string): { name: string; abs: string; size: number }[] {
    const root = this.taskRoot(taskId);
    const out: { name: string; abs: string; size: number }[] = [];
    for (const sub of ALLOWED_ARTIFACT_DIRS) {
      const dir = join(root, sub);
      if (!existsSync(dir)) continue;
      const walk = (d: string, depth: number): void => {
        if (depth > 6 || out.length >= 1000) return;
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          if (entry.isDirectory()) walk(full, depth + 1);
          else if (entry.isFile()) {
            const st = statSync(full);
            out.push({ name: relative(root, full).split(sep).join('/'), abs: full, size: st.size });
          }
          if (out.length >= 1000) return;
        }
      };
      walk(dir, 0);
    }
    return out;
  }

  /**
   * Register the durable artifacts a task produced. Best-effort + idempotent: scans the allowed
   * sandbox subdirs, and for each file uploads the blob then records an Artifact + ArtifactVersion.
   * Same (taskId, name) + same sha256 ⇒ no new version (dedup); changed content ⇒ version+1. A blob
   * upload that fails skips that file (no DB row); a version-row failure deletes the just-uploaded
   * blob (no orphan). Never throws — the task has already succeeded. No-op unless the flag is on.
   * Returns the affected Artifact ids (for final_output.artifactIds).
   */
  async registerFromSandbox(workspaceId: string, taskId: string, projectId?: string | null): Promise<string[]> {
    if (!loadServerEnv().ARTIFACT_PERSISTENCE_ENABLED) return [];
    const ids: string[] = [];
    let files: { name: string; abs: string; size: number }[] = [];
    try {
      files = this.collectArtifactFiles(taskId);
    } catch (e) {
      this.logger.warn(`artifact scan failed for task ${taskId}: ${e instanceof Error ? e.message : e}`);
      return ids;
    }
    for (const f of files) {
      try {
        if (f.size > this.maxBytes) {
          this.logger.warn(`artifact ${f.name} (${f.size}B) exceeds the ${this.maxBytes}B limit — skipped`);
          continue;
        }
        const data = readFileSync(f.abs);
        const sha256 = createHash('sha256').update(data).digest('hex');
        const mimeType = MIME[extname(f.name).toLowerCase()] ?? 'application/octet-stream';
        const kind = f.name.split('/')[0] ?? 'file';

        const existing = await this.prisma.artifact.findUnique({
          where: { taskId_name: { taskId, name: f.name } },
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        });
        const latest = existing?.versions[0];
        if (latest && latest.sha256 === sha256) {
          ids.push(existing.id); // identical content already stored — no duplicate version
          continue;
        }
        // Pre-generate the id for a new artifact so the blob key can be derived BEFORE any DB write.
        const artifactId = existing?.id ?? randomUUID();
        const version = (latest?.version ?? 0) + 1;
        const blobKey = this.storage.keyFor(workspaceId, taskId, artifactId, version);

        // 1) Upload the blob FIRST. On failure, NO DB row is written at all (no partial row).
        try {
          await this.storage.put(blobKey, data, mimeType);
        } catch (e) {
          this.logger.warn(`artifact blob upload failed (${f.name}): ${e instanceof Error ? e.message : e}`);
          continue;
        }
        // 2) Write the DB row(s). New artifact = Artifact + first Version in ONE nested create
        //    (atomic — no partial Artifact-without-Version). Existing artifact = just a new Version.
        //    On any failure, compensate by deleting the just-uploaded blob (no orphan).
        try {
          let versionId: string;
          if (existing) {
            const v = await this.prisma.artifactVersion.create({
              data: { artifactId: existing.id, workspaceId, version, blobKey, sha256, sizeBytes: BigInt(f.size), mimeType },
            });
            versionId = v.id;
          } else {
            const created = await this.prisma.artifact.create({
              data: {
                id: artifactId,
                workspaceId,
                taskId,
                projectId: projectId ?? null,
                name: f.name,
                kind,
                versions: { create: { workspaceId, version, blobKey, sha256, sizeBytes: BigInt(f.size), mimeType } },
              },
              include: { versions: true },
            });
            versionId = created.versions[0]!.id;
          }
          // Point the artifact at its newest version (non-critical: derivable from max(version)).
          await this.prisma.artifact
            .update({ where: { id: artifactId }, data: { currentVersionId: versionId } })
            .catch((e) => this.logger.warn(`artifact pointer update failed (${f.name}): ${e instanceof Error ? e.message : e}`));
          ids.push(artifactId);
        } catch (e) {
          await this.storage.delete(blobKey).catch(() => undefined);
          this.logger.warn(`artifact DB write failed (${f.name}); blob cleaned: ${e instanceof Error ? e.message : e}`);
          continue;
        }
      } catch (e) {
        this.logger.warn(`artifact registration error (${f.name}): ${e instanceof Error ? e.message : e}`);
      }
    }
    return ids;
  }

  private toMeta(
    a: { id: string; taskId: string; name: string; kind: string },
    v: { id: string; version: number; sha256: string; sizeBytes: bigint; mimeType: string; createdAt: Date },
  ): ArtifactMeta {
    // BigInt -> number (size <= MAX_ARTIFACT_BYTES, safely within Number.MAX_SAFE_INTEGER) so the API
    // response JSON-serializes without the Prisma "Do not know how to serialize a BigInt" error.
    return {
      id: a.id, taskId: a.taskId, name: a.name, kind: a.kind,
      versionId: v.id, version: v.version, sha256: v.sha256,
      sizeBytes: Number(v.sizeBytes), mimeType: v.mimeType, createdAt: v.createdAt,
    };
  }

  private async loadArtifact(workspaceId: string, artifactId: string) {
    const a = await this.prisma.artifact.findFirst({
      where: { id: artifactId, workspaceId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!a) throw new NotFoundException('Artifact not found.');
    const current = a.versions.find((v) => v.id === a.currentVersionId) ?? a.versions[0];
    if (!current) throw new NotFoundException('Artifact has no stored version.');
    return { a, current };
  }

  /** DB-backed durable artifact list for a task (newest first). Tenancy-checked. */
  async listDurable(workspaceId: string, taskId: string): Promise<ArtifactMeta[]> {
    await this.requireTask(workspaceId, taskId);
    const arts = await this.prisma.artifact.findMany({
      where: { workspaceId, taskId },
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
    const out: ArtifactMeta[] = [];
    for (const a of arts) {
      const current = a.versions.find((v) => v.id === a.currentVersionId) ?? a.versions[0];
      if (current) out.push(this.toMeta(a, current));
    }
    return out;
  }

  /** Metadata for one durable artifact (workspace-scoped). */
  async getMetaById(workspaceId: string, artifactId: string): Promise<ArtifactMeta> {
    const { a, current } = await this.loadArtifact(workspaceId, artifactId);
    return this.toMeta(a, current);
  }

  /** Fetch one durable artifact's bytes from blob storage (workspace-scoped). Optionally a SPECIFIC
   * version (else the current one) — every version's bytes are immutable + kept. */
  async downloadById(
    workspaceId: string,
    artifactId: string,
    version?: number,
  ): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const { a, current } = await this.loadArtifact(workspaceId, artifactId);
    const v = version !== undefined ? a.versions.find((x) => x.version === version) : current;
    if (!v) throw new NotFoundException(`Version ${version} not found for this artifact.`);
    const data = await this.storage.get(v.blobKey);
    return { filename: basename(a.name), contentType: v.mimeType, data };
  }

  /** Artifact lifecycle (Ticket-10): the full version HISTORY of one durable artifact, newest first, with
   * which version is current — so the UI can show v1/v2/v3, who produced each (createdAt), and offer
   * download/rollback per version. */
  async listVersions(
    workspaceId: string,
    artifactId: string,
  ): Promise<{ versions: ArtifactMeta[]; currentVersionId: string | null }> {
    const { a } = await this.loadArtifact(workspaceId, artifactId);
    return { versions: a.versions.map((v) => this.toMeta(a, v)), currentVersionId: a.currentVersionId };
  }

  /** Roll a durable artifact back to a prior version: re-point currentVersionId. NON-destructive — the
   * later versions' bytes are kept, so a rollback is itself reversible (roll forward again). */
  async rollback(workspaceId: string, artifactId: string, version: number): Promise<ArtifactMeta> {
    const { a } = await this.loadArtifact(workspaceId, artifactId);
    const target = a.versions.find((v) => v.version === version);
    if (!target) throw new NotFoundException(`Version ${version} not found for this artifact.`);
    await this.prisma.artifact.update({ where: { id: a.id }, data: { currentVersionId: target.id } });
    return this.toMeta(a, target);
  }
}
