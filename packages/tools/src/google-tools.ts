import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * Google connector tools (Calendar + Drive). The REST calls are a host-provided API object (the API
 * layer binds it to the workspace's connected account + refreshes the token), so this package stays
 * free of OAuth/secret concerns. Registered only when a Google connection exists.
 */
export interface GoogleToolApi {
  listEvents(timeMinIso: string): Promise<{ events: { summary: string; start: string; end: string }[] }>;
  searchDrive(query: string): Promise<{ files: { id: string; name: string; mimeType: string; link: string }[] }>;
  searchGmail(
    query: string,
  ): Promise<{ messages: { id: string; from: string; subject: string; date: string; snippet: string }[] }>;
}

export function createGoogleTools(api: GoogleToolApi): RuntimeTool[] {
  const calendar: RuntimeTool = {
    definition: defineTool({
      id: 'google_calendar_events',
      name: 'google_calendar_events',
      description:
        'List upcoming events from the connected Google Calendar (primary calendar), starting from a ' +
        'given time. Pass since as an RFC3339 timestamp (e.g. the current time) — events on/after it ' +
        'are returned, soonest first.',
      inputSchema: z.object({
        since: z.string().min(1).max(40).describe('RFC3339 timestamp, e.g. 2026-06-20T00:00:00Z'),
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

  const drive: RuntimeTool = {
    definition: defineTool({
      id: 'google_drive_search',
      name: 'google_drive_search',
      description:
        'Search the connected Google Drive for files whose name or content matches the query. Returns ' +
        'matching files with their name, id, type, and link.',
      inputSchema: z.object({ query: z.string().min(1).max(256) }),
      outputSchema: z.object({
        files: z.array(
          z.object({ id: z.string(), name: z.string(), mimeType: z.string(), link: z.string() }),
        ),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.searchDrive((input as { query: string }).query),
  };

  const gmail: RuntimeTool = {
    definition: defineTool({
      id: 'gmail_search',
      name: 'gmail_search',
      description:
        'Search the connected Gmail inbox (supports Gmail search operators like from:, subject:, ' +
        'is:unread, newer_than:7d). Returns the top matching messages with From/Subject/Date + a ' +
        'snippet. Use to find or summarize email.',
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
    run: (input) => api.searchGmail((input as { query: string }).query),
  };

  return [calendar, drive, gmail];
}
