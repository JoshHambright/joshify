/**
 * The bridge between the token *store* (bytes on disk) and the Spotify client
 * (a string, refreshed when it needs to be).
 *
 * Everything below exists because a refresh has three properties that do not
 * survive being written inline at a call site:
 *
 *  1. **It must not stampede.** The poll loop and a command can both discover
 *     the token is stale in the same millisecond. Two refreshes race, and
 *     Spotify may rotate the refresh token on the first — invalidating the
 *     second, which then fails and takes the device offline until someone
 *     re-authorises it by hand. So concurrent callers share one in-flight
 *     refresh.
 *  2. **It must persist.** A refresh that is not written to disk means the
 *     device re-refreshes on every restart, and eventually hits a refresh
 *     token Spotify has already rotated away.
 *  3. **It must keep the refresh token when Spotify omits it.** Spotify
 *     frequently answers a refresh without a new `refresh_token`, and the old
 *     one stays valid. `refreshTokens` already handles that; this must not
 *     undo it by overwriting the stored set with a partial one.
 */
import {
  isExpired,
  needsRefresh,
  createError,
  err,
  ok,
  type JoshifyError,
  type Result,
  type TokenSet,
} from '@joshify/core';
import { refreshTokens } from './token-client.js';
import type { TokenStore } from './token-store.js';
import type { TokenSource } from '../spotify/client.js';

export interface TokenSourceConfig {
  readonly store: TokenStore;
  readonly clientId: string;
  /** Overridable so tests can point at the fake Spotify. */
  readonly tokenEndpoint?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  /** Reported when a refresh fails; the caller still gets an `Err`. */
  readonly onProblem?: ((error: JoshifyError) => void) | undefined;
}

const NOT_CONNECTED: JoshifyError = {
  kind: 'auth',
  message: 'no Spotify account is connected — run `joshify auth`',
  retryable: false,
};

export const createTokenSource = (config: TokenSourceConfig): TokenSource => {
  const now = config.now ?? Date.now;
  let cached: TokenSet | null = null;
  /** The refresh in flight, if any. Shared, never duplicated. */
  let refreshing: Promise<Result<TokenSet, JoshifyError>> | null = null;

  const load = async (): Promise<Result<TokenSet, JoshifyError>> => {
    if (cached !== null) return ok(cached);
    const stored = await config.store.load();
    if (!stored.ok) return stored;
    if (stored.value === null) return err(NOT_CONNECTED);
    cached = stored.value;
    return ok(cached);
  };

  const doRefresh = async (tokens: TokenSet): Promise<Result<TokenSet, JoshifyError>> => {
    const refreshed = await refreshTokens(
      {
        clientId: config.clientId,
        ...(config.tokenEndpoint === undefined
          ? {}
          : { tokenEndpoint: config.tokenEndpoint }),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        ...(config.now === undefined ? {} : { now: config.now }),
      },
      { refreshToken: tokens.refreshToken },
    );
    if (!refreshed.ok) {
      config.onProblem?.(refreshed.error);
      return refreshed;
    }
    cached = refreshed.value;
    const saved = await config.store.save(refreshed.value);
    if (!saved.ok) {
      // The token in memory is good, so the device keeps working — but it will
      // not survive a restart, and that is worth saying out loud rather than
      // discovering days later when it silently re-authorises.
      config.onProblem?.(
        createError(
          'unexpected',
          `refreshed token was not saved: ${saved.error.message}`,
        ),
      );
    }
    return ok(refreshed.value);
  };

  /** One refresh at a time, shared by everyone who asks while it runs. */
  const refreshOnce = async (
    tokens: TokenSet,
  ): Promise<Result<TokenSet, JoshifyError>> => {
    refreshing ??= doRefresh(tokens).finally(() => {
      refreshing = null;
    });
    return await refreshing;
  };

  return {
    getAccessToken: async () => {
      const tokens = await load();
      if (!tokens.ok) return tokens;
      const at = now();
      // Refresh ahead of expiry rather than on it: a token that expires
      // mid-request costs a 401 and a retry, and `needsRefresh` is what P1-05
      // sized that margin for.
      if (!needsRefresh(tokens.value, at) && !isExpired(tokens.value, at)) {
        return ok(tokens.value.accessToken);
      }
      const refreshed = await refreshOnce(tokens.value);
      return refreshed.ok ? ok(refreshed.value.accessToken) : refreshed;
    },
    refreshAccessToken: async () => {
      const tokens = await load();
      if (!tokens.ok) return tokens;
      const refreshed = await refreshOnce(tokens.value);
      return refreshed.ok ? ok(refreshed.value.accessToken) : refreshed;
    },
  };
};
