import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  challengeFor,
  checkRedirectUri,
  createState,
  createVerifier,
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
  type RandomBytes,
} from './pkce.js';

/** Deterministic byte source: 0,1,2,... so output is reproducible. */
const counting: RandomBytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 256);

describe('createVerifier', () => {
  it('produces a verifier of the requested length', () => {
    expect(createVerifier(43, counting)).toHaveLength(43);
    expect(createVerifier(128, counting)).toHaveLength(128);
  });

  it('uses only the RFC 7636 unreserved alphabet', () => {
    expect(createVerifier(128, counting)).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('rejects lengths outside the spec bounds', () => {
    expect(() => createVerifier(VERIFIER_MIN_LENGTH - 1, counting)).toThrow(RangeError);
    expect(() => createVerifier(VERIFIER_MAX_LENGTH + 1, counting)).toThrow(RangeError);
  });

  it('is random enough not to repeat', () => {
    expect(createVerifier()).not.toEqual(createVerifier());
  });
});

describe('createState', () => {
  it('is url-safe and non-repeating', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createState()).not.toEqual(createState());
  });
});

describe('challengeFor', () => {
  // RFC 7636 Appendix B: the canonical verifier and its expected S256 challenge.
  it('matches the RFC 7636 worked example', async () => {
    await expect(
      challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is url-safe and unpadded', async () => {
    await expect(challengeFor(createVerifier())).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('checkRedirectUri', () => {
  it('accepts https', () => {
    expect(checkRedirectUri('https://joshify.example/callback')).toBeUndefined();
  });

  it('accepts http on loopback literals', () => {
    expect(checkRedirectUri('http://127.0.0.1:8080/callback')).toBeUndefined();
    expect(checkRedirectUri('http://[::1]:8080/callback')).toBeUndefined();
  });

  it('rejects the localhost hostname, which Spotify no longer allows', () => {
    const problem = checkRedirectUri('http://localhost:8080/callback');
    expect(problem?.reason).toContain('localhost');
  });

  it('rejects http on a non-loopback host', () => {
    const problem = checkRedirectUri('http://192.168.1.50:8080/callback');
    expect(problem?.reason).toContain('loopback');
  });

  it('rejects a non-http scheme', () => {
    const problem = checkRedirectUri('ftp://127.0.0.1/callback');
    expect(problem?.reason).toContain('not https or http');
  });

  it('rejects a malformed URI', () => {
    expect(checkRedirectUri('not a uri')?.reason).toBe('not a valid absolute URI');
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:8080/callback',
    scopes: ['user-read-playback-state', 'user-modify-playback-state'],
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
  } as const;

  it('sets every parameter Spotify requires', () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/callback');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
  });

  it('joins scopes with spaces', () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.get('scope')).toBe(
      'user-read-playback-state user-modify-playback-state',
    );
  });

  it('can target a fake endpoint for tests', () => {
    const url = buildAuthorizeUrl({
      ...base,
      authorizeEndpoint: 'http://127.0.0.1:9999/authorize',
    });
    expect(url.startsWith('http://127.0.0.1:9999/authorize?')).toBe(true);
  });

  it('refuses to build a URL with an invalid redirect', () => {
    expect(() =>
      buildAuthorizeUrl({ ...base, redirectUri: 'http://localhost:8080/callback' }),
    ).toThrow(/localhost/);
  });
});
