import { describe, it, expect } from 'vitest';
import { extractVariables, substituteVariables } from './playbook-vars';

describe('playbook variables', () => {
  it('extracts unique variable names in first-seen order, trimmed', () => {
    expect(extractVariables('Research {{topic}} for {{ audience }}, then {{topic}} again')).toEqual([
      'topic',
      'audience',
    ]);
  });

  it('returns no variables for a plain prompt', () => {
    expect(extractVariables('Summarize the latest news')).toEqual([]);
  });

  it('substitutes every occurrence and leaves missing values empty', () => {
    expect(substituteVariables('Hi {{name}}, about {{name}} and {{topic}}', { name: 'Sal', topic: 'AI' })).toBe(
      'Hi Sal, about Sal and AI',
    );
    expect(substituteVariables('value: {{missing}}.', {})).toBe('value: .');
  });

  it('matches placeholders regardless of inner whitespace', () => {
    expect(substituteVariables('{{ a }}-{{b}}', { a: '1', b: '2' })).toBe('1-2');
  });
});
