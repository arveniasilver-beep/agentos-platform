import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * Built-in data sources (Manus "Veri kaynakları"): tools that pull from a fixed, public, keyless data
 * provider so the agent can ground answers in real figures. World Bank's Open Data API is free and
 * needs no auth; the host is fixed (no SSRF surface). The fetch is injectable for tests.
 */

export interface DataSourceFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type DataSourceFetch = (url: string) => Promise<DataSourceFetchResponse>;

const WB_BASE = 'https://api.worldbank.org/v2';
const FX_BASE = 'https://api.frankfurter.app';
const CURRENCY = /^[A-Za-z]{3}$/;

interface WorldBankRow {
  indicator?: { id?: string; value?: string };
  country?: { id?: string; value?: string };
  countryiso3code?: string;
  date?: string;
  value?: number | null;
}

export function createDataSourceTools(opts?: { fetchImpl?: DataSourceFetch }): RuntimeTool[] {
  const doFetch: DataSourceFetch = opts?.fetchImpl ?? ((url) => globalThis.fetch(url) as unknown as Promise<DataSourceFetchResponse>);

  const worldBank: RuntimeTool = {
    definition: defineTool({
      id: 'world_bank',
      name: 'world_bank',
      description:
        'Look up real economic & development statistics from the World Bank Open Data (free, no key). ' +
        'Give a country (ISO-2 code like TR, US, DE, or "all") and an indicator CODE — e.g. ' +
        'NY.GDP.MKTP.CD (GDP USD), SP.POP.TOTL (population), FP.CPI.TOTL.ZG (inflation %), ' +
        'SL.UEM.TOTL.ZS (unemployment %), NY.GDP.PCAP.CD (GDP per capita). Returns yearly data points. ' +
        'Use this instead of guessing macroeconomic figures.',
      inputSchema: z.object({
        country: z.string().min(1).max(40),
        indicator: z.string().min(1).max(40),
        fromYear: z.number().int().min(1960).max(2100).optional(),
        toYear: z.number().int().min(1960).max(2100).optional(),
      }),
      outputSchema: z.object({
        indicator: z.string(),
        country: z.string(),
        points: z.array(z.object({ year: z.string(), value: z.number().nullable() })),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: async (input) => {
      const { country, indicator, fromYear, toYear } = input as {
        country: string;
        indicator: string;
        fromYear?: number;
        toYear?: number;
      };
      // Only safe path/query characters reach the fixed World Bank host.
      const c = encodeURIComponent(country.trim());
      const ind = encodeURIComponent(indicator.trim());
      const date = fromYear && toYear ? `&date=${fromYear}:${toYear}` : '';
      // 'all' returns ~260 countries × years, so use a large page to avoid silent truncation; a single
      // country needs far fewer. (World Bank accepts very large per_page.)
      const perPage = country.trim().toLowerCase() === 'all' ? 15000 : 1000;
      const url = `${WB_BASE}/country/${c}/indicator/${ind}?format=json&per_page=${perPage}${date}`;
      const res = await doFetch(url);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`World Bank request failed (${res.status}): ${t.slice(0, 200)}`);
      }
      const body = (await res.json()) as unknown;
      // World Bank returns [meta, rows] — or [meta] with a message when the query is invalid.
      if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) {
        throw new Error('World Bank returned no data for that country/indicator (check the codes).');
      }
      const rows = body[1] as WorldBankRow[];
      const points = rows
        .map((r) => ({ year: r.date ?? '', value: typeof r.value === 'number' ? r.value : null }))
        .filter((p) => p.year !== '')
        .sort((a, b) => a.year.localeCompare(b.year));
      const label = rows.find((r) => r.indicator?.value)?.indicator?.value ?? indicator;
      const countryName = rows.find((r) => r.country?.value)?.country?.value ?? country;
      return { indicator: label, country: countryName, points };
    },
  };

  const fxRates: RuntimeTool = {
    definition: defineTool({
      id: 'fx_rates',
      name: 'fx_rates',
      description:
        'Look up real currency exchange rates from the European Central Bank via Frankfurter (free, no ' +
        'key). Give a base currency (ISO-4217 like USD, EUR, TRY) and target currencies. Optionally a ' +
        'date (YYYY-MM-DD) for a historical rate, else the latest. Use this instead of guessing FX rates.',
      inputSchema: z.object({
        from: z.string().length(3),
        to: z.array(z.string().length(3)).min(1).max(30),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      outputSchema: z.object({
        base: z.string(),
        date: z.string(),
        rates: z.record(z.number()),
      }),
      riskLevel: 'low',
      permissions: ['net.request'],
      timeoutMs: 30_000,
    }),
    run: async (input) => {
      const { from, to, date } = input as { from: string; to: string[]; date?: string };
      // Validate currency codes so only safe tokens reach the fixed host.
      if (!CURRENCY.test(from) || !to.every((c) => CURRENCY.test(c))) {
        throw new Error('currencies must be 3-letter ISO codes (e.g. USD, EUR, TRY)');
      }
      const path = date ?? 'latest';
      const url = `${FX_BASE}/${path}?from=${from.toUpperCase()}&to=${to.map((c) => c.toUpperCase()).join(',')}`;
      const res = await doFetch(url);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`FX request failed (${res.status}): ${t.slice(0, 200)}`);
      }
      const body = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
      if (!body.rates || typeof body.rates !== 'object') {
        throw new Error('FX provider returned no rates (check the currency codes).');
      }
      return { base: body.base ?? from.toUpperCase(), date: body.date ?? path, rates: body.rates };
    },
  };

  return [worldBank, fxRates];
}
