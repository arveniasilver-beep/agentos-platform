import { Injectable } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import type { ApprovalDetail, PolicyEffect, RiskLevel } from '@agentos/protocol';
import { classifyShell, classifyFilePath, classifyUrl, classifyBrowser, classifyCodingEdit, classifyDeploy } from './classifiers';
import { redactText } from './redact';
import { countDiffLines } from '@agentos/tools';

const SEVERITY: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, require_elevated_approval: 2, deny: 3 };
/** The more restrictive of two classifications (used to compose, e.g., shell risk + deploy deny). */
function mostRestrictive(a: { effect: PolicyEffect; riskReason: string }, b: { effect: PolicyEffect; riskReason: string }) {
  return SEVERITY[a.effect] >= SEVERITY[b.effect] ? a : b;
}

/** A single tool invocation the policy must rule on. */
export interface PolicyCall {
  tool: string;
  riskLevel: RiskLevel;
  permissions: string[];
  input: unknown;
}

/** Per-run policy context. `grantedScopes='all'` means capability enforcement is dormant (every
 * required scope is granted); a Set restricts to exactly those scopes. */
export interface PolicyContext {
  grantedScopes: Set<string> | 'all';
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  detail: ApprovalDetail;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Central policy engine (TICKET-POLICY). Pure decision logic over the pure classifiers; no approval
 * mechanism here (the engine owns that) and NO relaxation of legacy gating (the engine merges this
 * with the legacy gate, taking the more restrictive). Default-deny on missing capability.
 */
@Injectable()
export class PolicyService {
  /** Build the granted-scope set from config: POLICY_GRANTED_SCOPES (csv) or 'all' when unset. */
  grantedScopesFromEnv(): Set<string> | 'all' {
    const raw = loadServerEnv().POLICY_GRANTED_SCOPES;
    if (!raw) return 'all';
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }

  evaluate(call: PolicyCall, ctx: PolicyContext): PolicyDecision {
    const input = asRecord(call.input);
    const publicEffect = loadServerEnv().POLICY_HTTP_PUBLIC_EFFECT as PolicyEffect;

    // 1) Capability enforcement (deny-by-default): every required scope must be granted.
    if (ctx.grantedScopes !== 'all') {
      const missing = call.permissions.filter((p) => !(ctx.grantedScopes as Set<string>).has(p));
      if (missing.length > 0) {
        return this.decide('deny', `missing capability: ${missing.join(', ')}`, call, input);
      }
    }

    // 2) Per-tool risk classification.
    let effect: PolicyEffect = 'allow';
    let reason = 'no specific risk class';
    const maxDiffLines = loadServerEnv().CODING_MAX_DIFF_LINES;
    if (call.tool === 'shell_exec') {
      ({ effect, riskReason: reason } = classifyShell(asStr(input.command) ?? ''));
    } else if (call.tool === 'fs_write') {
      ({ effect, riskReason: reason } = classifyFilePath(asStr(input.path) ?? '', 'write', true));
    } else if (call.tool === 'local_write') {
      ({ effect, riskReason: reason } = classifyFilePath(asStr(input.path) ?? '', 'write', false));
    } else if (call.tool === 'http_fetch') {
      ({ effect, riskReason: reason } = classifyUrl(asStr(input.url) ?? '', publicEffect));
    } else if (call.tool.startsWith('browser_')) {
      ({ effect, riskReason: reason } = classifyBrowser(call.tool.replace(/^browser_/, ''), {
        url: asStr(input.url),
        target: asStr(input.selector) ?? asStr(input.text),
        submit: input.submit === true,
        hardened: loadServerEnv().BROWSER_OPERATOR_ENABLED,
      }));
    } else if (call.tool === 'write_file') {
      const lines = (asStr(input.content) ?? '').split('\n').length;
      ({ effect, riskReason: reason } = classifyCodingEdit(asStr(input.path) ?? '', 'write', lines, maxDiffLines));
    } else if (call.tool === 'apply_patch') {
      const lines = countDiffLines(asStr(input.patch) ?? '');
      ({ effect, riskReason: reason } = classifyCodingEdit(asStr(input.path) ?? '', 'write', lines, maxDiffLines));
    } else if (call.tool === 'run_command') {
      ({ effect, riskReason: reason } = mostRestrictive(classifyShell(asStr(input.command) ?? ''), classifyDeploy(asStr(input.command) ?? '')));
    } else if (call.tool === 'run_tests' || call.tool === 'run_lint' || call.tool === 'run_build') {
      // Allowlisted package-manager scripts run by default; only an explicit custom command is classified.
      const cmd = asStr(input.command);
      ({ effect, riskReason: reason } = cmd ? mostRestrictive(classifyShell(cmd), classifyDeploy(cmd)) : { effect: 'allow', riskReason: 'project test/lint/build script' });
    } else if (call.tool === 'rollback_workspace') {
      effect = 'require_approval';
      reason = 'workspace rollback discards uncommitted changes';
    }

    return this.decide(effect, reason, call, input);
  }

  /** Build the (secret-redacted) decision + approval detail. */
  private decide(effect: PolicyEffect, reason: string, call: PolicyCall, input: Record<string, unknown>): PolicyDecision {
    const detail: ApprovalDetail = {
      tool: call.tool,
      requestedScopes: call.permissions,
      riskReason: reason,
      elevated: effect === 'require_elevated_approval',
    };
    const command = redactText(asStr(input.command));
    if (command !== undefined) detail.command = command;
    const filePath = redactText(asStr(input.path));
    if (filePath !== undefined) {
      detail.filePath = filePath;
      detail.fileAction = call.tool === 'local_write' || call.tool === 'fs_write' ? 'write' : undefined;
    }
    const url = redactText(asStr(input.url));
    if (url !== undefined) detail.url = url;
    // Coding workspace (TICKET-CODING): a redacted, size-capped diff/content preview so a reviewer sees
    // exactly what will change before approving a critical/large edit (patch-first preview).
    const preview = redactText(asStr(input.patch) ?? asStr(input.content));
    if (preview !== undefined) detail.diffPreview = preview;
    const method = asStr(input.method);
    if (call.tool === 'http_fetch') detail.httpMethod = (method ?? 'GET').toUpperCase();
    if (call.tool.startsWith('browser_')) {
      detail.browserAction = call.tool.replace(/^browser_/, '');
      const target = redactText(asStr(input.selector) ?? asStr(input.url) ?? asStr(input.text));
      if (target !== undefined) detail.formTarget = target;
    }
    return { effect, reason, detail };
  }
}
