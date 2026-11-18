import { Injectable } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import type { BrowserSession, BrowserAction } from '@agentos/db';
import {
  sanitizeUrl,
  redactWebSecrets,
  classifyBrowserActionRisk,
  evaluateHost,
  parseHostList,
  type BrowserActionCtx,
} from '@agentos/tools';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { redactText } from '../policy/redact';

/**
 * Browser Operator Hardening (TICKET-1). Durable, workspace-isolated browser session/action trace. The
 * pure safety helpers (URL sanitize, allow/deny, redaction, content fencing, risk escalation) live in
 * `@agentos/tools` so the live tool runtime and this audited record share one implementation. All durable
 * writes here are flag-gated by the caller (the task-runner browser sink).
 */
@Injectable()
export class BrowserOperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Defense-in-depth: policy redaction + web-secret (cookie/token) redaction. */
  private static redact(text: string): string {
    return redactWebSecrets(redactText(String(text ?? '')) ?? '');
  }

  /** Allow/deny a navigation host against BROWSER_URL_ALLOWLIST/DENYLIST (complements the SSRF guard). */
  evaluateUrl(raw: string): { effect: 'allow' | 'deny'; reason: string } {
    const env = loadServerEnv();
    let host: string;
    try {
      host = new URL(raw).host.toLowerCase();
    } catch {
      return { effect: 'deny', reason: 'unparseable url' };
    }
    return evaluateHost(host, { allow: parseHostList(env.BROWSER_URL_ALLOWLIST), deny: parseHostList(env.BROWSER_URL_DENYLIST) });
  }

  // ---- durable tracking (flag-gated, best-effort; called from the task-runner browser sink) -----

  private async upsertSession(workspaceId: string, taskId: string | null): Promise<BrowserSession> {
    if (taskId) {
      const open = await this.prisma.browserSession.findFirst({
        where: { workspaceId, taskId, status: { not: 'closed' } },
        orderBy: { createdAt: 'desc' },
      });
      if (open) return open;
    }
    return this.prisma.browserSession.create({ data: { workspaceId, taskId, status: 'acting' } });
  }

  /** Record the start of a browser action: upsert the session, append a (redacted) action row, audit. */
  async onAction(p: { workspaceId: string; taskId: string | null; callId?: string; tool: string } & BrowserActionCtx): Promise<string> {
    const action = p.tool.replace(/^browser_/, '');
    const { risk, elevated } = classifyBrowserActionRisk(action, p);
    const url = sanitizeUrl(p.url);
    const session = await this.upsertSession(p.workspaceId, p.taskId);
    await this.prisma.browserAction.create({
      data: {
        sessionId: session.id,
        workspaceId: p.workspaceId,
        taskId: p.taskId,
        ...(p.callId ? { callId: p.callId } : {}),
        action,
        url,
        target: p.target ? BrowserOperatorService.redact(p.target).slice(0, 200) : null,
        risk,
        outcome: elevated ? 'awaiting_approval' : 'pending',
      },
    });
    await this.prisma.browserSession.update({
      where: { id: session.id },
      data: {
        status: 'acting',
        lastAction: action,
        lastUrl: url,
        actionCount: { increment: 1 },
        ...(elevated ? { approvalCount: { increment: 1 } } : {}),
      },
    });
    await this.audit
      .record({
        workspaceId: p.workspaceId,
        actorType: 'agent',
        action: `browser.${action}`,
        targetType: 'browser_session',
        targetId: session.id,
        risk,
        metadata: { url, callId: p.callId ?? null, elevated }, // NEVER cookies/tokens/page body
      })
      .catch(() => undefined);
    return session.id;
  }

  /** Record the outcome of a browser action (ok / denied / error) by callId. */
  async onResult(p: { workspaceId: string; callId: string; ok: boolean; error?: string }): Promise<void> {
    const act = await this.prisma.browserAction.findFirst({
      where: { workspaceId: p.workspaceId, callId: p.callId },
      orderBy: { createdAt: 'desc' },
    });
    if (!act) return;
    const denied = (p.error ?? '').toLowerCase().includes('denied');
    const outcome = p.ok ? 'ok' : denied ? 'denied' : 'error';
    await this.prisma.browserAction.update({
      where: { id: act.id },
      data: { outcome, ...(p.error ? { detail: BrowserOperatorService.redact(p.error).slice(0, 300) } : {}) },
    });
    if (denied) {
      await this.prisma.browserSession.update({ where: { id: act.sessionId }, data: { deniedCount: { increment: 1 } } });
    }
  }

  /** Mark human takeover on the task's open session (safe state for handoff). */
  async setTakeover(workspaceId: string, taskId: string, on: boolean): Promise<void> {
    const s = await this.prisma.browserSession.findFirst({ where: { workspaceId, taskId, status: { not: 'closed' } }, orderBy: { createdAt: 'desc' } });
    if (s) await this.prisma.browserSession.update({ where: { id: s.id }, data: { takeover: on, status: on ? 'takeover' : 'acting' } });
  }

  /** Close the task's open session at task end. */
  async closeSession(workspaceId: string, taskId: string): Promise<void> {
    await this.prisma.browserSession.updateMany({
      where: { workspaceId, taskId, status: { not: 'closed' } },
      data: { status: 'closed', endedAt: new Date() },
    });
  }

  // ---- read API ---------------------------------------------------------------------------------

  listSessions(workspaceId: string): Promise<BrowserSession[]> {
    return this.prisma.browserSession.findMany({ where: { workspaceId }, orderBy: { startedAt: 'desc' }, take: 100 });
  }
  getSession(workspaceId: string, id: string): Promise<BrowserSession | null> {
    return this.prisma.browserSession.findFirst({ where: { id, workspaceId } });
  }
  listActions(workspaceId: string, sessionId: string): Promise<BrowserAction[]> {
    return this.prisma.browserAction.findMany({ where: { workspaceId, sessionId }, orderBy: { createdAt: 'asc' }, take: 500 });
  }
}
