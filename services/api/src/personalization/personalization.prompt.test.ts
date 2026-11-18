import { describe, it, expect } from 'vitest';
import { composePersonalizationPreamble } from './personalization.prompt';

describe('composePersonalizationPreamble', () => {
  it('returns undefined when nothing is set', () => {
    expect(composePersonalizationPreamble({})).toBeUndefined();
    expect(
      composePersonalizationPreamble({ nickname: '  ', about: '', instructions: '', memories: [] }),
    ).toBeUndefined();
  });

  it('includes only the populated sections', () => {
    const out = composePersonalizationPreamble({ nickname: 'Sal', profession: 'Founder' });
    expect(out).toContain('About the user');
    expect(out).toContain('Sal');
    expect(out).toContain('Founder');
    expect(out).not.toContain('custom instructions');
    expect(out).not.toContain('Facts to remember');
  });

  it('renders custom instructions and memory facts', () => {
    const out = composePersonalizationPreamble({
      instructions: 'Always answer in Turkish.',
      memories: ['Prefers concise answers', '  ', 'Uses Postgres'],
    });
    expect(out).toContain('custom instructions');
    expect(out).toContain('Always answer in Turkish.');
    expect(out).toContain('- Prefers concise answers');
    expect(out).toContain('- Uses Postgres');
    // Blank memory entries are dropped.
    expect(out).not.toContain('- \n');
  });

  it('begins with the persistent-context framing', () => {
    const out = composePersonalizationPreamble({ about: 'A solo developer' });
    expect(out?.startsWith('Persistent context about the user')).toBe(true);
  });
});
