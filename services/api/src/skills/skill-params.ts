// Skills v2 typed params (TICKET-4) — pure, deterministic validation + rendering. A skill's `params`
// column stores an array of these defs; running the skill validates the caller's values against them
// and substitutes {{name}} placeholders. No external validator (kept dependency-free + testable).

export type SkillParamType = 'string' | 'number' | 'boolean';
export interface SkillParamDef {
  name: string;
  type: SkillParamType;
  required?: boolean;
  description?: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse + sanitize a stored params JSON value into well-formed defs (drops malformed entries). */
export function parseParamDefs(raw: unknown): SkillParamDef[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillParamDef[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const type = o.type === 'number' || o.type === 'boolean' ? o.type : 'string';
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      type,
      required: o.required === true,
      ...(typeof o.description === 'string' ? { description: o.description.slice(0, 500) } : {}),
    });
    if (out.length >= 50) break;
  }
  return out;
}

export interface ParamValidationResult {
  ok: boolean;
  errors: string[];
  values: Record<string, string | number | boolean>;
}

/** Validate caller-provided values against the param defs (required + type), coercing where safe. */
export function validateSkillInput(defs: SkillParamDef[], input: Record<string, unknown>): ParamValidationResult {
  const errors: string[] = [];
  const values: Record<string, string | number | boolean> = {};
  for (const d of defs) {
    const v = input?.[d.name];
    if (v === undefined || v === null || v === '') {
      if (d.required) errors.push(`missing required param: ${d.name}`);
      continue;
    }
    if (d.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isNaN(n)) { errors.push(`param "${d.name}" must be a number`); continue; }
      values[d.name] = n;
    } else if (d.type === 'boolean') {
      if (typeof v === 'boolean') values[d.name] = v;
      else if (v === 'true' || v === 'false') values[d.name] = v === 'true';
      else { errors.push(`param "${d.name}" must be a boolean`); continue; }
    } else {
      values[d.name] = String(v).slice(0, 20_000);
    }
  }
  return { ok: errors.length === 0, errors, values };
}

/** Substitute {{name}} placeholders with the validated values (unknown placeholders left intact). */
export function renderWithParams(template: string, values: Record<string, string | number | boolean>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}
