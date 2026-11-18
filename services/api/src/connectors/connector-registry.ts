import { z } from 'zod';

// Connectors v2 (TICKET-9) — a connector MANIFEST declares the capabilities/actions/triggers a connector
// exposes and the scopes each action requires. Built-ins use a static registry below; the shape is
// deliberately MCP-tool-compatible (an action ↔ an MCP tool; requiredScopes ↔ tool capability scopes), so
// the same registry can back a future MCP server without redesign. Pure module — fully unit-testable.

export const connectorActionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.:-]{1,60}$/),
  description: z.string().max(200).optional(),
  requiredScopes: z.array(z.string().max(200)).max(20).default([]),
});
export const connectorTriggerSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.:-]{1,60}$/),
  webhook: z.boolean().default(false),
});
export const connectorManifestSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  version: z.string().max(20).default('1'),
  capabilities: z.array(z.string().max(60)).max(40).default([]),
  actions: z.array(connectorActionSchema).max(100).default([]),
  triggers: z.array(connectorTriggerSchema).max(40).default([]),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** Validate a raw manifest: Zod shape + unique action/trigger ids. */
export function validateManifest(raw: unknown): { ok: boolean; errors: string[]; manifest?: ConnectorManifest } {
  const p = connectorManifestSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const m = p.data;
  const errors: string[] = [];
  const aids = new Set<string>();
  for (const a of m.actions) {
    if (aids.has(a.id)) errors.push(`duplicate action id: ${a.id}`);
    aids.add(a.id);
  }
  const tids = new Set<string>();
  for (const t of m.triggers) {
    if (tids.has(t.id)) errors.push(`duplicate trigger id: ${t.id}`);
    tids.add(t.id);
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], manifest: m };
}

/** Static manifests for the existing OAuth connectors (github/notion/google/outlook). */
export const BUILTIN_MANIFESTS: Record<string, ConnectorManifest> = {
  github: {
    provider: 'github', version: '1', capabilities: ['repo.read', 'webhook.push'],
    actions: [
      { id: 'github_list_repos', requiredScopes: ['repo'] },
      { id: 'github_get_file', requiredScopes: ['repo'] },
      { id: 'github_search_code', requiredScopes: ['repo'] },
    ],
    triggers: [{ id: 'github:push', webhook: true }],
  },
  notion: {
    provider: 'notion', version: '1', capabilities: ['page.read'],
    actions: [{ id: 'notion_search', requiredScopes: [] }, { id: 'notion_get_page', requiredScopes: [] }],
    triggers: [],
  },
  google: {
    provider: 'google', version: '1', capabilities: ['calendar.read', 'drive.read', 'gmail.read'],
    actions: [
      { id: 'google_calendar_events', requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
      { id: 'google_drive_search', requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'] },
      { id: 'gmail_search', requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    ],
    triggers: [],
  },
  outlook: {
    provider: 'outlook', version: '1', capabilities: ['mail.read', 'calendar.read'],
    actions: [
      { id: 'outlook_calendar_events', requiredScopes: ['Calendars.Read'] },
      { id: 'outlook_search', requiredScopes: ['Mail.Read'] },
    ],
    triggers: [],
  },
};

export function getManifest(provider: string): ConnectorManifest | undefined {
  return BUILTIN_MANIFESTS[provider];
}

/** Capability-scope enforcement: may this action run given the connection's granted scopes? */
export function actionAllowed(manifest: ConnectorManifest, actionId: string, grantedScopes: string[]): { ok: boolean; reason: string } {
  const action = manifest.actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, reason: `unknown action: ${actionId}` };
  const granted = new Set(grantedScopes.filter(Boolean));
  const missing = action.requiredScopes.filter((s) => !granted.has(s));
  if (missing.length > 0) return { ok: false, reason: `missing required scope(s): ${missing.join(', ')}` };
  return { ok: true, reason: 'ok' };
}
