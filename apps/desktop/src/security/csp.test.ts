import { describe, it, expect } from 'vitest';
import { generateNonce, buildCspHeader, apiConnectSources } from './csp';

describe('generateNonce', () => {
  it('returns a non-empty base64 string', () => {
    const nonce = generateNonce();
    expect(nonce.length).toBeGreaterThan(0);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('returns a different value each call', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe('buildCspHeader', () => {
  it('embeds the nonce and locks down dangerous directives', () => {
    const csp = buildCspHeader('abc123');
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('adds allowed API origins to connect-src', () => {
    const csp = buildCspHeader('n', ['https://api.example.com']);
    expect(csp).toContain("connect-src 'self' https://api.example.com");
  });
});

describe('apiConnectSources', () => {
  it('derives the http + ws origins for a local API', () => {
    expect(apiConnectSources('http://localhost:4000')).toEqual([
      'http://localhost:4000',
      'ws://localhost:4000',
    ]);
  });

  it('derives the https + wss origins and trims a trailing slash', () => {
    expect(apiConnectSources('https://api.example.com/')).toEqual([
      'https://api.example.com',
      'wss://api.example.com',
    ]);
  });

  it('feeds a CSP that admits both the API and its WebSocket', () => {
    const csp = buildCspHeader('n', apiConnectSources('http://localhost:4000'));
    expect(csp).toContain("connect-src 'self' http://localhost:4000 ws://localhost:4000");
  });
});
