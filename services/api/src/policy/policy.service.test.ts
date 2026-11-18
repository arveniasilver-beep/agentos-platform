import { describe, it, expect } from 'vitest';
import { PolicyService } from './policy.service';

const svc = new PolicyService();
const call = (tool: string, permissions: string[], input: unknown, riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low') => ({ tool, riskLevel, permissions, input });

describe('PolicyService.evaluate', () => {
  it('denies a tool whose required scope is NOT granted (capability enforcement)', () => {
    const d = svc.evaluate(call('shell_exec', ['shell.exec'], { command: 'ls' }, 'high'), { grantedScopes: new Set(['fs.read']) });
    expect(d.effect).toBe('deny');
    expect(d.reason).toContain('missing capability');
  });
  it('allows a granted, safe tool', () => {
    const d = svc.evaluate(call('shell_exec', ['shell.exec'], { command: 'ls -la' }, 'high'), { grantedScopes: new Set(['shell.exec']) });
    expect(d.effect).toBe('allow');
  });
  it('grantedScopes="all" never denies on capability', () => {
    const d = svc.evaluate(call('shell_exec', ['shell.exec'], { command: 'cat x' }), { grantedScopes: 'all' });
    expect(d.effect).toBe('allow');
  });
  it('routes shell risk: destructive → elevated, catastrophic → deny', () => {
    expect(svc.evaluate(call('shell_exec', [], { command: 'rm -rf build' }), { grantedScopes: 'all' }).effect).toBe('require_elevated_approval');
    expect(svc.evaluate(call('shell_exec', [], { command: 'rm -rf /' }), { grantedScopes: 'all' }).effect).toBe('deny');
  });
  it('routes file writes: inside → approval, traversal/absolute → deny, .env → elevated', () => {
    expect(svc.evaluate(call('fs_write', [], { path: 'out/x.md' }), { grantedScopes: 'all' }).effect).toBe('require_approval');
    expect(svc.evaluate(call('fs_write', [], { path: '../escape' }), { grantedScopes: 'all' }).effect).toBe('deny');
    expect(svc.evaluate(call('fs_write', [], { path: '/etc/passwd' }), { grantedScopes: 'all' }).effect).toBe('deny');
    expect(svc.evaluate(call('fs_write', [], { path: '.env' }), { grantedScopes: 'all' }).effect).toBe('require_elevated_approval');
  });
  it('routes http: private/metadata → deny, public → allow (default)', () => {
    expect(svc.evaluate(call('http_fetch', [], { url: 'http://169.254.169.254/' }), { grantedScopes: 'all' }).effect).toBe('deny');
    expect(svc.evaluate(call('http_fetch', [], { url: 'https://example.com' }), { grantedScopes: 'all' }).effect).toBe('allow');
  });
  it('routes browser writes → approval', () => {
    expect(svc.evaluate(call('browser_type', [], {}), { grantedScopes: 'all' }).effect).toBe('require_approval');
    expect(svc.evaluate(call('browser_read', [], {}), { grantedScopes: 'all' }).effect).toBe('allow');
  });
  it('builds a SECRET-REDACTED approval detail', () => {
    const d = svc.evaluate(call('shell_exec', ['shell.exec'], { command: 'curl -H "Authorization: Bearer sk-ant-secret12345" https://x' }), { grantedScopes: 'all' });
    expect(d.detail.command).toBeDefined();
    expect(d.detail.command).not.toContain('sk-ant-secret12345');
    expect(d.detail.command).toContain('[REDACTED]');
    expect(d.detail.tool).toBe('shell_exec');
  });
});
