/**
 * The failure taxonomy for everything Joshify does over the network.
 *
 * These are the *expected* failures — a token expiring, a rate limit, nobody
 * playing anything. They are returned as `Err`, not thrown, and every one of
 * them eventually becomes a specific thing on screen (P3-12), so the kinds are
 * chosen by "what should the device do about it", not by HTTP status.
 */
export type ErrorKind =
  /**
   * We have no usable credential. Refresh, then re-authenticate.
   *
   * Covers Spotify rejecting a token *and* the local store being unable to
   * produce one — a corrupt or unreadable token file leaves the device in the
   * same position as a revoked token, and the same single remedy.
   */
  | 'auth'
  /** Authenticated, but the account lacks Premium. Nothing to retry. */
  | 'not-premium'
  /** Authenticated, but the token lacks a required scope. Re-authorise. */
  | 'forbidden'
  /** No active Spotify Connect device. Not an error so much as a state. */
  | 'no-active-device'
  /** Rate limited. `retryAfterMs` says how long to wait. */
  | 'rate-limited'
  /** Could not reach Spotify at all — DNS, offline, timeout. */
  | 'network'
  /** Spotify returned 5xx. Their problem; back off and retry. */
  | 'server'
  /** A response we do not understand. Always a bug worth surfacing. */
  | 'unexpected';

export interface JoshifyError {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'rate-limited',
  'network',
  'server',
]);

export const createError = (
  kind: ErrorKind,
  message: string,
  extra: Omit<JoshifyError, 'kind' | 'message' | 'retryable'> = {},
): JoshifyError => ({ kind, message, retryable: RETRYABLE.has(kind), ...extra });

/**
 * Spotify sends `Retry-After` in **seconds**. Returns milliseconds, or
 * undefined when the header is missing or not a sane number.
 */
export const parseRetryAfter = (header: string | null): number | undefined => {
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds * 1000);
};

/**
 * Spotify uses two different error shapes, and we need both.
 *
 * The Web API sends `{ error: { status, message } }`. The token endpoint is
 * OAuth-shaped: `{ error: "invalid_grant", error_description: "..." }`, where
 * the code alone ("invalid_grant") is nearly useless and the description
 * carries what actually went wrong — so the two are combined.
 */
const readSpotifyMessage = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const outer = body as { error?: unknown; error_description?: unknown };

  if (typeof outer.error === 'string') {
    return typeof outer.error_description === 'string' && outer.error_description !== ''
      ? `${outer.error}: ${outer.error_description}`
      : outer.error;
  }
  if (typeof outer.error !== 'object' || outer.error === null) return undefined;
  const inner = outer.error as { message?: unknown };
  return typeof inner.message === 'string' ? inner.message : undefined;
};

export interface HttpFailure {
  readonly status: number;
  readonly body?: unknown;
  readonly retryAfter?: string | null;
}

/**
 * Map an HTTP failure onto the taxonomy.
 *
 * The subtle case is 403: Spotify uses it both for a missing scope and for a
 * free account, and the two need completely different handling — one is
 * "authorise again", the other is "there is nothing you can do". Only the
 * message distinguishes them.
 */
export const classifyHttpFailure = (failure: HttpFailure): JoshifyError => {
  const { status } = failure;
  const detail = readSpotifyMessage(failure.body);
  const message = detail ?? `Spotify returned ${String(status)}`;

  if (status === 401) {
    return createError('auth', message, { status });
  }
  if (status === 403) {
    if (detail !== undefined && /premium/i.test(detail)) {
      return createError('not-premium', message, { status });
    }
    return createError('forbidden', message, { status });
  }
  if (status === 404) {
    return createError('no-active-device', message, { status });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(failure.retryAfter ?? null);
    return createError('rate-limited', message, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status >= 500) {
    return createError('server', message, { status });
  }
  return createError('unexpected', message, { status });
};

/** Wrap a thrown transport failure (fetch rejects on DNS, offline, abort). */
export const classifyThrown = (cause: unknown): JoshifyError =>
  createError(
    'network',
    cause instanceof Error ? cause.message : 'network request failed',
    { cause },
  );
