import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, codeChallengeS256, verifyPkce, generateState } from './pkce';

describe('PKCE', () => {
  it('matches the RFC 7636 S256 test vector', () => {
    // Appendix B of RFC 7636.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(codeChallengeS256(verifier)).toBe(challenge);
  });

  it('verifies a freshly generated verifier/challenge pair', () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a mismatched verifier', () => {
    const challenge = codeChallengeS256(generateCodeVerifier());
    expect(verifyPkce(generateCodeVerifier(), challenge)).toBe(false);
  });

  it('generates distinct, non-empty state values', () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateState().length).toBeGreaterThan(0);
  });
});
