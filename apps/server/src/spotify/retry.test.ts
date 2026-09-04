import { describe, expect, it } from 'vitest';
import { createError } from '@joshify/core';
import { DEFAULT_RETRY_POLICY, nextRetryDelay, type RetryPolicy } from './retry.js';

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 };
const noJitter = () => 1;

describe('nextRetryDelay', () => {
  it('gives up immediately on errors that will never succeed', () => {
    for (const kind of [
      'auth',
      'not-premium',
      'forbidden',
      'no-active-device',
    ] as const) {
      expect(nextRetryDelay(createError(kind, 'x'), 1, policy, noJitter)).toBeNull();
    }
  });

  it('retries transient failures', () => {
    for (const kind of ['network', 'server', 'rate-limited'] as const) {
      expect(nextRetryDelay(createError(kind, 'x'), 1, policy, noJitter)).not.toBeNull();
    }
  });

  it('backs off exponentially', () => {
    const server = createError('server', 'boom');
    expect(nextRetryDelay(server, 1, policy, noJitter)).toBe(100);
    expect(nextRetryDelay(server, 2, policy, noJitter)).toBe(200);
    expect(nextRetryDelay(server, 3, policy, noJitter)).toBe(400);
  });

  it('caps the delay', () => {
    const server = createError('server', 'boom');
    const big: RetryPolicy = { ...policy, maxAttempts: 20, baseDelayMs: 500 };
    expect(nextRetryDelay(server, 10, big, noJitter)).toBe(big.maxDelayMs);
  });

  it('stops once attempts are exhausted', () => {
    const server = createError('server', 'boom');
    expect(
      nextRetryDelay(server, policy.maxAttempts - 1, policy, noJitter),
    ).not.toBeNull();
    expect(nextRetryDelay(server, policy.maxAttempts, policy, noJitter)).toBeNull();
  });

  // Guessing shorter than Retry-After gets us rate-limited harder.
  it('obeys Retry-After in preference to its own backoff', () => {
    const limited = createError('rate-limited', 'slow down', { retryAfterMs: 750 });
    expect(nextRetryDelay(limited, 1, policy, noJitter)).toBe(750);
  });

  it('still caps an absurd Retry-After', () => {
    const limited = createError('rate-limited', 'slow', { retryAfterMs: 999_999 });
    expect(nextRetryDelay(limited, 1, policy, noJitter)).toBe(policy.maxDelayMs);
  });

  it('applies jitter across the full delay range', () => {
    const server = createError('server', 'boom');
    expect(nextRetryDelay(server, 2, policy, () => 0)).toBe(0);
    expect(nextRetryDelay(server, 2, policy, () => 0.5)).toBe(100);
    expect(nextRetryDelay(server, 2, policy, () => 1)).toBe(200);
  });

  it('defaults to a sane policy', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(nextRetryDelay(createError('server', 'x'), 1)).not.toBeNull();
  });
});
