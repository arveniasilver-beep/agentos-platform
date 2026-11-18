import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * Notion connector tools. The Notion REST calls are a host-provided API object (the API layer binds it
 * to the workspace's connected account + stored token), so this package stays free of OAuth/secret
 * concerns. Registered only when a Notion connection exists.
 */
export interface NotionToolApi {
  search(query: string): Promise<{ results: { id: string; title: string; url: string; type: string }[] }>;
  getPage(id: string): Promise<{ id: string; title: string; url: string }>;
}

export function createNotionTools(api: NotionToolApi): RuntimeTool[] {
  const search: RuntimeTool = {
    definition: defineTool({
      id: 'notion_search',
      name: 'notion_search',
      description:
        'Search the connected Notion workspace for pages and databases by keyword. Returns matching ' +
        'items with their title, id, and URL. Use to find a Notion page before reading it.',
      inputSchema: z.object({ query: z.string().min(1).max(256) }),
      outputSchema: z.object({
        results: z.array(
          z.object({ id: z.string(), title: z.string(), url: z.string(), type: z.string() }),
        ),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.search((input as { query: string }).query),
  };

  const getPage: RuntimeTool = {
    definition: defineTool({
      id: 'notion_get_page',
      name: 'notion_get_page',
      description: 'Fetch a Notion page (its title + URL) by id from the connected workspace.',
      inputSchema: z.object({ id: z.string().min(1).max(120) }),
      outputSchema: z.object({ id: z.string(), title: z.string(), url: z.string() }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.getPage((input as { id: string }).id),
  };

  return [search, getPage];
}
