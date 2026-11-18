import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { generateToken } from '@agentos/auth';
import { loadServerEnv } from '@agentos/config';
import { tenantContext } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { redactText } from '../policy/redact';
import { BUILTIN_MANIFESTS, getManifest, actionAllowed, type ConnectorManifest } from './connector-registry';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
// Defense-in-depth for caller-supplied webhook text: run the shared secret redactor, THEN also strip any
// long high-entropy run (24+ token chars) — catches an unprefixed/unnamed secret the heuristic redactor
// would miss. For a human "summary" over-redacting is the safe failure mode (never store a raw secret).
const redact = (s: string | undefined, n = 200) =>
  (redactText(String(s ?? '')) ?? '').replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]').slice(0, n);

/**
 * Connectors v2 (TICKET-9). The connector framework on top of the existing OAuth/secret layer: a manifest
 * registry, capability-scope ENFORCEMENT (an action runs only if the connection actually granted the
 * required scopes), and secure webhook ingestion (per-connection secret, content-redacted events). All
 * runtime behaviors are flag-gated (CONNECTORS_V2_ENABLED) by the caller.
 */
@Injectable()
export class ConnectorRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listManifests(): ConnectorManifest[] {
    return Object.values(BUILTIN_MANIFESTS);
  }
  getManifest(provider: string): ConnectorManifest | null {
    return getManifest(provider) ?? null;
  }

  /** Capability-scope enforcement: may this connector action run in this workspace? Denials are audited. */
  async checkAction(workspaceId: string, provider: string, actionId: string): Promise<{ ok: boolean; reason: string }> {
    const manifest = getManifest(provider);
    if (!manifest) return { ok: false, reason: `unknown connector: ${provider}` };
    const conn = await this.prisma.connection.findFirst({ where: { workspaceId, provider }, select: { scopes: true } });
    if (!conn) return { ok: false, reason: `${provider} is not connected` };
    const verdict = actionAllowed(manifest, actionId, conn.scopes.split(/\s+/));
    if (!verdict.ok) {
      await this.audit
        .record({ workspaceId, actorType: 'agent', action: 'connector.action_denied', targetType: 'connection', targetId: provider, risk: 'medium', metadata: { provider, actionId, reason: verdict.reason } })
        .catch(() => undefined);
    }
    return verdict;
  }

  /** Issue (or rotate) the per-connection inbound webhook secret. Returns the token ONCE (only its hash
   * is stored). */
  async setWebhookSecret(workspaceId: string, provider: string, userId: string): Promise<{ token: string }> {
    const conn = await this.prisma.connection.findFirst({ where: { workspaceId, provider } });
    if (!conn) throw new NotFoundException(`${provider} is not connected.`);
    const token = `cwh_${generateToken()}`;
    await this.prisma.connection.update({ where: { id: conn.id }, data: { webhookSecretHash: hash(token) } });
    await this.audit.record({ workspaceId, actorUserId: userId, action: 'connector.webhook_secret_set', targetType: 'connection', targetId: conn.id, risk: 'high', metadata: { provider } }).catch(() => undefined);
    return { token };
  }

  /** Public webhook ingestion: verify the per-connection secret (constant-time) and record a REDACTED
   * event. UNIFORM 404 on any failure (no enumeration oracle). Flag-gated. */
  async ingestWebhook(connectionId: string, token: string, eventType: string, summary?: string): Promise<{ recorded: true }> {
    const notFound = new NotFoundException('Connector webhook not found.');
    if (!loadServerEnv().CONNECTORS_V2_ENABLED) throw notFound;
    const conn = await tenantContext.runSystem(() =>
      this.prisma.connection.findUnique({ where: { id: connectionId }, select: { id: true, workspaceId: true, provider: true, webhookSecretHash: true } }),
    );
    if (!conn || !conn.webhookSecretHash) throw notFound;
    const a = Buffer.from(hash(token ?? ''));
    const b = Buffer.from(conn.webhookSecretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw notFound;
    await tenantContext.run({ workspaceId: conn.workspaceId }, () =>
      this.prisma.connectorEvent.create({
        // SECURITY: only a redacted event type + short summary are stored — never the raw payload/secret.
        data: { workspaceId: conn.workspaceId, connectionId: conn.id, provider: conn.provider, eventType: redact(eventType, 80), summary: summary ? redact(summary) : null },
      }),
    );
    return { recorded: true };
  }

  listEvents(workspaceId: string, connectionId?: string) {
    return this.prisma.connectorEvent.findMany({ where: { workspaceId, ...(connectionId ? { connectionId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /** Per-connection health: connected + last inbound event time + manifest action count. */
  async health(workspaceId: string) {
    const conns = await this.prisma.connection.findMany({ where: { workspaceId }, select: { id: true, provider: true, scopes: true, webhookSecretHash: true } });
    const out = [];
    for (const c of conns) {
      const last = await this.prisma.connectorEvent.findFirst({ where: { workspaceId, connectionId: c.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const manifest = getManifest(c.provider);
      out.push({ provider: c.provider, connected: true, webhookConfigured: Boolean(c.webhookSecretHash), actions: manifest?.actions.length ?? 0, lastEventAt: last?.createdAt ?? null });
    }
    return out;
  }
}
