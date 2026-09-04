/**
 * When to retry a failed Spotify request, and how long to wait first.
 *
 * Pure decision logic — no timers, no sleeping — so the policy can be tested
 * exhaustively without a test suite that actually waits.
 */
import type { JoshifyError } from '@joshify/core';

export interface RetryPolicy {
  /** Total attempts including the first. 3 means one try plus two retries. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/**
 * How long to wait before attempt `attempt + 1`, or `null` to give up.
 *
 * `attempt` is 1-based and counts the attempt that just failed.
 */
export const nextRetryDelay = (
  error: JoshifyError,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  jitter: () => number = Math.random,
): number | null => {
  // An expired token or a free account will fail identically forever. Retrying
  // only delays showing the user the thing they need to act on.
  if (!error.retryable) return null;
  if (attempt >= policy.maxAttempts) return null;

  // Spotify told us exactly how long to wait. Guessing shorter gets us
  // rate-limited harder; guessing longer wastes time.
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, policy.maxDelayMs);
  }

  const exponential = Math.min(
    policy.baseDelayMs * 2 ** (attempt - 1),
    policy.maxDelayMs,
  );

  // Full jitter, not a fixed backoff. A device polling on a fixed cadence can
  // resonate with a periodic upstream fault and retry into the same failure
  // window every time; spreading the delay breaks that lockstep.
  return Math.round(exponential * jitter());
};
