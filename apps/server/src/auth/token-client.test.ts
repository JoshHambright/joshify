import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  challengeFor,
  createState,
  createVerifier,
  isOk,
} from '@joshify/core';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { exchangeCode, refreshTokens } from './token-client.js';

const NOW = 1_700_000_000_000;
const REDIRECT_URI = 'http://127.0.0.1:8080/callback';

let spotify: FakeSpotify;

const config = () => ({
  clientId: 'client-123',
  tokenEndpoint: spotify.tokenEndpoint,
  now: () => NOW,
});

/** Drive a real authorize round trip against the fake to obtain a live code. */
const getAuthorizationCode = async (codeChallenge: string): Promise<string> => {
  const url = buildAuthorizeUrl({
    clientId: 'client-123',
    redirectUri: REDIRECT_URI,
    scopes: ['user-read-playback-state'],
    state: createState(),
    codeChallenge,
    authorizeEndpoint: spotify.authorizeEndpoint,
  });
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) throw new Error('fake did not redirect');
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error('fake returned no code');
  return code;
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
});
afterEach(async () => {
  await spotify.close();
});

describe('exchangeCode', () => {
  it('exchanges a valid code for a token set', async () => {
    const verifier = createVerifier();
    const code = await getAuthorizationCode(await challengeFor(verifier));

    const result = await exchangeCode(config(), {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT_URI,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.accessToken).toMatch(/^access-/);
    expect(result.value.refreshToken).toMatch(/^refresh-/);
    expect(result.value.expiresAt).toBe(NOW + 3_600_000);
    expect(result.value.scopes).toContain('user-read-playback-state');
  });

  it('sends the parameters Spotify requires', async () => {
    const verifier = createVerifier();
    const code = await getAuthorizationCode(await challengeFor(verifier));
    await exchangeCode(config(), {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT_URI,
    });

    const tokenRequest = spotify.requests.find((r) => r.path === '/api/token');
    expect(tokenRequest?.form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-123',
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    // PKCE means no secret is ever transmitted.
    expect(tokenRequest?.form).not.toHaveProperty('client_secret');
  });

  // Proves the fake enforces PKCE rather than rubber-stamping it.
  it('fails when the verifier does not match the challenge', async () => {
    const code = await getAuthorizationCode(await challengeFor(createVerifier()));
    const result = await exchangeCode(config(), {
      code,
      codeVerifier: createVerifier(),
      redirectUri: REDIRECT_URI,
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.message).toContain('code_verifier');
  });
});

describe('refreshTokens', () => {
  it('exchanges a refresh token for a fresh access token', async () => {
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.accessToken).toMatch(/^access-/);
    expect(result.value.refreshAt).toBeLessThan(result.value.expiresAt);
  });

  // The bug this guards: Spotify commonly omits refresh_token on refresh,
  // and dropping it silently logs the device out days later.
  it('keeps the presented refresh token when the response omits one', async () => {
    spotify.omitRefreshTokenOnRefresh = true;
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.refreshToken).toBe('refresh-seed');
  });

  it('reports a revoked refresh token', async () => {
    const result = await refreshTokens(config(), { refreshToken: 'not-a-token' });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.message).toContain('revoked');
  });
});

describe('failure handling', () => {
  it('classifies 401 as auth', async () => {
    spotify.failNext({ status: 401, body: { error: { message: 'expired' } } });
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('auth');
    expect(result.error.retryable).toBe(false);
  });

  it('classifies 429 and reads Retry-After', async () => {
    spotify.failNext({ status: 429, headers: { 'retry-after': '5' } });
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('rate-limited');
    expect(result.error.retryAfterMs).toBe(5000);
    expect(result.error.retryable).toBe(true);
  });

  it('classifies 5xx as retryable server error', async () => {
    spotify.failNext({ status: 503 });
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('server');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies an unreachable endpoint as network', async () => {
    await spotify.close();
    const result = await refreshTokens(config(), { refreshToken: 'refresh-seed' });
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('network');
    expect(result.error.retryable).toBe(true);
    spotify = await startFakeSpotify(); // so afterEach has something to close
  });

  it('survives a non-JSON body without masking the status', async () => {
    const result = await refreshTokens(
      { ...config(), tokenEndpoint: `${spotify.origin}/nope` },
      { refreshToken: 'refresh-seed' },
    );
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.status).toBe(404);
  });
});

describe('production defaults', () => {
  // Same reasoning as the client: every other test points at the fake, so the
  // real token endpoint is otherwise never asserted.
  it('targets the real Spotify token endpoint when none is given', async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string | URL) => {
      seen.push(String(url));
      return Promise.resolve(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    await refreshTokens(
      { clientId: 'client-123', fetchImpl, now: () => NOW },
      { refreshToken: 'refresh-seed' },
    );
    expect(seen).toEqual(['https://accounts.spotify.com/api/token']);
  });
});
