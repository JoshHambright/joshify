/**
 * The stampede test is the reason this file exists.
 *
 * Spotify may rotate the refresh token on a refresh. Two concurrent refreshes
 * mean the second uses a token the first has already invalidated — which fails,
 * and takes the device offline until somebody re-authorises it by hand. That is
 * a fault nobody would find until a wall panel had been up for a week.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isOk, ok, type JoshifyError, type Result, type TokenSet } from '@joshify/core';
import { createTokenSource } from './token-source.js';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import type { TokenStore } from './token-store.js';

let spotify: FakeSpotify;

/** Fresh by default: an hour of life, with the refresh due at 80% of it. */
const tokensAt = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'access-seed',
  refreshToken: 'refresh-seed',
  scopes: ['user-read-playback-state'],
  expiresAt: Date.now() + 3_600_000,
  refreshAt: Date.now() + 2_880_000,
  ...over,
});

/** Past its refresh point but not yet expired — the proactive case. */
const dueForRefresh = (): TokenSet =>
  tokensAt({ expiresAt: Date.now() + 10_000, refreshAt: Date.now() - 1 });

/** Actually expired. */
const stale = (): TokenSet =>
  tokensAt({ expiresAt: Date.now() - 1, refreshAt: Date.now() - 1 });

/** A store that counts its writes and can be made to fail them. */
const memoryStore = (initial: TokenSet | null) => {
  let held = initial;
  const saved: TokenSet[] = [];
  let failSave = false;
  const store: TokenStore = {
    load: () => Promise.resolve(ok(held)),
    save: (tokens) => {
      if (failSave) {
        return Promise.resolve({
          ok: false as const,
          error: { kind: 'unexpected' as const, message: 'disk full', retryable: false },
        });
      }
      held = tokens;
      saved.push(tokens);
      return Promise.resolve(ok(undefined));
    },
    clear: () => Promise.resolve(ok(undefined)),
  };
  return {
    store,
    saved,
    held: () => held,
    breakSaving: () => {
      failSave = true;
    },
  };
};

const build = (
  initial: TokenSet | null,
  over: { now?: () => number; onProblem?: (e: JoshifyError) => void } = {},
) => {
  const backing = memoryStore(initial);
  const source = createTokenSource({
    store: backing.store,
    clientId: 'client-id',
    tokenEndpoint: spotify.tokenEndpoint,
    ...over,
  });
  return { source, backing };
};

const unwrap = <T>(result: Result<T, JoshifyError>): T => {
  if (!isOk(result)) throw new Error(`expected success, got ${result.error.message}`);
  return result.value;
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
});

describe('reading a token', () => {
  it('uses the stored token while it is still good', async () => {
    const { source, backing } = build(tokensAt());

    expect(unwrap(await source.getAccessToken())).toBe('access-seed');
    expect(backing.saved).toHaveLength(0); // nothing refreshed, nothing written
  });

  it('reads the store once and holds the answer', async () => {
    const { source } = build(tokensAt());

    await source.getAccessToken();
    await source.getAccessToken();

    expect(spotify.requests.filter((r) => r.path === '/api/token')).toHaveLength(0);
  });

  // A first run is not a failure of the store, but it is a failure to answer.
  it('says plainly that no account is connected', async () => {
    const { source } = build(null);

    const result = await source.getAccessToken();

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('auth');
    expect(result.error.message).toContain('joshify auth');
  });
});

describe('refreshing', () => {
  it('refreshes ahead of expiry rather than on it', async () => {
    const { source } = build(dueForRefresh());

    const token = unwrap(await source.getAccessToken());

    expect(token).not.toBe('access-seed');
    expect(spotify.requests.some((r) => r.path === '/api/token')).toBe(true);
  });

  it('persists the refreshed set, so a restart does not refresh again', async () => {
    const { source, backing } = build(stale());

    const token = unwrap(await source.getAccessToken());

    expect(backing.saved).toHaveLength(1);
    expect(backing.held()?.accessToken).toBe(token);
  });

  // Spotify frequently answers a refresh with no new refresh_token, and the
  // old one stays valid. Losing it would strand the device permanently.
  it('keeps the refresh token when Spotify omits it', async () => {
    spotify.omitRefreshTokenOnRefresh = true;
    const { source, backing } = build(stale());

    await source.getAccessToken();

    expect(backing.held()?.refreshToken).toBe('refresh-seed');
  });

  // The heart of it: two callers discovering staleness in the same tick must
  // produce one refresh, because Spotify may rotate the token on the first.
  it('shares one refresh between concurrent callers', async () => {
    const { source } = build(stale());

    const [a, b, c] = await Promise.all([
      source.getAccessToken(),
      source.getAccessToken(),
      source.refreshAccessToken(),
    ]);

    expect(spotify.requests.filter((r) => r.path === '/api/token')).toHaveLength(1);
    expect(unwrap(a)).toBe(unwrap(b));
    expect(unwrap(b)).toBe(unwrap(c));
  });

  it('allows a later refresh once the shared one has finished', async () => {
    const { source } = build(stale());

    await source.getAccessToken();
    await source.refreshAccessToken();

    expect(spotify.requests.filter((r) => r.path === '/api/token')).toHaveLength(2);
  });

  it('reports a refresh failure rather than answering with a stale token', async () => {
    const problems: JoshifyError[] = [];
    const { source } = build(stale(), {
      onProblem: (e) => problems.push(e),
    });
    spotify.validRefreshTokens.clear();

    const result = await source.getAccessToken();

    expect(isOk(result)).toBe(false);
    expect(problems).toHaveLength(1);
  });

  // The token in memory is good, so the device keeps working — but it will not
  // survive a restart, and that is worth saying rather than discovering days
  // later when it silently re-authorises.
  it('keeps working but complains when the refreshed token cannot be saved', async () => {
    const problems: JoshifyError[] = [];
    const { source, backing } = build(stale(), {
      onProblem: (e) => problems.push(e),
    });
    backing.breakSaving();

    const result = await source.getAccessToken();

    expect(isOk(result)).toBe(true);
    expect(problems.some((p) => p.message.includes('not saved'))).toBe(true);
  });

  it('forces a refresh when asked, even on a token that looks fine', async () => {
    const { source } = build(tokensAt());

    const token = unwrap(await source.refreshAccessToken());

    expect(token).not.toBe('access-seed');
  });
});
