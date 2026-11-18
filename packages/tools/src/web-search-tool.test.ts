import { describe, it, expect } from 'vitest';
import { createWebSearchTool } from './web-search-tool';

// A trimmed DuckDuckGo HTML response: two results, with the uddg-wrapped hrefs + <b> highlights + entities.
const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b> &amp; Co</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First <b>snippet</b> text.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=y">Result B</a>
  </h2>
  <a class="result__snippet">Second snippet.</a>
</div>`;

function mockFetch(): any {
  return async () => ({ text: async () => DDG_HTML });
}

describe('web_search tool (Ticket-08)', () => {
  it('parses DuckDuckGo results: real URL unwrapped, tags/entities stripped, untrusted flagged', async () => {
    const tool = createWebSearchTool(mockFetch());
    const out = (await tool.run({ query: 'example' })) as {
      query: string;
      results: { rank: number; title: string; url: string; snippet: string }[];
      untrusted: boolean;
    };
    expect(out.untrusted).toBe(true); // results are marked untrusted (injection mitigation)
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ rank: 1, url: 'https://example.com/a', title: 'Example A & Co', snippet: 'First snippet text.' });
    expect(out.results[1]).toMatchObject({ rank: 2, url: 'https://example.org/b', title: 'Result B', snippet: 'Second snippet.' });
    // no raw HTML / tracking redirect leaks through
    expect(JSON.stringify(out.results)).not.toContain('<b>');
    expect(JSON.stringify(out.results)).not.toContain('duckduckgo.com/l/');
  });

  it('respects the count cap', async () => {
    const tool = createWebSearchTool(mockFetch());
    const out = (await tool.run({ query: 'example', count: 1 })) as { results: unknown[] };
    expect(out.results).toHaveLength(1);
  });
});
