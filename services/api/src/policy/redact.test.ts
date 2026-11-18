import { describe, it, expect } from 'vitest';
import { redactText, redactDeep } from './redact';

describe('redactDeep (durable trace at rest — Ticket-07)', () => {
  it('scrubs secrets from nested objects/arrays while preserving shape, type, and non-secret fields', () => {
    const SECRET = 'sk-ant-SUPERSECRETKEY1234567890';
    const event = {
      type: 'tool_result',
      seq: 7,
      callId: 'task-abc-c3',
      ok: true,
      tool: 'http_get',
      input: { url: 'https://api.example.com?api_key=' + SECRET, headers: { Authorization: 'Bearer ' + SECRET } },
      output: ['line1', 'OPENAI_API_KEY=' + SECRET, { token: SECRET }],
    };
    const safe = redactDeep(event);
    const dump = JSON.stringify(safe);
    expect(dump).not.toContain(SECRET); // every credential channel scrubbed
    // structure + non-secret fields intact (replay/cursors must keep working)
    expect(safe.seq).toBe(7);
    expect(safe.type).toBe('tool_result');
    expect(safe.callId).toBe('task-abc-c3'); // ids untouched
    expect(safe.ok).toBe(true);
    expect(safe.tool).toBe('http_get');
    expect(Array.isArray(safe.output)).toBe(true);
    expect(safe.output[0]).toBe('line1'); // benign content preserved
    expect(event.output[1]).toContain(SECRET); // input is NOT mutated (pure)
  });
});

describe('redactText', () => {
  it('masks Bearer tokens and Authorization headers', () => {
    expect(redactText('curl -H "Authorization: Bearer sk-ant-abcdef123456789" https://x')).not.toContain('sk-ant-abcdef123456789');
    expect(redactText('Authorization: Bearer abcdefgh12345678')).toContain('[REDACTED]');
  });
  it('masks provider key shapes', () => {
    expect(redactText('key=sk-ant-0123456789abcdef')).not.toContain('sk-ant-0123456789abcdef');
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
    expect(redactText('ghp_0123456789abcdef0123456789abcdef0123')).toContain('[REDACTED]');
  });
  it('masks secret-looking assignments / env vars', () => {
    const out = redactText('OPENAI_API_KEY=supersecretvalue123 && echo done') ?? '';
    expect(out).not.toContain('supersecretvalue123');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('echo done'); // non-secret part preserved
  });
  it('masks query-string secrets', () => {
    const out = redactText('https://api.example.com/x?token=abcd1234secret&q=hello') ?? '';
    expect(out).not.toContain('abcd1234secret');
    expect(out).toContain('q=hello');
  });
  it('masks PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    expect(redactText(pem)).toBe('[REDACTED PRIVATE KEY]');
  });
  it('caps size and omits binary content', () => {
    const big = 'a'.repeat(5000);
    expect((redactText(big) ?? '').length).toBeLessThan(4100);
    const binary = 'abc' + String.fromCharCode(0) + 'def';
    expect(redactText(binary)).toBe('[binary content omitted]');
  });
  it('passes through undefined and preserves benign text', () => {
    expect(redactText(undefined)).toBeUndefined();
    expect(redactText('rm -rf build/')).toBe('rm -rf build/');
  });
});
