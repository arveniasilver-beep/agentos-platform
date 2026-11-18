import { describe, it, expect } from 'vitest';
import { PLAYBOOK_TEMPLATES, TEMPLATE_CATEGORIES } from './playbook-templates';
import { extractVariables, substituteVariables } from './playbook-vars';

describe('marketplace playbook templates', () => {
  it('has unique ids and known categories', () => {
    const ids = PLAYBOOK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PLAYBOOK_TEMPLATES) {
      expect(TEMPLATE_CATEGORIES).toContain(t.category);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(0);
    }
  });

  it('every template prompt has well-formed, fillable variables', () => {
    for (const t of PLAYBOOK_TEMPLATES) {
      const vars = extractVariables(t.prompt);
      // Templates are meant to be parameterized, so each should expose at least one variable.
      expect(vars.length).toBeGreaterThan(0);
      // Filling them leaves no {{...}} placeholders behind.
      const filled = substituteVariables(t.prompt, Object.fromEntries(vars.map((v) => [v, 'X'])));
      expect(filled).not.toMatch(/\{\{|\}\}/);
    }
  });
});
