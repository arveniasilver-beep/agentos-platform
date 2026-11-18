import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * "Deliverable generators" — the tools that let the agent produce real, downloadable work products
 * (slide decks, documents, charts, multi-page websites, spreadsheets) instead of only chat text.
 * Every generator renders self-contained output (no external CDN/runtime) into the task's sandbox
 * under `deliverables/`, where the artifact system already lists and serves it. All model-supplied
 * text is HTML/CSV-escaped at interpolation, and every filename is slugified to a plain basename so
 * nothing can escape the deliverables folder. This is the capability layer that puts the platform in
 * the Manus "do-the-work" category rather than the assistant category.
 */

/** Escape the five HTML-significant characters so model text can never break out of markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Reduce arbitrary text to a safe, lowercase filename base (never empty, length-capped). */
function slugify(s: string, fallback = 'deliverable'): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || fallback;
}

/**
 * Encode a CSV field per RFC 4180 (quote when it contains a quote/comma/newline; double internal
 * quotes) AND neutralize CSV/formula (DDE) injection (CWE-1236): a cell that begins with =, +, -, @,
 * or a leading tab is evaluated as a formula by Excel/Sheets/LibreOffice. Since cell values are
 * untrusted model output, prefix such a cell with an apostrophe so it is treated as literal text,
 * and force-quote the result.
 */
function csvField(value: string | number): string {
  // A real number is inherently safe — emit it as-is so negatives (-3.5) aren't mangled into text.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const s = value;
  // Formula/DDE injection (CWE-1236) only matters for untrusted STRING cells.
  const dangerous = /^[=+@\t-]/.test(s);
  const safe = dangerous ? `'${s}` : s;
  return /[",\r\n]/.test(safe) || dangerous ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Flatten newlines and escape a leading Markdown-structural char so model prose stays literal text. */
function mdInline(s: string): string {
  const flat = s.replace(/\s*\n\s*/g, ' ').trim();
  return flat.replace(/^([#>|`~*+-])/, '\\$1').replace(/^(\d+)\.(\s)/, '$1\\.$2');
}

const DELIVERABLES_DIR = 'deliverables';

/** Page-level CSS shared by the HTML deliverables — neutral, print-friendly, dependency-free. */
const BASE_CSS = `
:root { --fg:#1a1a2e; --muted:#5a5a72; --accent:#4f46e5; --bg:#ffffff; --soft:#f4f4fb; --border:#e3e3ef; }
* { box-sizing: border-box; }
body { margin:0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--fg); background:var(--bg); line-height:1.6; }
h1,h2,h3 { line-height:1.25; }
a { color: var(--accent); }
code { background:var(--soft); padding:2px 6px; border-radius:4px; font-size:.9em; }
table { border-collapse: collapse; width:100%; margin:1rem 0; }
th,td { border:1px solid var(--border); padding:.5rem .7rem; text-align:left; }
th { background:var(--soft); }
`.trim();

interface DeliverableToolsOptions {
  /** Absolute path to the task sandbox root; deliverables are written under `<root>/deliverables`. */
  root: string;
  /** Per-call cap on total bytes written (defends disk against a runaway generation). */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// Schemas (kept ergonomic for the model — structured, not free-form markup it has to hand-author)
// ---------------------------------------------------------------------------------------------

const slideSchema = z.object({
  heading: z.string().min(1).max(200),
  bullets: z.array(z.string().min(1).max(500)).max(12).optional(),
  body: z.string().max(4_000).optional(),
  notes: z.string().max(2_000).optional(),
});

const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  paragraphs: z.array(z.string().min(1).max(8_000)).max(40).optional(),
  bullets: z.array(z.string().min(1).max(1_000)).max(60).optional(),
});

const chartPointSchema = z.object({ label: z.string().min(1).max(80), value: z.number().finite() });

const sheetSchema = z.object({
  name: z.string().min(1).max(80),
  columns: z.array(z.string().max(120)).min(1).max(50),
  rows: z.array(z.array(z.union([z.string().max(2_000), z.number()])).max(50)).max(5_000),
});

const pageSchema = z.object({
  title: z.string().min(1).max(120),
  filename: z.string().max(60).optional(),
  sections: z.array(sectionSchema).min(1).max(40),
});

// ---------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------

function renderSectionsHtml(sections: z.infer<typeof sectionSchema>[]): string {
  return sections
    .map((s) => {
      const paras = (s.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join('\n');
      const list = s.bullets?.length
        ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
        : '';
      return `<section>\n<h2>${esc(s.heading)}</h2>\n${paras}\n${list}\n</section>`;
    })
    .join('\n');
}

function renderSlidesHtml(title: string, slides: z.infer<typeof slideSchema>[]): string {
  const slideMarkup = slides
    .map((s, i) => {
      const bullets = s.bullets?.length
        ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
        : '';
      const body = s.body ? `<p>${esc(s.body)}</p>` : '';
      const notes = s.notes ? `<aside class="notes" hidden>${esc(s.notes)}</aside>` : '';
      return `<section class="slide${i === 0 ? ' active' : ''}" data-index="${i}">
  <div class="inner"><h2>${esc(s.heading)}</h2>${body}${bullets}${notes}</div>
</section>`;
    })
    .join('\n');

  // Self-contained deck: embedded CSS + a tiny vanilla-JS controller (arrow keys / on-screen
  // controls). No external library, so it opens offline and survives a sandboxed environment.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}
body { background:#0f0f1a; color:#fff; overflow:hidden; }
.slide { position:fixed; inset:0; display:none; align-items:center; justify-content:center; padding:6vh 8vw; }
.slide.active { display:flex; }
.slide .inner { max-width:1000px; width:100%; }
.slide h2 { font-size:clamp(28px,5vw,52px); margin:0 0 .6em; color:#fff; }
.slide p { font-size:clamp(16px,2.4vw,26px); color:#d7d7e6; }
.slide li { font-size:clamp(16px,2.2vw,24px); color:#e8e8f4; margin:.35em 0; }
.bar { position:fixed; bottom:0; left:0; right:0; display:flex; gap:12px; align-items:center; justify-content:center; padding:14px; background:rgba(0,0,0,.35); }
.bar button { background:#4f46e5; color:#fff; border:0; border-radius:8px; padding:8px 16px; font-size:16px; cursor:pointer; }
.bar #count { color:#bdbdd6; font-variant-numeric:tabular-nums; }
</style></head>
<body>
${slideMarkup}
<div class="bar"><button id="prev">‹ Prev</button><span id="count"></span><button id="next">Next ›</button></div>
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide')), i=0;
  var count=document.getElementById('count');
  function show(n){ i=Math.max(0,Math.min(slides.length-1,n)); slides.forEach(function(s,k){ s.classList.toggle('active',k===i); }); count.textContent=(i+1)+' / '+slides.length; }
  document.getElementById('next').onclick=function(){ show(i+1); };
  document.getElementById('prev').onclick=function(){ show(i-1); };
  document.addEventListener('keydown',function(e){ if(e.key==='ArrowRight'||e.key===' '){ show(i+1); } else if(e.key==='ArrowLeft'){ show(i-1); } });
  show(0);
})();
</script>
</body></html>`;
}

function renderDocumentHtml(title: string, sections: z.infer<typeof sectionSchema>[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}
body { max-width:820px; margin:0 auto; padding:48px 24px; }
h1 { font-size:2.2rem; border-bottom:2px solid var(--border); padding-bottom:.3em; }
section { margin:2rem 0; }
@media print { body { max-width:none; } }
</style></head>
<body>
<h1>${esc(title)}</h1>
${renderSectionsHtml(sections)}
</body></html>`;
}

function renderDocumentMarkdown(title: string, sections: z.infer<typeof sectionSchema>[]): string {
  const body = sections
    .map((s) => {
      // Normalize model text so embedded newlines / leading '#'/'-'/'|'/fence chars can't corrupt
      // the Markdown structure (the .md must mirror the same sections as the .html).
      const paras = (s.paragraphs ?? []).map(mdInline).join('\n\n');
      const list = (s.bullets ?? []).map((b) => `- ${mdInline(b)}`).join('\n');
      return [`## ${mdInline(s.heading)}`, paras, list].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
  return `# ${mdInline(title)}\n\n${body}\n`;
}

const CHART_W = 720;
const CHART_H = 440;
const PALETTE = ['#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899', '#84cc16'];

function renderChartSvg(
  title: string,
  type: 'bar' | 'line' | 'pie',
  data: z.infer<typeof chartPointSchema>[],
): string {
  const pad = { top: 56, right: 24, bottom: 72, left: 64 };
  const plotW = CHART_W - pad.left - pad.right;
  const plotH = CHART_H - pad.top - pad.bottom;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_W} ${CHART_H}" font-family="-apple-system, Segoe UI, Roboto, sans-serif">
<rect width="${CHART_W}" height="${CHART_H}" fill="#ffffff"/>
<text x="${CHART_W / 2}" y="32" text-anchor="middle" font-size="20" font-weight="600" fill="#1a1a2e">${esc(title)}</text>`;

  if (type === 'pie') {
    const total = data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
    const cx = pad.left + plotW / 2;
    const cy = pad.top + plotH / 2;
    const r = Math.min(plotW, plotH) / 2 - 8;
    let angle = -Math.PI / 2; // start at 12 o'clock
    const arcs = data
      .map((d, i) => {
        const frac = Math.max(0, d.value) / total;
        const next = angle + frac * Math.PI * 2;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(next);
        const y2 = cy + r * Math.sin(next);
        const large = frac > 0.5 ? 1 : 0;
        // A single slice that is (within rounding) the whole pie can't be drawn as an arc whose
        // start and end points coincide — render it as a full circle instead.
        const path =
          frac >= 0.999
            ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PALETTE[i % PALETTE.length]}"/>`
            : `<path d="M${cx} ${cy} L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${PALETTE[i % PALETTE.length]}"/>`;
        angle = next;
        return path;
      })
      .join('\n');
    const legend = data
      .map((d, i) => {
        const ly = pad.top + i * 22;
        const pct = ((Math.max(0, d.value) / total) * 100).toFixed(1);
        return `<rect x="${CHART_W - pad.right - 150}" y="${ly}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/>
<text x="${CHART_W - pad.right - 132}" y="${ly + 11}" font-size="12" fill="#5a5a72">${esc(d.label)} (${pct}%)</text>`;
      })
      .join('\n');
    return `${head}\n${arcs}\n${legend}\n</svg>`;
  }

  // bar + line scale to the data's FULL [min,max] range with a real zero baseline, so negative
  // values render below the axis instead of being clamped to zero (which silently mis-drew them).
  const values = data.map((d) => d.value);
  const dataMax = Math.max(0, ...values);
  const dataMin = Math.min(0, ...values);
  const span = dataMax - dataMin || 1; // all-zero data: avoid divide-by-zero
  const x0 = pad.left;
  const yTop = pad.top;
  const yBottom = pad.top + plotH;
  const yOf = (v: number): number => yBottom - ((v - dataMin) / span) * plotH; // value -> pixel y
  const yZero = yOf(0); // the baseline (value 0), which sits inside the plot when data straddles 0
  const decimals = span < 10 ? 1 : 0;
  const axes = `<line x1="${x0}" y1="${yTop}" x2="${x0}" y2="${yBottom}" stroke="#cfcfde"/>
<line x1="${x0}" y1="${yZero.toFixed(2)}" x2="${x0 + plotW}" y2="${yZero.toFixed(2)}" stroke="#cfcfde"/>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const v = dataMin + t * span;
      const y = yOf(v);
      return `<line x1="${x0 - 4}" y1="${y.toFixed(2)}" x2="${x0 + plotW}" y2="${y.toFixed(2)}" stroke="#eeeef6"/>
<text x="${x0 - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#9a9ab0">${v.toFixed(decimals)}</text>`;
    })
    .join('\n');
  const slot = plotW / data.length;

  if (type === 'bar') {
    const bars = data
      .map((d, i) => {
        const bw = Math.max(6, slot * 0.6);
        const bx = x0 + i * slot + (slot - bw) / 2;
        const yVal = yOf(d.value);
        const top = Math.min(yVal, yZero); // bar spans between the value and the zero line
        const h = Math.max(0, Math.abs(yVal - yZero));
        // Value label above positive bars, below negative bars; category label always at the bottom.
        const labelY = d.value >= 0 ? top - 6 : top + h + 14;
        return `<rect x="${bx.toFixed(2)}" y="${top.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="3" fill="${PALETTE[i % PALETTE.length]}"/>
<text x="${(bx + bw / 2).toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle" font-size="11" fill="#5a5a72">${esc(String(d.value))}</text>
<text x="${(bx + bw / 2).toFixed(2)}" y="${(yBottom + 18).toFixed(2)}" text-anchor="middle" font-size="11" fill="#5a5a72">${esc(d.label)}</text>`;
      })
      .join('\n');
    return `${head}\n${axes}\n${ticks}\n${bars}\n</svg>`;
  }

  // line
  const pts = data.map((d, i) => {
    const x = x0 + i * slot + slot / 2;
    const y = yOf(d.value);
    return { x, y, d };
  });
  const poly = `<polyline fill="none" stroke="${PALETTE[0]}" stroke-width="2.5" points="${pts
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ')}"/>`;
  const dots = pts
    .map(
      (p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4" fill="${PALETTE[0]}"/>
<text x="${p.x.toFixed(2)}" y="${(yBottom + 18).toFixed(2)}" text-anchor="middle" font-size="11" fill="#5a5a72">${esc(p.d.label)}</text>`,
    )
    .join('\n');
  return `${head}\n${axes}\n${ticks}\n${poly}\n${dots}\n</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------------------------

/**
 * Build the deliverable-generation tools, all scoped to one task sandbox. Returns real RuntimeTools
 * the engine can call; each writes self-contained file(s) under `deliverables/` and returns their
 * relative paths so the model can reference them and the user can download them.
 */
export function createDeliverableTools(opts: DeliverableToolsOptions): RuntimeTool[] {
  const baseDir = join(opts.root, DELIVERABLES_DIR);
  const maxBytes = opts.maxBytes ?? 4_000_000;

  /** Write one file under deliverables/, enforcing the byte cap; returns its sandbox-relative path. */
  const writeOut = async (relName: string, content: string): Promise<{ path: string; bytes: number }> => {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`deliverable exceeds the ${maxBytes}-byte limit (${bytes} bytes)`);
    }
    await mkdir(baseDir, { recursive: true });
    await writeFile(join(baseDir, relName), content, 'utf8');
    return { path: `${DELIVERABLES_DIR}/${relName}`, bytes };
  };

  const generateSlides: RuntimeTool = {
    definition: defineTool({
      id: 'generate_slides',
      name: 'generate_slides',
      description:
        'Produce a self-contained, navigable HTML slide deck (one section per slide, arrow-key/Click ' +
        'navigation, presenter notes). Use when the user wants a presentation or slides. Returns the ' +
        'downloadable .html artifact path.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        slides: z.array(slideSchema).min(1).max(60),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number(), slides: z.number() }),
      riskLevel: 'low',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { title, slides } = input as { title: string; slides: z.infer<typeof slideSchema>[] };
      const html = renderSlidesHtml(title, slides);
      const out = await writeOut(`${slugify(title, 'slides')}.html`, html);
      return { ...out, slides: slides.length };
    },
  };

  const generateDocument: RuntimeTool = {
    definition: defineTool({
      id: 'generate_document',
      name: 'generate_document',
      description:
        'Produce a polished, print-ready document/report as standalone styled HTML plus a Markdown ' +
        'mirror. Use for reports, briefs, articles, or any long-form written deliverable. Returns the ' +
        'artifact paths.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        sections: z.array(sectionSchema).min(1).max(80),
      }),
      outputSchema: z.object({ htmlPath: z.string(), markdownPath: z.string(), bytes: z.number() }),
      riskLevel: 'low',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { title, sections } = input as {
        title: string;
        sections: z.infer<typeof sectionSchema>[];
      };
      const base = slugify(title, 'document');
      const htmlContent = renderDocumentHtml(title, sections);
      const mdContent = renderDocumentMarkdown(title, sections);
      // Cumulative cap across the html + md pair (not just per-file).
      if (Buffer.byteLength(htmlContent, 'utf8') + Buffer.byteLength(mdContent, 'utf8') > maxBytes) {
        throw new Error(`document exceeds the ${maxBytes}-byte limit`);
      }
      const html = await writeOut(`${base}.html`, htmlContent);
      const md = await writeOut(`${base}.md`, mdContent);
      return { htmlPath: html.path, markdownPath: md.path, bytes: html.bytes + md.bytes };
    },
  };

  const generateChart: RuntimeTool = {
    definition: defineTool({
      id: 'generate_chart',
      name: 'generate_chart',
      description:
        'Render a data chart (bar, line, or pie) as a clean, self-contained SVG from labelled values. ' +
        'Use for data visualization. Returns the downloadable .svg artifact path.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        type: z.enum(['bar', 'line', 'pie']),
        data: z.array(chartPointSchema).min(1).max(40),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      riskLevel: 'low',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { title, type, data } = input as {
        title: string;
        type: 'bar' | 'line' | 'pie';
        data: z.infer<typeof chartPointSchema>[];
      };
      const svg = renderChartSvg(title, type, data);
      return writeOut(`${slugify(title, 'chart')}.svg`, svg);
    },
  };

  const generateSpreadsheet: RuntimeTool = {
    definition: defineTool({
      id: 'generate_spreadsheet',
      name: 'generate_spreadsheet',
      description:
        'Produce a spreadsheet as CSV file(s) (one per sheet, opens directly in Excel/Sheets) plus an ' +
        'HTML preview of all sheets as tables. Use for tabular data, datasets, or budgets. Returns the ' +
        'artifact paths.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        sheets: z.array(sheetSchema).min(1).max(20),
      }),
      outputSchema: z.object({
        csvPaths: z.array(z.string()),
        htmlPath: z.string(),
        rows: z.number(),
      }),
      riskLevel: 'low',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { title, sheets } = input as { title: string; sheets: z.infer<typeof sheetSchema>[] };
      const base = slugify(title, 'spreadsheet');
      const csvPaths: string[] = [];
      let rows = 0;
      // Cumulative byte budget across ALL files this call writes (the per-file writeOut check alone
      // would let 20 sheets each near the cap add up to ~20x maxBytes in the sandbox).
      let written = 0;
      const guard = (content: string): void => {
        written += Buffer.byteLength(content, 'utf8');
        if (written > maxBytes) throw new Error(`spreadsheet exceeds the ${maxBytes}-byte limit`);
      };
      // Pad/truncate each row to the sheet's column count so the CSV and HTML never go ragged
      // (a row with too few/many cells would misalign against the header).
      const fit = (row: (string | number)[], width: number): (string | number)[] => {
        const out = row.slice(0, width);
        while (out.length < width) out.push('');
        return out;
      };
      const usedNames = new Set<string>();
      for (const sheet of sheets) {
        const width = sheet.columns.length;
        let name = slugify(sheet.name, 'sheet');
        // De-duplicate slugs (two sheets named "Q1 2025" / "Q1-2025" would collide on one file).
        let n = name;
        let k = 2;
        while (usedNames.has(n)) n = `${name}-${k++}`;
        name = n;
        usedNames.add(name);
        const header = sheet.columns.map(csvField).join(',');
        const body = sheet.rows.map((r) => fit(r, width).map(csvField).join(',')).join('\r\n');
        rows += sheet.rows.length;
        const csv = body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
        guard(csv);
        const out = await writeOut(`${base}-${name}.csv`, csv);
        csvPaths.push(out.path);
      }
      const tables = sheets
        .map((sheet) => {
          const width = sheet.columns.length;
          const head = `<tr>${sheet.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
          const body = sheet.rows
            .map(
              (r) => `<tr>${fit(r, width).map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`,
            )
            .join('\n');
          return `<h2>${esc(sheet.name)}</h2>\n<table>${head}\n${body}</table>`;
        })
        .join('\n');
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}
body{max-width:1000px;margin:0 auto;padding:32px;}</style></head><body><h1>${esc(title)}</h1>${tables}</body></html>`;
      guard(html);
      const htmlOut = await writeOut(`${base}.html`, html);
      return { csvPaths, htmlPath: htmlOut.path, rows };
    },
  };

  const generateWebsite: RuntimeTool = {
    definition: defineTool({
      id: 'generate_website',
      name: 'generate_website',
      description:
        'Produce a self-contained multi-page static website (shared stylesheet, nav between pages) ' +
        'under deliverables/<name>/. Use when the user wants a site or landing page. Returns the entry ' +
        'index.html path and the full file list.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        pages: z.array(pageSchema).min(1).max(20),
      }),
      outputSchema: z.object({
        indexPath: z.string(),
        files: z.array(z.string()),
      }),
      riskLevel: 'low',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { name, pages } = input as { name: string; pages: z.infer<typeof pageSchema>[] };
      const siteSlug = slugify(name, 'site');
      const siteDir = join(baseDir, siteSlug);
      await mkdir(siteDir, { recursive: true });

      // Resolve a unique .html filename per page; the first page is always index.html.
      const used = new Set<string>();
      const resolved = pages.map((p, i) => {
        const file = i === 0 ? 'index.html' : `${slugify(p.filename || p.title, `page-${i}`)}.html`;
        let candidate = file;
        let k = 2;
        while (used.has(candidate)) candidate = file.replace(/\.html$/, `-${k++}.html`);
        used.add(candidate);
        return { page: p, file: candidate };
      });

      const nav = resolved
        .map((r) => `<a href="./${r.file}">${esc(r.page.title)}</a>`)
        .join('');

      const files: string[] = [];
      let total = 0;
      const css = `${BASE_CSS}
header.nav { background:var(--soft); border-bottom:1px solid var(--border); padding:14px 24px; display:flex; gap:18px; flex-wrap:wrap; }
header.nav a { font-weight:600; text-decoration:none; }
main { max-width:880px; margin:0 auto; padding:40px 24px; }
footer { text-align:center; color:var(--muted); padding:32px; font-size:.9rem; }`;
      total += Buffer.byteLength(css, 'utf8');
      await writeFile(join(siteDir, 'styles.css'), css, 'utf8');
      files.push(`${DELIVERABLES_DIR}/${siteSlug}/styles.css`);

      for (const r of resolved) {
        const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.page.title)} — ${esc(name)}</title><link rel="stylesheet" href="./styles.css"></head>
<body>
<header class="nav">${nav}</header>
<main><h1>${esc(r.page.title)}</h1>${renderSectionsHtml(r.page.sections)}</main>
<footer>${esc(name)}</footer>
</body></html>`;
        total += Buffer.byteLength(page, 'utf8');
        if (total > maxBytes) throw new Error(`website exceeds the ${maxBytes}-byte limit`);
        await writeFile(join(siteDir, r.file), page, 'utf8');
        files.push(`${DELIVERABLES_DIR}/${siteSlug}/${r.file}`);
      }

      return { indexPath: `${DELIVERABLES_DIR}/${siteSlug}/index.html`, files };
    },
  };

  return [generateSlides, generateDocument, generateChart, generateSpreadsheet, generateWebsite];
}
