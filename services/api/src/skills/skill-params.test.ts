import { describe, it, expect } from 'vitest';
import { parseParamDefs, validateSkillInput, renderWithParams } from './skill-params';

describe('skill-params (TICKET-4)', () => {
  it('parseParamDefs sanitizes malformed entries + dedupes + caps', () => {
    const defs = parseParamDefs([
      { name: 'city', type: 'string', required: true },
      { name: 'days', type: 'number' },
      { name: 'city', type: 'string' }, // dup -> dropped
      { name: '1bad', type: 'string' }, // invalid name -> dropped
      { type: 'string' }, // no name -> dropped
      'nonsense',
    ]);
    expect(defs.map((d) => d.name)).toEqual(['city', 'days']);
    expect(defs[0]).toMatchObject({ name: 'city', type: 'string', required: true });
    expect(parseParamDefs('not-array')).toEqual([]);
  });

  it('validateSkillInput enforces required + types and coerces', () => {
    const defs = parseParamDefs([
      { name: 'city', type: 'string', required: true },
      { name: 'days', type: 'number', required: true },
      { name: 'metric', type: 'boolean' },
    ]);
    const bad = validateSkillInput(defs, { days: 'notnum' });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toContain('missing required param: city');
    expect(bad.errors.some((e) => /days.*number/.test(e))).toBe(true);

    const good = validateSkillInput(defs, { city: 'Paris', days: '3', metric: 'true' });
    expect(good.ok).toBe(true);
    expect(good.values).toEqual({ city: 'Paris', days: 3, metric: true });
  });

  it('renderWithParams substitutes {{name}} and leaves unknown placeholders intact', () => {
    const out = renderWithParams('Weather in {{city}} for {{days}} days. {{unknown}}', { city: 'Paris', days: 3 });
    expect(out).toBe('Weather in Paris for 3 days. {{unknown}}');
  });
});
