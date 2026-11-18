import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * GitHub connector tools. The actual GitHub REST calls are a host-provided API object (the API layer
 * binds it to the workspace's connected account + stored token), so this package stays free of OAuth/
 * secret concerns. Registered only when a GitHub connection exists.
 */
export interface GithubToolApi {
  listRepos(): Promise<{ repos: { fullName: string; private: boolean; description: string | null }[] }>;
  getFile(owner: string, repo: string, path: string): Promise<{ path: string; content: string }>;
  searchCode(query: string): Promise<{ results: { repo: string; path: string }[] }>;
}

export function createGithubTools(api: GithubToolApi): RuntimeTool[] {
  const listRepos: RuntimeTool = {
    definition: defineTool({
      id: 'github_list_repos',
      name: 'github_list_repos',
      description: "List the connected GitHub account's repositories (most recently updated first).",
      inputSchema: z.object({}),
      outputSchema: z.object({
        repos: z.array(
          z.object({ fullName: z.string(), private: z.boolean(), description: z.string().nullable() }),
        ),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: () => api.listRepos(),
  };

  const getFile: RuntimeTool = {
    definition: defineTool({
      id: 'github_get_file',
      name: 'github_get_file',
      description: 'Read a UTF-8 text file from a GitHub repo the connected account can access.',
      inputSchema: z.object({
        owner: z.string().min(1).max(120),
        repo: z.string().min(1).max(120),
        path: z.string().min(1).max(400),
      }),
      outputSchema: z.object({ path: z.string(), content: z.string() }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => {
      const { owner, repo, path } = input as { owner: string; repo: string; path: string };
      return api.getFile(owner, repo, path);
    },
  };

  const searchCode: RuntimeTool = {
    definition: defineTool({
      id: 'github_search_code',
      name: 'github_search_code',
      description:
        'Search code in GitHub repositories the connected account can access. The query MUST include ' +
        'at least one scope qualifier — `user:<login>`, `org:<name>`, or `repo:<owner>/<name>` — e.g. ' +
        '"parseConfig repo:octocat/hello"; a bare keyword query is rejected by GitHub.',
      inputSchema: z.object({
        query: z.string().min(1).max(256).describe('Keywords + a user:/org:/repo: qualifier.'),
      }),
      outputSchema: z.object({ results: z.array(z.object({ repo: z.string(), path: z.string() })) }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: (input) => api.searchCode((input as { query: string }).query),
  };

  return [listRepos, getFile, searchCode];
}
