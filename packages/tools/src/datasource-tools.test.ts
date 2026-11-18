import { describe, it, expect } from 'vitest';
import { createDataSourceTools, type DataSourceFetch } from './index';

const META = { page: 1, pages: 1, per_page: 200, total: 2 };

function fetchOk(rows: unknown[]): { calls: string[]; fetchImpl: DataSourceFetch } {
  const calls: string[] = [];
  const fetchImpl: DataSourceFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [META, rows], text: async () => '' };
  };
  return { calls, fetchImpl };
}

describe('world_bank data source', () => {
  it('builds the right URL and returns sorted yearly points', async () => {
    const { calls, fetchImpl } = fetchOk([
      { indicator: { value: 'GDP (current US$)' }, country: { value: 'Türkiye' }, date: '2021', value: 819000000000 },
      { indicator: { value: 'GDP (current US$)' }, country: { value: 'Türkiye' }, date: '2020', value: 720000000000 },
      { date: '2019', value: null },
    ]);
    const tool = createDataSourceTools({ fetchImpl })[0]!;
    const r = (await tool.run({ country: 'TR', indicator: 'NY.GDP.MKTP.CD', fromYear: 2019, toYear: 2021 })) as {
      indicator: string;
      country: string;
      points: { year: string; value: number | null }[];
    };
    expect(calls[0]).toBe(
      'https://api.worldbank.org/v2/country/TR/indicator/NY.GDP.MKTP.CD?format=json&per_page=1000&date=2019:2021',
    );
    expect(r.indicator).toBe('GDP (current US$)');
    expect(r.country).toBe('Türkiye');
    expect(r.points.map((p) => p.year)).toEqual(['2019', '2020', '2021']); // sorted ascending
    expect(r.points[2]).toEqual({ year: '2021', value: 819000000000 });
    expect(r.points[0]).toEqual({ year: '2019', value: null });
  });

  it('throws a clear error when the API returns no data array', async () => {
    const fetchImpl: DataSourceFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ message: [{ value: 'Invalid value' }] }],
      text: async () => '',
    });
    const tool = createDataSourceTools({ fetchImpl })[0]!;
    await expect(tool.run({ country: 'XX', indicator: 'BAD' })).rejects.toThrow(/no data/i);
  });

  it('throws on a non-ok HTTP status', async () => {
    const fetchImpl: DataSourceFetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'down' });
    const tool = createDataSourceTools({ fetchImpl })[0]!;
    await expect(tool.run({ country: 'TR', indicator: 'SP.POP.TOTL' })).rejects.toThrow(/failed \(503\)/);
  });
});

describe('fx_rates data source', () => {
  const fx = (fetchImpl: DataSourceFetch) =>
    createDataSourceTools({ fetchImpl }).find((t) => t.definition.id === 'fx_rates')!;

  it('builds the right URL and returns base/date/rates', async () => {
    let url = '';
    const tool = fx(async (u) => {
      url = u;
      return {
        ok: true,
        status: 200,
        json: async () => ({ amount: 1, base: 'USD', date: '2026-06-19', rates: { EUR: 0.92, TRY: 32.5 } }),
        text: async () => '',
      };
    });
    const r = (await tool.run({ from: 'usd', to: ['eur', 'try'] })) as { base: string; date: string; rates: Record<string, number> };
    expect(url).toBe('https://api.frankfurter.app/latest?from=USD&to=EUR,TRY');
    expect(r).toEqual({ base: 'USD', date: '2026-06-19', rates: { EUR: 0.92, TRY: 32.5 } });
  });

  it('uses a historical date path when given', async () => {
    let url = '';
    const tool = fx(async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ base: 'EUR', date: '2020-01-02', rates: { USD: 1.12 } }), text: async () => '' };
    });
    await tool.run({ from: 'EUR', to: ['USD'], date: '2020-01-02' });
    expect(url).toBe('https://api.frankfurter.app/2020-01-02?from=EUR&to=USD');
  });

  it('rejects non-ISO currency codes before fetching', async () => {
    let called = false;
    const tool = fx(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    await expect(tool.run({ from: 'US', to: ['EUR'] })).rejects.toThrow(/3-letter ISO/);
    expect(called).toBe(false);
  });
});
