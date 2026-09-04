import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createError,
  err,
  isOk,
  ok,
  type JoshifyError,
  type Result,
} from '@joshify/core';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { createSpotifyClient, type TokenSource } from './client.js';

let spotify: FakeSpotify;
const slept: number[] = [];

/** Records delays instead of waiting, so retry tests run instantly. */
const sleep = (ms: number): Promise<void> => {
  slept.push(ms);
  return Promise.resolve();
};

const tokenSource = (overrides: Partial<TokenSource> = {}): TokenSource => ({
  getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
  refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
  ...overrides,
});

const client = (source: TokenSource = tokenSource()) =>
  createSpotifyClient({
    tokenSource: source,
    baseUrl: spotify.origin,
    sleep,
    jitter: () => 1,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  });

beforeEach(async () => {
  spotify = await startFakeSpotify();
  slept.length = 0;
});
afterEach(async () => {
  await spotify.close();
});

describe('authenticated requests', () => {
  it('attaches the bearer token', async () => {
    const result = await client().getProfile();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({ id: 'josh', displayName: 'Josh', isPremium: true });
  });

  it('fails when the token source cannot produce a token', async () => {
    const source = tokenSource({
      getAccessToken: () => Promise.resolve(err(createError('auth', 'no token'))),
    });
    const result = await client(source).getProfile();
    expect(isOk(result)).toBe(false);
  });
});

describe('401 handling', () => {
  it('refreshes once and retries', async () => {
    // The stored token is stale: the fake will reject it until we refresh.
    spotify.validAccessToken = 'the-new-token';
    let handedOut = 'the-stale-token';
    const refreshAccessToken = vi.fn((): Promise<Result<string, JoshifyError>> => {
      handedOut = 'the-new-token';
      return Promise.resolve(ok(handedOut));
    });
    const source = tokenSource({
      getAccessToken: () => Promise.resolve(ok(handedOut)),
      refreshAccessToken,
    });

    const result = await client(source).getProfile();
    expect(isOk(result)).toBe(true);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  // Looping on repeated 401s would hammer the token endpoint for nothing.
  it('gives up after one refresh if the fresh token is also rejected', async () => {
    const refreshAccessToken = vi.fn(() => Promise.resolve(ok('still-wrong')));
    const source = tokenSource({
      getAccessToken: () => Promise.resolve(ok('wrong')),
      refreshAccessToken,
    });

    const result = await client(source).getProfile();
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('auth');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed refresh rather than retrying blindly', async () => {
    const source = tokenSource({
      getAccessToken: () => Promise.resolve(ok('wrong')),
      refreshAccessToken: () =>
        Promise.resolve(err(createError('auth', 'refresh token revoked'))),
    });
    const result = await client(source).getProfile();
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('revoked');
  });
});

describe('retries', () => {
  it('retries a 5xx with exponential backoff, then succeeds', async () => {
    spotify.failNext({ status: 503 });
    spotify.failNext({ status: 503 });
    const result = await client().getProfile();
    expect(isOk(result)).toBe(true);
    expect(slept).toEqual([100, 200]);
  });

  it('waits exactly as long as Retry-After says', async () => {
    spotify.failNext({ status: 429, headers: { 'retry-after': '1' } });
    const result = await client().getProfile();
    expect(isOk(result)).toBe(true);
    expect(slept).toEqual([1000]);
  });

  it('gives up once attempts are exhausted and returns the last error', async () => {
    spotify.failNext({ status: 503 });
    spotify.failNext({ status: 503 });
    spotify.failNext({ status: 503 });
    const result = await client().getProfile();
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('server');
    expect(slept).toHaveLength(2); // 3 attempts means 2 waits
  });

  it('does not retry a failure that will never succeed', async () => {
    spotify.failNext({
      status: 403,
      body: { error: { message: 'Player command failed: Premium required' } },
    });
    const result = await client().getProfile();
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('not-premium');
    expect(slept).toEqual([]);
  });
});

describe('getPlaybackState', () => {
  // Spotify answers 204 with no body when nothing is playing. That is a state,
  // not an error, and it must not be mistaken for a failed request.
  it('returns null when nothing is playing', async () => {
    const result = await client().getPlaybackState();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toBeNull();
  });

  it('returns the raw payload when something is playing', async () => {
    spotify.playbackState = { is_playing: true, progress_ms: 1234 };
    const result = await client().getPlaybackState();
    if (!isOk(result)) throw new Error('expected success');
    expect(result.value).toMatchObject({ is_playing: true, progress_ms: 1234 });
  });
});

describe('getDevices', () => {
  it('returns the device list payload', async () => {
    const result = await client().getDevices();
    if (!isOk(result)) throw new Error('expected success');
    expect(result.value).toMatchObject({ devices: [{ id: 'dev-1', name: 'Kitchen' }] });
  });
});

describe('getProfile validation', () => {
  it('rejects a profile payload without an id', async () => {
    spotify.failNext({ status: 200, body: { display_name: 'Josh' } });
    const result = await client().getProfile();
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.kind).toBe('unexpected');
  });

  it('reports a free account as not premium', async () => {
    spotify.failNext({ status: 200, body: { id: 'josh', product: 'free' } });
    const result = await client().getProfile();
    if (!isOk(result)) throw new Error('expected success');
    expect(result.value.isPremium).toBe(false);
    expect(result.value.displayName).toBeNull();
  });
});

describe('header merging', () => {
  // HeadersInit may be an array of pairs or a Headers instance. Spreading
  // either into an object drops every header, including authorization —
  // which would look like a mysterious 401 rather than a coding mistake.
  it.each([
    ['record', { 'content-type': 'application/json' }],
    ['array of pairs', [['content-type', 'application/json']] as [string, string][]],
    ['Headers instance', new Headers({ 'content-type': 'application/json' })],
  ])('keeps auth and caller headers when given a %s', async (_label, headers) => {
    const result = await client().request('/v1/me', { headers });
    expect(isOk(result)).toBe(true);
  });
});

describe('podcast support', () => {
  // /v1/me/player defaults to additional_types=track. Without asking for
  // episodes, a playing podcast comes back as item: null and the device shows
  // "nothing playing" while audio is audibly coming out of the speakers.
  it('asks for episodes as well as tracks', async () => {
    await client().getPlaybackState();
    const call = spotify.requests.find((r) => r.path === '/v1/me/player');
    expect(call?.query['additional_types']).toBe('episode');
  });
});

describe('malformed responses', () => {
  // An empty or non-JSON body must not turn into a parse exception. The status
  // is the information we actually need, and losing it to a throw would report
  // a network fault for what is really a 404.
  it('keeps the status when the body is not JSON', async () => {
    const result = await client().request('/v1/nope');
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.status).toBe(404);
    expect(result.error.kind).toBe('no-active-device');
  });
});

describe('production defaults', () => {
  const captureUrl = (seen: string[]): typeof fetch =>
    ((url: string | URL) => {
      seen.push(String(url));
      return Promise.resolve(
        new Response('{"id":"josh"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

  // Nothing else in the suite exercises the real base URL, because every test
  // points at the fake. A wrong default would fail silently in dev and only
  // surface on the device.
  it('targets the real Spotify API when no base URL is given', async () => {
    const seen: string[] = [];
    await createSpotifyClient({
      tokenSource: tokenSource(),
      fetchImpl: captureUrl(seen),
    }).getDevices();
    expect(seen).toEqual(['https://api.spotify.com/v1/me/player/devices']);
  });
});
