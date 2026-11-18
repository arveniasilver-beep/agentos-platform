import { describe, it, expect } from 'vitest';
import { createNotionTools, type NotionToolApi } from './index';

const api: NotionToolApi = {
  search: async (query) => ({ results: [{ id: 'p1', title: `hit:${query}`, url: 'u', type: 'page' }] }),
  getPage: async (id) => ({ id, title: 'Page', url: 'u' }),
};

describe('notion tools', () => {
  it('registers notion_search + notion_get_page', () => {
    expect(createNotionTools(api).map((t) => t.definition.id).sort()).toEqual(['notion_get_page', 'notion_search']);
  });

  it('delegates search and get_page to the host api', async () => {
    const tools = createNotionTools(api);
    const search = tools.find((t) => t.definition.id === 'notion_search')!;
    const get = tools.find((t) => t.definition.id === 'notion_get_page')!;
    expect(await search.run({ query: 'plan' })).toEqual({ results: [{ id: 'p1', title: 'hit:plan', url: 'u', type: 'page' }] });
    expect(await get.run({ id: 'abc' })).toEqual({ id: 'abc', title: 'Page', url: 'u' });
  });
});
