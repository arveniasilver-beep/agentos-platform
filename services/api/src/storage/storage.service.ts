import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, normalize, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadServerEnv } from '@agentos/config';

/** Pluggable blob backend. Keys are SERVER-DERIVED (never user input) — see StorageService.keyFor. */
export interface StorageBackend {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// A storage key is built only from server-side UUIDs/ints, but defend in depth: reject anything that
// isn't a plain slash-separated key (blocks traversal / absolute paths / NUL).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/;
function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error('invalid storage key');
  }
}

/** Durable local-filesystem blob store. Root is OUTSIDE the throwaway task sandbox, so blobs survive
 * sandbox teardown. Used when object storage (S3/MinIO) is not configured. */
class LocalStorageBackend implements StorageBackend {
  readonly name = 'local';
  private readonly root: string;
  constructor(root: string) {
    this.root = normalize(root);
  }
  private resolve(key: string): string {
    assertSafeKey(key);
    const target = normalize(join(this.root, key));
    const rootSep = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (target !== this.root && !target.startsWith(rootSep)) throw new Error('storage key escapes root');
    return target;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

/** S3 / MinIO backend. The AWS SDK is an OPTIONAL dependency loaded lazily, so the build/lockfile
 * don't require it; it is used only when S3 is configured AND the SDK is installed. Until then the
 * local durable backend is the active store. */
class S3StorageBackend implements StorageBackend {
  readonly name = 's3';
  private client: unknown;
  constructor(
    private readonly cfg: { endpoint: string; region: string; accessKey: string; secretKey: string; bucket: string },
  ) {}
  private async sdk(): Promise<{ client: any; cmd: any }> {
    if (!this.client) {
      // Non-literal specifier so TS doesn't hard-require the optional module at compile time.
      const pkg = '@aws-sdk/client-s3';
      const mod: any = await import(pkg);
      this.client = new mod.S3Client({
        endpoint: this.cfg.endpoint,
        region: this.cfg.region,
        credentials: { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey },
        forcePathStyle: true, // required for MinIO
      });
      (this as { _mod?: unknown })._mod = mod;
    }
    return { client: this.client as any, cmd: (this as { _mod?: any })._mod };
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    const { client, cmd } = await this.sdk();
    await client.send(new cmd.PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const { client, cmd } = await this.sdk();
    const res = await client.send(new cmd.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { client, cmd } = await this.sdk();
    await client.send(new cmd.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

/**
 * Blob storage for durable artifacts. Selects S3/MinIO when fully configured, else a durable local
 * filesystem store. Callers never supply raw keys — use keyFor() to derive them from server-side ids.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly backend: StorageBackend;

  constructor() {
    const env = loadServerEnv();
    if (env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
      this.backend = new S3StorageBackend({
        endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKey: env.S3_ACCESS_KEY,
        secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET,
      });
    } else {
      this.backend = new LocalStorageBackend(env.ARTIFACT_STORE_ROOT ?? join(tmpdir(), 'agentos-artifacts'));
    }
    this.logger.log(`Artifact storage backend: ${this.backend.name}`);
  }

  /** The active backend name ('s3' | 'local') — for diagnostics/tests. */
  get backendName(): string {
    return this.backend.name;
  }

  /** Derive a safe, collision-free blob key from server-side identifiers only. */
  keyFor(workspaceId: string, taskId: string, artifactId: string, version: number): string {
    return `${workspaceId}/${taskId}/${artifactId}/v${version}`;
  }

  put(key: string, data: Buffer, contentType: string): Promise<void> {
    return this.backend.put(key, data, contentType);
  }
  get(key: string): Promise<Buffer> {
    return this.backend.get(key);
  }
  delete(key: string): Promise<void> {
    return this.backend.delete(key);
  }
}
