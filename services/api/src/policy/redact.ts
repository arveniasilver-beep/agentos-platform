/**
 * Secret redaction for approval-detail payloads (TICKET-POLICY). Approval detail can include a shell
 * command, URL, file path, diff, or form target — none of which may leak credentials to the UI/logs.
 * Pure + deterministic. Conservative: prefers over-masking to leaking. Also caps size and refuses
 * to render binary content.
 */

const MAX_DETAIL_CHARS = 4000;
const PLACEHOLDER = '[REDACTED]';

// Ordered, specific-first. Each replaces the secret portion with PLACEHOLDER.
const PATTERNS: { re: RegExp; replace: string }[] = [
  // PEM private keys (whole block).
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: '[REDACTED PRIVATE KEY]' },
  // Authorization / cookie headers (header: value).
  { re: /\b(authorization|proxy-authorization|cookie|set-cookie)\b(\s*[:=]\s*)\S.*$/gim, replace: `$1$2${PLACEHOLDER}` },
  // Bearer tokens.
  { re: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/gi, replace: `Bearer ${PLACEHOLDER}` },
  // Provider key shapes: Anthropic, OpenAI, AWS, Slack, GitHub, Google.
  { re: /\bsk-ant-[A-Za-z0-9._-]{8,}/g, replace: PLACEHOLDER },
  { re: /\bsk-[A-Za-z0-9]{16,}/g, replace: PLACEHOLDER },
  { re: /\bAKIA[0-9A-Z]{12,}/g, replace: PLACEHOLDER },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, replace: PLACEHOLDER },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: PLACEHOLDER },
  { re: /\bAIza[0-9A-Za-z._-]{20,}/g, replace: PLACEHOLDER },
  // Secret-looking assignments: NAME=value / "secret": "value" / api-key: value.
  {
    re: /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|APIKEY|API_KEY|ACCESS[_-]?KEY|PRIVATE)[A-Za-z0-9_.-]*)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi,
    replace: `$1$2${PLACEHOLDER}`,
  },
  // Query-string secrets: ?token=... &api_key=...
  { re: /([?&](?:token|api_?key|access_?token|secret|password|sig|signature)=)[^&\s]+/gi, replace: `$1${PLACEHOLDER}` },
];

/** True if the string looks like binary / non-printable content: a NUL byte, or a high ratio of
 * control characters. Newlines/tabs/CR are NOT counted, so normal text and shell commands pass. */
function looksBinary(s: string): boolean {
  let ctrl = 0;
  const n = Math.min(s.length, 1000);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true; // NUL => binary
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.15;
}

/** Redact secrets from a single free-text field; cap size; never render binary. Returns undefined for
 * undefined input so optional fields stay optional. */
export function redactText(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (looksBinary(input)) return '[binary content omitted]';
  let out = input.length > MAX_DETAIL_CHARS ? input.slice(0, MAX_DETAIL_CHARS) + ' …[truncated]' : input;
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Apply ONLY the secret patterns to a string — no size cap, no binary handling. For redacting structured
 * values at rest (event payloads, tool args) where we must preserve shape + size, only stripping the
 * credentials. */
function redactStringSecrets(s: string): string {
  let out = s;
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  return out;
}

/**
 * Deep-redact secrets from any JSON-serializable value (object/array/string), preserving structure + type
 * so a redacted copy is a drop-in replacement. Used to scrub the DURABLE TRACE at rest — the TaskLog event
 * payload + the ToolCall args + the live UI stream — so a credential that flows through a tool call/result
 * is never persisted or shown raw. Pure: returns a new value; the input is untouched.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactStringSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}
