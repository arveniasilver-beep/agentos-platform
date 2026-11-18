import type { PolicyEffect } from '@agentos/protocol';

/**
 * Pure risk classifiers (TICKET-POLICY). Each maps an operation to a PolicyEffect + a human reason.
 * Heuristic + deterministic; deny-by-default for clearly catastrophic patterns, approval for the
 * unclassified-but-risky middle, allow only for clearly safe/read-only operations. No I/O, no config.
 */

export interface Classification {
  effect: PolicyEffect;
  riskReason: string;
}

// --- shell -------------------------------------------------------------------------------------

// Catastrophic / irreversible host damage → deny outright.
const SHELL_CATASTROPHIC: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)\s*$/i, // rm -rf / , ~ , *
  /\brm\s+-[a-z]*r[a-z]*f\b.*\s(\/|~)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/(sd|nvme|hd)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
];
// Destructive but scoped/recoverable → elevated approval.
const SHELL_DESTRUCTIVE: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\brmdir\b.*\/s/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\btruncate\s+-s\s*0\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i,
];
// State-mutating / network / install → approval.
const SHELL_MUTATING: RegExp[] = [
  /\bsudo\b/i,
  /\b(curl|wget)\b/i,
  /\b(apt|apt-get|yum|dnf|brew|npm|pnpm|yarn|pip|pip3|gem|cargo)\s+(install|add|i)\b/i,
  /\b(kill|pkill|killall)\b/i,
  /\b(mv|cp)\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  />>?/, // output redirection writes a file
  /\b(systemctl|service)\b/i,
  /\bdocker\s+(run|rm|exec|build)\b/i,
];
// Clearly read-only / safe.
const SHELL_SAFE: RegExp[] = [
  /^\s*(ls|cat|head|tail|grep|rg|wc|echo|pwd|whoami|date|env|printenv|which|find|stat|file|du|df|tree|sort|uniq|cut|awk|sed\s+-n)\b/i,
  /^\s*(node|python3?|deno)\s+--version\b/i,
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck|build))\b/i,
  /^\s*(vitest|jest|pytest|tsc|eslint|prettier)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|rev-parse)\b/i,
];

export function classifyShell(command: string): Classification {
  const cmd = (command ?? '').trim();
  if (!cmd) return { effect: 'require_approval', riskReason: 'empty/unparseable shell command' };
  if (SHELL_CATASTROPHIC.some((re) => re.test(cmd))) return { effect: 'deny', riskReason: 'catastrophic/irreversible shell command' };
  if (SHELL_DESTRUCTIVE.some((re) => re.test(cmd))) return { effect: 'require_elevated_approval', riskReason: 'destructive shell command' };
  if (SHELL_MUTATING.some((re) => re.test(cmd))) return { effect: 'require_approval', riskReason: 'state-mutating/network shell command' };
  if (SHELL_SAFE.some((re) => re.test(cmd))) return { effect: 'allow', riskReason: 'read-only shell command' };
  return { effect: 'require_approval', riskReason: 'unclassified shell command (default to approval)' };
}

// --- file paths --------------------------------------------------------------------------------

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;
const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/]{1,2}|~)/;
const PROTECTED = [
  /(^|[\\/])\.env(\.[^\\/]+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])(id_rsa|id_ed25519|id_dsa|id_ecdsa)(\.pub)?$/i,
  /(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)/i,
  /(^|[\\/])(credentials|\.npmrc|\.netrc|\.git-credentials|secrets?\.(json|ya?ml|txt))$/i,
];

export function classifyFilePath(
  rawPath: string,
  action: 'write' | 'delete',
  sandboxConfined: boolean,
): Classification {
  const p = (rawPath ?? '').trim();
  if (!p) return { effect: 'deny', riskReason: 'empty file path' };
  if (TRAVERSAL.test(p)) return { effect: 'deny', riskReason: 'path traversal (..) is not allowed' };
  if (sandboxConfined && ABSOLUTE.test(p)) return { effect: 'deny', riskReason: 'absolute path escapes the task workspace' };
  if (PROTECTED.some((re) => re.test(p))) return { effect: 'require_elevated_approval', riskReason: 'protected/secret file' };
  if (!sandboxConfined && ABSOLUTE.test(p)) {
    // My-Computer host path (already confined to approved folders at execution) — still elevated.
    return { effect: action === 'delete' ? 'require_elevated_approval' : 'require_approval', riskReason: `host-folder file ${action}` };
  }
  if (action === 'delete') return { effect: 'require_elevated_approval', riskReason: 'file delete/overwrite' };
  return { effect: 'require_approval', riskReason: 'workspace file write' };
}

// --- coding workspace edits (TICKET-CODING) ----------------------------------------------------

// Supply-chain / irreversible code files → elevated approval.
const CODE_ELEVATED = [
  /(^|[\\/])(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/i,
  /(^|[\\/])(migrations?)[\\/].+/i,
  /(^|[\\/])prisma[\\/]schema\.prisma$/i,
];
// Dependency / deploy / CI config → approval.
const CODE_APPROVAL = [
  /(^|[\\/])package\.json$/i,
  /(^|[\\/])(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i,
  /\.(tf|tfvars)$/i,
  /(^|[\\/])(k8s|kubernetes|deploy|deployment|helm)[\\/].+\.ya?ml$/i,
  /(^|[\\/])\.github[\\/]workflows[\\/].+/i,
  /(^|[\\/])(vercel|netlify|fly|render|railway)\.(json|toml|ya?ml)$/i,
];

/**
 * Classify a coding-workspace file edit. Unlike classifyFilePath (which gates EVERY workspace write to
 * approval), normal code edits are ALLOWED by default — the coding workspace is the intended editable
 * area and is flag-gated + checkpointed. Risk is reserved for: escape (deny), secrets (elevated),
 * supply-chain/deploy/migration files (approval/elevated), deletes, and large diffs.
 */
export function classifyCodingEdit(
  rawPath: string,
  action: 'write' | 'delete',
  changedLines: number,
  maxDiffLines: number,
): Classification {
  const p = (rawPath ?? '').trim();
  if (!p) return { effect: 'deny', riskReason: 'empty file path' };
  if (TRAVERSAL.test(p)) return { effect: 'deny', riskReason: 'path traversal (..) is not allowed' };
  if (ABSOLUTE.test(p)) return { effect: 'deny', riskReason: 'absolute path escapes the coding workspace' };
  if (PROTECTED.some((re) => re.test(p))) return { effect: 'require_elevated_approval', riskReason: 'protected/secret file (.env / key / credential)' };
  if (CODE_ELEVATED.some((re) => re.test(p))) return { effect: 'require_elevated_approval', riskReason: 'lockfile / migration / schema change' };
  if (CODE_APPROVAL.some((re) => re.test(p))) return { effect: 'require_approval', riskReason: 'dependency / deploy / CI config change' };
  if (action === 'delete') return { effect: 'require_approval', riskReason: 'file delete/rename' };
  if (changedLines > maxDiffLines) return { effect: 'require_approval', riskReason: `large diff (${changedLines} > ${maxDiffLines} lines)` };
  return { effect: 'allow', riskReason: 'normal code edit' };
}

// Production deploy commands the agent must never run unattended → deny (composed with classifyShell).
const DEPLOY_DENY = [
  /\bkubectl\s+(apply|delete|rollout|set|scale)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\b(vercel|netlify|fly|wrangler|serverless|sls|heroku|gcloud|aws|az)\b.*\b(deploy|--prod|--production)\b/i,
  /\bnpm\s+publish\b/i,
];
export function classifyDeploy(command: string): Classification {
  const cmd = (command ?? '').trim();
  if (DEPLOY_DENY.some((re) => re.test(cmd))) return { effect: 'deny', riskReason: 'production deploy / publish is not permitted' };
  return { effect: 'allow', riskReason: 'no deploy pattern' };
}

// --- urls / network ----------------------------------------------------------------------------

function stripBrackets(h: string): string {
  return h.replace(/^\[/, '').replace(/\]$/, '');
}
export function isBlockedHost(host: string): boolean {
  const h = stripBrackets((host ?? '').toLowerCase());
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this / private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    return false; // other IPv4 = public
  }
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 link-local/ULA
  return false;
}
export function isInternalHostname(host: string): boolean {
  const h = (host ?? '').toLowerCase();
  if (!h) return true;
  if (!h.includes('.')) return true; // bare hostname (no TLD) = internal
  return /\.(local|internal|lan|home|intranet|corp)$/.test(h);
}

export function classifyUrl(url: string, publicEffect: PolicyEffect): Classification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { effect: 'deny', riskReason: 'unparseable URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { effect: 'deny', riskReason: `disallowed URL scheme: ${parsed.protocol}` };
  }
  if (isBlockedHost(parsed.hostname)) return { effect: 'deny', riskReason: 'private/loopback/link-local/metadata host (SSRF)' };
  if (isInternalHostname(parsed.hostname)) return { effect: 'require_approval', riskReason: 'internal/non-public hostname' };
  return { effect: publicEffect, riskReason: 'public URL' };
}

// --- browser -----------------------------------------------------------------------------------

const BROWSER_WRITE = new Set(['navigate', 'click', 'type', 'upload', 'download', 'submit', 'browser_input']);
// Payment/account-sensitive contexts that warrant elevated approval for a mutation (TICKET-1).
const PAYMENT_ACCOUNT_RE =
  /\b(checkout|payment|billing|invoice|purchase|card|paypal|stripe|bank|iban|password|passwd|account|login|sign[\s-]?in|credential|transfer|wire|withdraw|2fa|otp)\b/i;

export interface BrowserClassifyCtx {
  url?: string | undefined;
  target?: string | undefined;
  submit?: boolean | undefined;
  /** When true (BROWSER_OPERATOR_ENABLED), enable payment/account escalation. Passed by the caller so
   * this module stays env-free; flag-off => byte-identical to the legacy classification. */
  hardened?: boolean | undefined;
}

export function classifyBrowser(action: string, ctx?: BrowserClassifyCtx): Classification {
  const a = (action ?? '').toLowerCase();
  if (a === 'read' || a === 'screenshot' || a === 'browser_read' || a === 'browser_screenshot') {
    return { effect: 'allow', riskReason: 'read-only browser action' };
  }
  if (ctx?.hardened) {
    const hay = `${ctx.url ?? ''} ${ctx.target ?? ''}`;
    const mutating = ctx.submit === true || a === 'type' || a === 'submit' || a === 'upload';
    if (mutating && PAYMENT_ACCOUNT_RE.test(hay)) {
      return { effect: 'require_elevated_approval', riskReason: 'payment/account-sensitive browser mutation' };
    }
  }
  if (BROWSER_WRITE.has(a) || a.includes('upload') || a.includes('download') || a.includes('type') || a.includes('click') || a.includes('navigate')) {
    return { effect: 'require_approval', riskReason: 'browser write/navigation action' };
  }
  return { effect: 'require_approval', riskReason: 'unclassified browser action (default to approval)' };
}
