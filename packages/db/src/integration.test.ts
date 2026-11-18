import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from './index';

// Load DATABASE_URL from packages/db/.env if not already set, so a local `vitest run` connects.
// In CI without a database (and without .env), DATABASE_URL stays unset and this suite is skipped.
if (!process.env.DATABASE_URL) {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
    if (match?.[1]) process.env.DATABASE_URL = match[1];
  }
}

const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

suite('db integration (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const email = `int-${suffix}@test.local`;
  const slug = `ws-${suffix}`;
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('creates a user, workspace and membership with working relations', async () => {
    const user = await prisma.user.create({ data: { email, displayName: 'Integration User' } });
    userId = user.id;

    const ws = await prisma.workspace.create({
      data: {
        name: 'Integration WS',
        slug,
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = ws.id;

    const loaded = await prisma.workspace.findUniqueOrThrow({
      where: { id: ws.id },
      include: { owner: true, members: true },
    });
    expect(loaded.owner.email).toBe(email);
    expect(loaded.members).toHaveLength(1);
    expect(loaded.members[0]?.role).toBe('owner');
  });

  it('stores secret material as bytes (ciphertext only, never a plaintext column)', async () => {
    const ciphertext = Buffer.from('opaque-ciphertext-bytes');
    const secret = await prisma.secret.create({
      data: {
        workspaceId,
        type: 'llm_api_key',
        label: 'Anthropic key',
        ciphertext,
        iv: Buffer.from('iv-bytes-12b'),
        authTag: Buffer.from('auth-tag-16-byte'),
        wrappedDataKey: Buffer.from('wrapped-data-key-bytes'),
        kmsKeyId: 'local-dev-v1',
        lastFour: 'aB3x',
        createdByUserId: userId,
      },
    });

    const loaded = await prisma.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(Buffer.from(loaded.ciphertext).equals(ciphertext)).toBe(true);
    expect(loaded.lastFour).toBe('aB3x');
    expect(loaded.type).toBe('llm_api_key');
  });

  it('cascade-deletes members and secrets when the workspace is removed', async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } });
    const members = await prisma.workspaceMember.count({ where: { workspaceId } });
    const secrets = await prisma.secret.count({ where: { workspaceId } });
    expect(members).toBe(0);
    expect(secrets).toBe(0);
    workspaceId = ''; // already deleted; keep afterAll from double-deleting
  });
});
