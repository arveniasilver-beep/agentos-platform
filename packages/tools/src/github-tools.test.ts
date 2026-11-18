import { describe, it, expect } from 'vitest';
import { createGithubTools, type GithubToolApi } from './index';

const api: GithubToolApi = {
  listRepos: async () => ({ repos: [{ fullName: 'octocat/hello', private: false, description: 'hi' }] }),
  getFile: async (owner, repo, path) => ({ path, content: `// ${owner}/${repo}/${path}` }),
  searchCode: async (q) => ({ results: [{ repo: 'octocat/hello', path: `match-for-${q}.ts` }] }),
};

describe('github tools', () => {
  it('registers the three GitHub tools at low risk', () => {
    const tools = createGithubTools(api);
    expect(tools.map((t) => t.definition.id).sort()).toEqual([
      'github_get_file',
      'github_list_repos',
      'github_search_code',
    ]);
    expect(tools.every((t) => t.definition.riskLevel === 'low')).toBe(true);
  });

  it('delegates each tool to the host API', async () => {
    const tools = createGithubTools(api);
    const byId = (id: string) => tools.find((t) => t.definition.id === id)!;

    expect(await byId('github_list_repos').run({})).toEqual({
      repos: [{ fullName: 'octocat/hello', private: false, description: 'hi' }],
    });
    expect(await byId('github_get_file').run({ owner: 'o', repo: 'r', path: 'a/b.ts' })).toEqual({
      path: 'a/b.ts',
      content: '// o/r/a/b.ts',
    });
    expect(await byId('github_search_code').run({ query: 'foo' })).toEqual({
      results: [{ repo: 'octocat/hello', path: 'match-for-foo.ts' }],
    });
  });
});
