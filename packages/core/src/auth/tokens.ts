/**
 * Token lifecycle, as pure logic. The HTTP calls live in apps/server.
 */
import { createError, type JoshifyError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms at which the access token stops working. */
  readonly expiresAt: number;
  /** Epoch ms at which we should proactively refresh — well before expiry. */
  readonly refreshAt: number;
  readonly scopes: readonly string[];
}

/**
 * Refresh at 80% of the token's life rather than on expiry.
 *
 * A device that waits for a 401 shows the user a stall. Refreshing early means
 * a failed refresh still leaves ~20% of the lifetime to retry within, so a
 * blip never becomes a visible outage.
 */
export const DEFAULT_REFRESH_RATIO = 0.8;

/** Never schedule a refresh less than this far ahead, whatever the ratio says. */
const MIN_REFRESH_LEAD_MS = 30_000;

export interface ParseTokenOptions {
  /** Epoch ms. Injected so this stays pure and testable. */
  readonly now: number;
  /**
   * The refresh token we already hold, if any.
   *
   * Spotify frequently omits `refresh_token` from a *refresh* response,
   * meaning "keep using the one you have". Dropping it there is a classic way
   * to log a device out days later for no visible reason.
   */
  readonly previousRefreshToken?: string;
  readonly refreshRatio?: number;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export const parseTokenResponse = (
  body: unknown,
  options: ParseTokenOptions,
): Result<TokenSet, JoshifyError> => {
  if (typeof body !== 'object' || body === null) {
    return err(createError('unexpected', 'token response was not an object'));
  }
  const raw = body as RawTokenResponse;

  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    return err(createError('unexpected', 'token response had no access_token'));
  }
  if (typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in)) {
    return err(createError('unexpected', 'token response had no usable expires_in'));
  }

  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token !== ''
      ? raw.refresh_token
      : options.previousRefreshToken;

  if (refreshToken === undefined) {
    return err(
      createError(
        'unexpected',
        'token response had no refresh_token and none was already held',
      ),
    );
  }

  const lifetimeMs = raw.expires_in * 1000;
  const ratio = options.refreshRatio ?? DEFAULT_REFRESH_RATIO;
  const expiresAt = options.now + lifetimeMs;
  const refreshAt = Math.min(
    options.now + lifetimeMs * ratio,
    expiresAt - MIN_REFRESH_LEAD_MS,
  );

  return ok({
    accessToken: raw.access_token,
    refreshToken,
    expiresAt,
    refreshAt,
    scopes: typeof raw.scope === 'string' && raw.scope !== '' ? raw.scope.split(' ') : [],
  });
};

export const isExpired = (tokens: TokenSet, now: number): boolean =>
  now >= tokens.expiresAt;

export const needsRefresh = (tokens: TokenSet, now: number): boolean =>
  now >= tokens.refreshAt;

/** Milliseconds until the next proactive refresh; never negative. */
export const msUntilRefresh = (tokens: TokenSet, now: number): number =>
  Math.max(0, tokens.refreshAt - now);

/** The scopes we asked for that the granted token does not actually carry. */
export const missingScopes = (
  tokens: TokenSet,
  required: readonly string[],
): readonly string[] => {
  const granted = new Set(tokens.scopes);
  return required.filter((scope) => !granted.has(scope));
};
