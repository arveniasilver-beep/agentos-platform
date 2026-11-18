import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { SkillsService } from './skills.service';
import { PlaybooksService } from '../playbooks/playbooks.service';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) { process.env.DATABASE_URL = m[1]; break; }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('Skills v2 + playbook audit (TICKET-4, live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  // Stub the task engine — capture the dto the skill would dispatch (no heavy pipeline).
  let captured: Record<string, unknown> | null = null;
  const stubTasks = { createAndStart: async (_ws: string, _uid: string, dto: Record<string, unknown>) => { captured = dto; return { id: 'task-stub' }; } };
  const skills = new SkillsService(prisma as never, audit, stubTasks as never);
  const playbooks = new PlaybooksService(prisma as never, audit);
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `sk-${sfx}@t.local`, displayName: 'S' } });
    userId = u.id;
    wsId = (await prisma.workspace.create({ data: { name: 'S', slug: `sk-${sfx}`, ownerUserId: u.id } })).id;
  });
  afterAll(async () => {
    delete process.env.SKILLS_PLAYBOOKS_V2_ENABLED;
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  async function makeSkill() {
    return skills.create(wsId, userId, {
      name: 'Weather', instructions: 'Weather report for {{city}} over {{days}} days.', riskCeiling: 'low',
      params: [{ name: 'city', type: 'string', required: true }, { name: 'days', type: 'number', required: true }],
      capability: 'document', effort: 'high',
    } as never);
  }

  it('flag ON: validates typed params, renders {{name}}, applies capability/effort, records version', async () => {
    process.env.SKILLS_PLAYBOOKS_V2_ENABLED = 'true';
    const skill = await makeSkill();
    captured = null;
    await skills.run(wsId, skill.id, userId, undefined, { city: 'Paris', days: '3' });
    expect(captured?.prompt).toBe('Weather report for Paris over 3 days.');
    expect(captured?.capability).toBe('document');
    expect(captured?.effort).toBe('high');
    const aud = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, action: 'skill.run', targetId: skill.id } });
    expect((aud?.metadata as { version?: number })?.version).toBe(1);
  });

  it('flag ON: missing required param is rejected (controlled error)', async () => {
    process.env.SKILLS_PLAYBOOKS_V2_ENABLED = 'true';
    const skill = await makeSkill();
    await expect(skills.run(wsId, skill.id, userId, undefined, { city: 'Paris' })).rejects.toThrow(/params invalid/i);
  });

  it('flag ON: update bumps the skill version', async () => {
    process.env.SKILLS_PLAYBOOKS_V2_ENABLED = 'true';
    const skill = await makeSkill();
    const updated = await skills.update(wsId, skill.id, userId, { description: 'v2' } as never);
    expect(updated.version).toBe(2);
  });

  it('flag OFF: legacy {{input}} path; capability/effort NOT applied (byte-identical)', async () => {
    delete process.env.SKILLS_PLAYBOOKS_V2_ENABLED;
    const skill = await makeSkill();
    captured = null;
    await skills.run(wsId, skill.id, userId, 'extra context');
    // no params substitution; legacy renderPrompt appends input (no {{input}} placeholder present)
    expect(String(captured?.prompt)).toContain('extra context');
    expect(captured?.capability).toBeUndefined();
    expect(captured?.effort).toBeUndefined();
  });

  it('playbook create/delete are now audited (TICKET-4 gap closed)', async () => {
    const pb = await playbooks.create(wsId, userId, { name: 'PB', prompt: 'do a thing', capability: 'document' });
    const created = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, action: 'playbook.create', targetId: pb.id } });
    expect(created).not.toBeNull();
    await playbooks.remove(wsId, pb.id, userId);
    const deleted = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, action: 'playbook.delete', targetId: pb.id } });
    expect(deleted).not.toBeNull();
  });
});
