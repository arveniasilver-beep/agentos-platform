/**
 * Parameterized playbooks: a prompt template may contain {{variable}} placeholders. Before running,
 * the user fills each one and we substitute the values in. Pure string helpers (easy to unit-test).
 */

// A placeholder is {{ name }} where name is letters/digits/space/underscore/hyphen.
const VAR_RE = /\{\{\s*([a-zA-Z0-9_ -]+?)\s*\}\}/g;

/** Unique variable names in first-seen order. */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1]!.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Replace every {{name}} with its value (missing/blank → empty string). */
export function substituteVariables(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (_full, rawName: string) => {
    const v = values[rawName.trim()];
    return v == null ? '' : v;
  });
}
