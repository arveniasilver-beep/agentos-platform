import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

export interface KnowledgeSearchHit {
  content: string;
  score: number;
  title: string | null;
}

/** Searches the workspace knowledge base. Provided by the host (wired to the RAG layer). */
export type SearchKnowledge = (query: string, topK: number) => Promise<KnowledgeSearchHit[]>;

/**
 * RAG retrieval tool: the agent searches the workspace knowledge base (ingested docs/memory) for
 * passages relevant to a query, before answering. Read-only, low risk.
 */
export function createKnowledgeSearchTool(search: SearchKnowledge): RuntimeTool {
  return {
    definition: defineTool({
      id: 'knowledge_search',
      name: 'knowledge_search',
      description:
        'Search the workspace knowledge base (RAG) for passages relevant to a query. Use this ' +
        'before answering questions that may depend on the workspace\'s ingested documents or memory.',
      inputSchema: z.object({
        query: z.string().min(1).max(2_000),
        topK: z.number().int().min(1).max(10).optional(),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({ content: z.string(), score: z.number(), title: z.string().nullable() }),
        ),
      }),
      riskLevel: 'low',
      permissions: ['knowledge.read'],
      timeoutMs: 30_000,
    }),
    run: async (input) => {
      const { query, topK } = input as { query: string; topK?: number };
      const results = await search(query, topK ?? 5);
      return { results };
    },
  };
}
