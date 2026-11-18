import { describe, it, expect } from 'vitest';
import { generateUnifiedDiff, applyUnifiedDiff, countDiffLines } from './diff';

describe('unified diff', () => {
  it('round-trips: applying a generated diff reproduces the new text', () => {
    const oldText = 'line1\nline2\nline3\nline4\n';
    const newText = 'line1\nline2 changed\nline3\nline4\nline5\n';
    const patch = generateUnifiedDiff(oldText, newText, 'f.txt');
    expect(patch).toContain('@@');
    expect(applyUnifiedDiff(oldText, patch)).toBe(newText);
  });

  it('handles pure insertion and pure deletion', () => {
    const a = 'a\nb\nc\n';
    expect(applyUnifiedDiff(a, generateUnifiedDiff(a, 'a\nb\nc\nd\n'))).toBe('a\nb\nc\nd\n');
    expect(applyUnifiedDiff(a, generateUnifiedDiff(a, 'a\nc\n'))).toBe('a\nc\n');
  });

  it('returns empty diff for identical text', () => {
    expect(generateUnifiedDiff('same\n', 'same\n')).toBe('');
  });

  it('counts changed (+/-) lines, ignoring headers', () => {
    const patch = generateUnifiedDiff('x\ny\n', 'x\nY\nz\n');
    expect(countDiffLines(patch)).toBeGreaterThanOrEqual(2);
  });

  it('STRICTLY rejects a patch whose context does not match the source', () => {
    const patch = generateUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    // Apply against a different source — context "a/b/c" won't match "x/y/z".
    expect(() => applyUnifiedDiff('x\ny\nz\n', patch)).toThrow(/mismatch/i);
  });

  it('rejects a patch with no hunks', () => {
    expect(() => applyUnifiedDiff('a\n', '--- a/f\n+++ b/f\n')).toThrow(/no hunks/i);
  });
});
