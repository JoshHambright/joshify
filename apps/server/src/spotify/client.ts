/**
 * The authenticated Spotify Web API client.
 *
 * Its job is transport only — auth headers, retries, rate-limit obedience, and
 * turning failures into the shared taxonomy. It deliberately returns payloads
 * as `unknown`: interpreting Spotify's shapes is the normaliser's job (P2-01),
 * and keeping that seam means the messy parsing lives in one tested place
 * rather than being spread across every call site.
 */
import {
  classifyHttpFailure,
  classifyThrown,
  createError,
  err,
  ok,
  type JoshifyError,
  type Result,
} from '@joshify/core';
import { DEFAULT_RETRY_POLICY, nextRetryDelay, type RetryPolicy } from './retry.js';

export const SPOTIFY_API_BASE = 'https://api.spotify.com';

/**
 * Supplies access tokens and refreshes them on demand.
 *
 * The client does not know or care where tokens are stored; that is the token
 * store's problem (P1-06).
 */
export interface TokenSource {
  /** A token believed valid, refreshed proactively if it is near expiry. */
  getAccessToken: () => Promise<Result<string, JoshifyError>>;
  /** Force a refresh. Called after a 401, which means our belief was wrong. */
  refreshAccessToken: () => Promise<Result<string, JoshifyError>>;
}

export interface SpotifyClientConfig {
  readonly tokenSource: TokenSource;
  readonly baseUrl?: string;
  readonly retryPolicy?: RetryPolicy;
  readonly fetchImpl?: typeof fetch;
  /** Injected so tests never actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly jitter?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SpotifyClient {
  /** Raw authenticated request. Resolves to `null` for `204 No Content`. */
  request: (path: string, init?: RequestInit) => Promise<Result<unknown, JoshifyError>>;
  getProfile: () => Promise<Result<SpotifyProfile, JoshifyError>>;
  /** `null` when nothing is playing — a state, not a failure. */
  getPlaybackState: () => Promise<Result<unknown, JoshifyError>>;
  getDevices: () => Promise<Result<unknown, JoshifyError>>;
}

export interface SpotifyProfile {
  readonly id: string;
  readonly displayName: string | null;
  /** Every playback-control endpoint requires Premium. */
  readonly isPremium: boolean;
}

export const createSpotifyClient = (config: SpotifyClientConfig): SpotifyClient => {
  const baseUrl = config.baseUrl ?? SPOTIFY_API_BASE;
  const policy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? realSleep;
  const jitter = config.jitter ?? Math.random;

  const attemptOnce = async (
    path: string,
    init: RequestInit,
    token: string,
  ): Promise<Result<unknown, JoshifyError>> => {
    // Merge through Headers rather than spreading: HeadersInit may be an array
    // of pairs or a Headers instance, and spreading either into an object
    // quietly discards every header, including this one.
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      return err(classifyThrown(cause));
    }

    if (response.status === 204) return ok(null);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      return err(
        classifyHttpFailure({
          status: response.status,
          body,
          retryAfter: response.headers.get('retry-after'),
          // Spotify overloads 404. On the player it means "nothing is playing
          // anywhere"; on a playlist or album it means the thing is gone.
          // Reporting the latter as "no active device" would put "choose a
          // speaker" on screen for a deleted playlist.
          notFoundMeans: path.startsWith('/v1/me/player')
            ? 'no-active-device'
            : 'not-found',
        }),
      );
    }
    return ok(body);
  };

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Result<unknown, JoshifyError>> => {
    const initial = await config.tokenSource.getAccessToken();
    if (!initial.ok) return initial;
    let token = initial.value;

    // A 401 means our token was already dead when we sent it, so one forced
    // refresh and immediate retry is warranted. Only once: a second 401 after
    // a fresh token is a real authentication failure, and looping on it would
    // hammer the token endpoint.
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const result = await attemptOnce(path, init, token);
      if (result.ok) return result;

      if (result.error.kind === 'auth' && !refreshed) {
        refreshed = true;
        const renewed = await config.tokenSource.refreshAccessToken();
        if (!renewed.ok) return renewed;
        token = renewed.value;
        attempt -= 1; // the dead token was our fault, not a failed attempt
        continue;
      }

      const delay = nextRetryDelay(result.error, attempt, policy, jitter);
      if (delay === null) return result;
      await sleep(delay);
    }
  };

  const getProfile = async (): Promise<Result<SpotifyProfile, JoshifyError>> => {
    const result = await request('/v1/me');
    if (!result.ok) return result;
    const body = result.value;
    if (typeof body !== 'object' || body === null) {
      return err(createError('unexpected', 'profile response was not an object'));
    }
    const raw = body as { id?: unknown; display_name?: unknown; product?: unknown };
    if (typeof raw.id !== 'string') {
      return err(createError('unexpected', 'profile response had no id'));
    }
    return ok({
      id: raw.id,
      displayName: typeof raw.display_name === 'string' ? raw.display_name : null,
      isPremium: raw.product === 'premium',
    });
  };

  return {
    request,
    getProfile,
    // `additional_types` defaults to `track` alone. Without asking for
    // episodes, Spotify reports a playing podcast as `item: null` — the device
    // would show "nothing playing" while a podcast is audibly playing.
    getPlaybackState: () => request('/v1/me/player?additional_types=episode'),
    getDevices: () => request('/v1/me/player/devices'),
  };
};
