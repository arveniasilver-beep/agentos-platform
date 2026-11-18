import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeliverableTools, type RuntimeTool } from './index';

function byId(tools: RuntimeTool[], id: string): RuntimeTool {
  const t = tools.find((x) => x.definition.id === id);
  if (!t) throw new Error(`tool not found: ${id}`);
  return t;
}

describe('deliverable generators', () => {
  let root: string;
  let tools: RuntimeTool[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deliv-'));
    tools = createDeliverableTools({ root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

  it('registers the five generators with low risk + fs.write', () => {
    expect(tools.map((t) => t.definition.id).sort()).toEqual([
      'generate_chart',
      'generate_document',
      'generate_slides',
      'generate_spreadsheet',
      'generate_website',
    ]);
    for (const t of tools) {
      expect(t.definition.riskLevel).toBe('low');
      expect(t.definition.permissions).toContain('fs.write');
    }
  });

  it('generate_slides writes a self-contained, navigable HTML deck', async () => {
    const res = (await byId(tools, 'generate_slides').run({
      title: 'Quarterly Review',
      slides: [
        { heading: 'Intro', bullets: ['One', 'Two'] },
        { heading: 'Numbers', body: 'Revenue up 20%.', notes: 'speaker note' },
      ],
    })) as { path: string; slides: number };
    expect(res.slides).toBe(2);
    expect(res.path).toBe('deliverables/quarterly-review.html');
    const html = read(res.path);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Quarterly Review');
    expect(html).toContain('class="slide active"');
    expect(html).toContain('ArrowRight'); // embedded controller, no external lib
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('escapes HTML so model text cannot inject markup', async () => {
    const res = (await byId(tools, 'generate_slides').run({
      title: 'XSS <script>alert(1)</script>',
      slides: [{ heading: '<img src=x onerror=alert(1)>', bullets: ['"quote" & <b>bold</b>'] }],
    })) as { path: string };
    const html = read(res.path);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('generate_document writes both HTML and Markdown mirrors', async () => {
    const res = (await byId(tools, 'generate_document').run({
      title: 'Field Report',
      sections: [
        { heading: 'Summary', paragraphs: ['Line one.', 'Line two.'] },
        { heading: 'Findings', bullets: ['A', 'B', 'C'] },
      ],
    })) as { htmlPath: string; markdownPath: string };
    expect(res.htmlPath).toBe('deliverables/field-report.html');
    expect(res.markdownPath).toBe('deliverables/field-report.md');
    const md = read(res.markdownPath);
    expect(md).toContain('# Field Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('- A');
    const html = read(res.htmlPath);
    expect(html).toContain('<h1>Field Report</h1>');
    expect(html).toContain('<li>A</li>');
  });

  it('generate_chart renders valid SVG for bar, line, and pie', async () => {
    const chart = byId(tools, 'generate_chart');
    for (const type of ['bar', 'line', 'pie'] as const) {
      const res = (await chart.run({
        title: `${type} chart`,
        type,
        data: [
          { label: 'Jan', value: 10 },
          { label: 'Feb', value: 25 },
          { label: 'Mar', value: 15 },
        ],
      })) as { path: string };
      const svg = read(res.path);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('viewBox');
    }
  });

  it('pie chart with a single category renders a full circle (no degenerate arc)', async () => {
    const res = (await byId(tools, 'generate_chart').run({
      title: 'solo',
      type: 'pie',
      data: [{ label: 'All', value: 100 }],
    })) as { path: string };
    const svg = read(res.path);
    expect(svg).toContain('<circle');
    expect(svg).toContain('100.0%');
  });

  it('generate_spreadsheet writes CSV per sheet (RFC-escaped) + an HTML preview', async () => {
    const res = (await byId(tools, 'generate_spreadsheet').run({
      title: 'Budget 2025',
      sheets: [
        {
          name: 'Q1',
          columns: ['Item', 'Cost', 'Note'],
          rows: [
            ['Rent', 1000, 'monthly'],
            ['Tools, misc', 50, 'has "quotes" and, comma'],
          ],
        },
      ],
    })) as { csvPaths: string[]; htmlPath: string; rows: number };
    expect(res.rows).toBe(2);
    expect(res.csvPaths).toHaveLength(1);
    const csv = read(res.csvPaths[0]!);
    expect(csv).toContain('Item,Cost,Note');
    // Field with a comma is quoted; internal quotes are doubled.
    expect(csv).toContain('"Tools, misc"');
    expect(csv).toContain('"has ""quotes"" and, comma"');
    expect(read(res.htmlPath)).toContain('<table>');
  });

  it('spreadsheet de-duplicates colliding sheet slugs', async () => {
    const res = (await byId(tools, 'generate_spreadsheet').run({
      title: 'dup',
      sheets: [
        { name: 'Q1 2025', columns: ['a'], rows: [['1']] },
        { name: 'Q1-2025', columns: ['a'], rows: [['2']] },
      ],
    })) as { csvPaths: string[] };
    expect(new Set(res.csvPaths).size).toBe(2);
  });

  it('generate_website writes a multi-page site with shared styles + nav', async () => {
    const res = (await byId(tools, 'generate_website').run({
      name: 'Acme Co',
      pages: [
        { title: 'Home', sections: [{ heading: 'Welcome', paragraphs: ['Hi.'] }] },
        { title: 'About', sections: [{ heading: 'Story', paragraphs: ['Founded.'] }] },
      ],
    })) as { indexPath: string; files: string[] };
    expect(res.indexPath).toBe('deliverables/acme-co/index.html');
    expect(existsSync(join(root, 'deliverables/acme-co/styles.css'))).toBe(true);
    const files = readdirSync(join(root, 'deliverables/acme-co')).sort();
    expect(files).toContain('index.html');
    expect(files).toContain('styles.css');
    const index = read(res.indexPath);
    expect(index).toContain('href="./styles.css"');
    expect(index).toContain('href="./about.html"'); // nav links to the other page
  });

  it('neutralizes CSV formula/DDE injection in cell values', async () => {
    const res = (await byId(tools, 'generate_spreadsheet').run({
      title: 'inj',
      sheets: [
        {
          name: 's',
          columns: ['payload'],
          rows: [['=cmd|\'/C calc\'!A1'], ['+1+1'], ['-2+3'], ['@SUM(A1)'], ['safe text']],
        },
      ],
    })) as { csvPaths: string[] };
    const csv = read(res.csvPaths[0]!);
    // Dangerous leads are apostrophe-prefixed and quoted; benign text is left alone.
    expect(csv).toContain('"\'=cmd');
    expect(csv).toContain('"\'+1+1"');
    expect(csv).toContain('"\'-2+3"');
    expect(csv).toContain('"\'@SUM(A1)"');
    expect(csv).toContain('safe text');
    // No raw formula-leading cell survives.
    expect(csv).not.toMatch(/(^|,)=cmd/);
  });

  it('pads/truncates ragged spreadsheet rows to the column count', async () => {
    const res = (await byId(tools, 'generate_spreadsheet').run({
      title: 'ragged',
      sheets: [{ name: 's', columns: ['a', 'b', 'c'], rows: [['1'], ['1', '2', '3', '4']] }],
    })) as { csvPaths: string[] };
    const lines = read(res.csvPaths[0]!).trim().split('\r\n');
    expect(lines[0]).toBe('a,b,c');
    expect(lines[1]).toBe('1,,'); // short row padded
    expect(lines[2]).toBe('1,2,3'); // long row truncated
  });

  it('renders bars below the axis for negative values (no clamp-to-zero)', async () => {
    const res = (await byId(tools, 'generate_chart').run({
      title: 'pnl',
      type: 'bar',
      data: [
        { label: 'Q1', value: 50 },
        { label: 'Q2', value: -30 },
      ],
    })) as { path: string };
    const svg = read(res.path);
    // The negative bar must have real height (it is not clamped to a zero-height baseline rect).
    // Match only bar rects (they carry rx="3"), not the background rect.
    const heights = [...svg.matchAll(/<rect[^>]*height="([\d.]+)"[^>]*rx="3"/g)].map((m) => Number(m[1]));
    expect(heights.filter((h) => h > 1).length).toBe(2);
    expect(svg).toContain('>-30<'); // label preserved
  });

  it('renders an all-negative chart without collapsing to an empty plot', async () => {
    const res = (await byId(tools, 'generate_chart').run({
      title: 'neg',
      type: 'bar',
      data: [
        { label: 'a', value: -5 },
        { label: 'b', value: -10 },
      ],
    })) as { path: string };
    const svg = read(res.path);
    const heights = [...svg.matchAll(/<rect[^>]*height="([\d.]+)"[^>]*rx="3"/g)].map((m) => Number(m[1]));
    expect(heights.some((h) => h > 1)).toBe(true); // not a blank chart
  });

  it('escapes Markdown-structural model text in the document mirror', async () => {
    const res = (await byId(tools, 'generate_document').run({
      title: 'Doc',
      sections: [{ heading: 'S', paragraphs: ['## Not a heading', 'line one\nline two'] }],
    })) as { markdownPath: string };
    const md = read(res.markdownPath);
    // A paragraph that starts with '##' must not become a real heading.
    expect(md).toContain('\\## Not a heading');
    // Embedded newline is flattened so it does not split the paragraph.
    expect(md).toContain('line one line two');
  });

  it('enforces a cumulative byte cap across all spreadsheet files', async () => {
    const small = createDeliverableTools({ root, maxBytes: 1_000 });
    // Each sheet's CSV is under 1000 bytes, but the sum exceeds it — must throw cumulatively.
    const rows = Array.from({ length: 30 }, (_, i) => [`row-${i}-${'x'.repeat(20)}`]);
    await expect(
      byId(small, 'generate_spreadsheet').run({
        title: 'big',
        sheets: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, columns: ['c'], rows })),
      }),
    ).rejects.toThrow(/limit/);
  });

  it('enforces the byte cap', async () => {
    const small = createDeliverableTools({ root, maxBytes: 200 });
    await expect(
      byId(small, 'generate_document').run({
        title: 'Big',
        sections: [{ heading: 'X', paragraphs: ['y'.repeat(5_000)] }],
      }),
    ).rejects.toThrow(/limit/);
  });

  it('slugifies hostile titles so files stay inside deliverables/', async () => {
    const res = (await byId(tools, 'generate_chart').run({
      title: '../../etc/passwd',
      type: 'bar',
      data: [{ label: 'a', value: 1 }],
    })) as { path: string };
    expect(res.path).toBe('deliverables/etc-passwd.svg');
    expect(res.path).not.toContain('..');
  });
});
