import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * Microsoft (Outlook / Microsoft 365) connector tools (Mail + Calendar). The REST calls are a
 * host-provided API object (the API layer binds it to the workspace's connected account + refreshes
 * the token), so this package stays free of OAuth/secret concerns. Registered only when an Outlook
 * connection exists. Read-only.
 */
export interface OutlookToolApi {
  listEvents(timeMinIso: string): Promise<{ events: { summary: string; start: string; end: string }[] }>;
  searchMail(
    query: string,
  ): Promise<{ messages: { id: string; from: string; subject: string; date: string; snippet: string }[] }>;
}

export function createOutlookTools(api: OutlookToolApi): RuntimeTool[] {
  const calendar: RuntimeTool = {
    definition: defineTool({
      id: 'outlook_calendar_events',
      name: 'outlook_calendar_events',
      description:
        'List upcoming events from the connected Outlook (Microsoft 365) calendar, starting from a ' +
        'given time. Pass since as an ISO timestamp (e.g. the current time) — events on/after it are ' +
        'returned over the next 30 days, soonest first.',
      inputSchema: z.object({
        since: z.string().min(1).max(40).describe('ISO timestamp, e.g. 2026-06-21T00:00:00Z'),
      }),
      outputSchema: z.object({
        events: z.array(z.object({ summary: z.string(), start: z.string(), end: z.string() })),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.listEvents((input as { since: string }).since),
  };

  const mail: RuntimeTool = {
    definition: defineTool({
      id: 'outlook_search',
      name: 'outlook_search',
      description:
        'Search the connected Outlook (Microsoft 365) mailbox by keyword. Returns the top matching ' +
        'messages with From/Subject/Date + a preview. Use to find or summarize email.',
      inputSchema: z.object({ query: z.string().min(1).max(256) }),
      outputSchema: z.object({
        messages: z.array(
          z.object({ id: z.string(), from: z.string(), subject: z.string(), date: z.string(), snippet: z.string() }),
        ),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.searchMail((input as { query: string }).query),
  };

  return [calendar, mail];
}
