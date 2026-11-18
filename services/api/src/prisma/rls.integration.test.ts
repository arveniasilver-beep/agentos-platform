import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, TaskStatus, type PrismaClient } from '@agentos/db';

// Load DATABASE_URL from packages/db/.env when unset (mirrors the other integration tests).
if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) {
        process.env.DATABASE_URL = m[1];
        break;
      }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

// Derive the least-privilege role's connection string from DATABASE_URL (the migration created
// `agentos_app` with a matching dev password). RLS is only enforced under a non-superuser role —
// the owner/superuser bypasses it — so the assertions run through this client.
function appRoleUrl(): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.username = 'agentos_app';
  u.password = 'agentos_app';
  return u.toString();
}

suite('Row-Level Security enforcement (live Postgres, least-privilege role)', () => {
  // Owner client (system context via vitest.setup.ts) seeds + cleans up, bypassing RLS.
  const owner = getPrisma();
  // App-role client: a non-superuser under which the tenant_isolation policies actually apply.
  let app: PrismaClient | undefined;
  const suffix = Date.now().toString(36);
  let userA = '';
  let wsA = '';
  let taskA = '';
  let userB = '';
  let wsB = '';
  let taskB = '';

  afterAll(async () => {
    await app?.$disconnect().catch(() => undefined);
    for (const ws of [wsA, wsB]) {
      if (ws) await owner.workspace.delete({ where: { id: ws } }).catch(() => undefined);
    }
    for (const u of [userA, userB]) {
      if (u) await owner.user.delete({ where: { id: u } }).catch(() => undefined);
    }
    await disconnectPrisma();
  });

  it('isolates tenants at the database layer (read, list, WITH CHECK, fail-closed, system bypass)', async () => {
    // Probe the app role; skip cleanly if it isn't provisioned in this environment.
    try {
      app = makeRlsClient(appRoleUrl());
      await app.$connect();
    } catch {
      console.warn('rls integration: agentos_app role unavailable, skipping');
      return;
    }

    // Seed two workspaces with one task each (owner client, system context → bypasses RLS).
    const ua = await owner.user.create({ data: { email: `rls-a-${suffix}@t.local`, displayName: 'A' } });
    userA = ua.id;
    const wa = await owner.workspace.create({ data: { name: 'A', slug: `rls-a-${suffix}`, ownerUserId: ua.id } });
    wsA = wa.id;
    taskA = (
      await owner.task.create({
        data: { workspaceId: wa.id, createdByUserId: ua.id, title: 'A task', prompt: 'x', status: TaskStatus.pending },
      })
    ).id;
    const ub = await owner.user.create({ data: { email: `rls-b-${suffix}@t.local`, displayName: 'B' } });
    userB = ub.id;
    const wb = await owner.workspace.create({ data: { name: 'B', slug: `rls-b-${suffix}`, ownerUserId: ub.id } });
    wsB = wb.id;
    taskB = (
      await owner.task.create({
        data: { workspaceId: wb.id, createdByUserId: ub.id, title: 'B task', prompt: 'x', status: TaskStatus.pending },
      })
    ).id;

    const appClient = app;

    // In workspace A's context the DB exposes only A's rows — B's task is invisible even by id.
    await tenantContext.run({ workspaceId: wsA }, async () => {
      expect((await appClient.task.findUnique({ where: { id: taskA } }))?.id).toBe(taskA);
      expect(await appClient.task.findUnique({ where: { id: taskB } })).toBeNull();
      const visible = await appClient.task.findMany({ where: { id: { in: [taskA, taskB] } } });
      expect(visible.map((t) => t.id)).toEqual([taskA]);
    });

    // WITH CHECK: in A's context a write targeting workspace B is rejected by the policy.
    await tenantContext.run({ workspaceId: wsA }, async () => {
      await expect(
        appClient.task.create({
          data: { workspaceId: wsB, createdByUserId: userB, title: 'evil', prompt: 'x', status: TaskStatus.pending },
        }),
      ).rejects.toThrow();
    });

    // No tenancy context → fail closed: the policy matches no rows.
    const denied = await tenantContext.run({}, async () =>
      appClient.task.findMany({ where: { id: { in: [taskA, taskB] } } }),
    );
    expect(denied).toHaveLength(0);

    // System context → the bypass GUC lets the app role see both workspaces' rows.
    const all = await tenantContext.runSystem(async () =>
      appClient.task.findMany({ where: { id: { in: [taskA, taskB] } } }),
    );
    expect(all.map((t) => t.id).sort()).toEqual([taskA, taskB].sort());
  });
});
