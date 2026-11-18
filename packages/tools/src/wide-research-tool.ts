import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/** Result of one spawned sub-agent. */
export interface SubtaskResult {
  prompt: string;
  status: string;
  summary: string;
}

/**
 * Runs a batch of sub-task prompts as parallel sub-agents and returns each one's result. Provided
 * by the host (the API layer wires it to its task runner) — the tool itself is a thin, typed
 * wrapper so the engine package stays free of orchestration concerns.
 */
export type SpawnSubtasks = (prompts: string[]) => Promise<SubtaskResult[]>;

export const WIDE_RESEARCH_MAX_SUBTASKS = 10;

/**
 * "Wide Research" — the agent decomposes its task into independent sub-tasks and runs them IN
 * PARALLEL as sub-agents (map), then receives each result to synthesize (reduce). Only top-level
 * tasks get this tool, so sub-agents can't recursively fan out. Medium risk (it spends tokens
 * across several runs), so it is approval-gateable.
 */
export function createWideResearchTool(spawn: SpawnSubtasks): RuntimeTool {
  return {
    definition: defineTool({
      id: 'wide_research',
      name: 'wide_research',
      description:
        'Decompose this task into 2-10 INDEPENDENT sub-tasks and run them in parallel as sub-agents, ' +
        'then receive each sub-task\'s result to synthesize a final answer. Use for broad fan-out ' +
        'work — analyzing many items, gathering multiple sources, or comparing options. Each ' +
        'sub-task prompt must be self-contained (the sub-agent sees only that prompt).',
      inputSchema: z.object({
        subtasks: z
          .array(z.string().min(1).max(8_000))
          .min(2)
          .max(WIDE_RESEARCH_MAX_SUBTASKS)
          .describe('Self-contained prompts, one per parallel sub-agent.'),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({ prompt: z.string(), status: z.string(), summary: z.string() }),
        ),
      }),
      // High risk: a fan-out spawns many sub-agents and spends across all of them, so it needs one
      // human confirmation (above the default 'medium' ceiling) before running unattended.
      riskLevel: 'high',
      permissions: ['task.spawn'],
      timeoutMs: 900_000,
    }),
    run: async (input) => {
      const { subtasks } = input as { subtasks: string[] };
      const results = await spawn(subtasks);
      return { results };
    },
  };
}
