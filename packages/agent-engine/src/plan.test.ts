import { describe, it, expect } from 'vitest';
import { parsePlanSteps } from './plan';

describe('parsePlanSteps', () => {
  it('parses numbered lists (both 1. and 1) forms)', () => {
    const steps = parsePlanSteps('Plan:\n1. First\n2. Second\n3) Third', 't');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.title).toBe('First');
    expect(steps[2]?.title).toBe('Third');
    expect(steps[0]?.id).toBe('t-s0');
  });

  it('parses bullet lists', () => {
    const steps = parsePlanSteps('- a\n* b\n• c', 't');
    expect(steps.map((s) => s.title)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to a single step when there is no list', () => {
    const steps = parsePlanSteps('just some prose with no list', 't');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.title).toBe('Complete the task');
  });
});
