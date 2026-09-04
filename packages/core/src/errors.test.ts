import { describe, expect, it } from 'vitest';
import {
  classifyHttpFailure,
  classifyThrown,
  createError,
  parseRetryAfter,
} from './errors.js';

describe('createError', () => {
  it('marks transient kinds retryable', () => {
    expect(createError('rate-limited', 'slow down').retryable).toBe(true);
    expect(createError('network', 'offline').retryable).toBe(true);
    expect(createError('server', 'boom').retryable).toBe(true);
  });

  it('marks kinds that need user action non-retryable', () => {
    expect(createError('auth', 'expired').retryable).toBe(false);
    expect(createError('not-premium', 'nope').retryable).toBe(false);
    expect(createError('forbidden', 'scope').retryable).toBe(false);
    expect(createError('no-active-device', 'none').retryable).toBe(false);
    expect(createError('unexpected', 'huh').retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('converts seconds to milliseconds', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(' 12 ')).toBe(12000);
  });

  it('rounds fractional seconds up, never waiting too little', () => {
    expect(parseRetryAfter('0.4')).toBe(400);
    expect(parseRetryAfter('1.0001')).toBe(1001);
  });

  it('is undefined for missing or nonsense values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('classifyHttpFailure', () => {
  const spotifyBody = (message: string) => ({ error: { status: 0, message } });

  it('maps 401 to auth', () => {
    const error = classifyHttpFailure({ status: 401, body: spotifyBody('expired') });
    expect(error.kind).toBe('auth');
    expect(error.message).toBe('expired');
    expect(error.status).toBe(401);
  });

  // The important distinction: Spotify uses 403 for both "wrong scope" and
  // "free account", and only the message tells them apart.
  it('maps 403 mentioning Premium to not-premium', () => {
    const error = classifyHttpFailure({
      status: 403,
      body: spotifyBody('Player command failed: Premium required'),
    });
    expect(error.kind).toBe('not-premium');
  });

  it('maps any other 403 to forbidden', () => {
    const error = classifyHttpFailure({
      status: 403,
      body: spotifyBody('Insufficient client scope'),
    });
    expect(error.kind).toBe('forbidden');
  });

  it('maps 404 to no-active-device', () => {
    expect(classifyHttpFailure({ status: 404 }).kind).toBe('no-active-device');
  });

  it('maps 429 and reads Retry-After', () => {
    const error = classifyHttpFailure({ status: 429, retryAfter: '7' });
    expect(error.kind).toBe('rate-limited');
    expect(error.retryAfterMs).toBe(7000);
    expect(error.retryable).toBe(true);
  });

  it('omits retryAfterMs when the header is absent', () => {
    expect(classifyHttpFailure({ status: 429 }).retryAfterMs).toBeUndefined();
  });

  it('maps 5xx to server', () => {
    expect(classifyHttpFailure({ status: 500 }).kind).toBe('server');
    expect(classifyHttpFailure({ status: 503 }).retryable).toBe(true);
  });

  it('maps anything else to unexpected', () => {
    expect(classifyHttpFailure({ status: 418 }).kind).toBe('unexpected');
  });

  it('falls back to a status message when the body is unhelpful', () => {
    expect(classifyHttpFailure({ status: 500 }).message).toBe('Spotify returned 500');
    expect(classifyHttpFailure({ status: 500, body: 'plain text' }).message).toBe(
      'Spotify returned 500',
    );
    expect(classifyHttpFailure({ status: 500, body: null }).message).toBe(
      'Spotify returned 500',
    );
  });

  it('reads the token endpoint shape, where error is a bare string', () => {
    const error = classifyHttpFailure({
      status: 400,
      body: { error: 'invalid_grant' },
    });
    expect(error.message).toBe('invalid_grant');
  });
});

describe('classifyThrown', () => {
  it('treats a thrown transport failure as retryable network', () => {
    const error = classifyThrown(new Error('getaddrinfo ENOTFOUND'));
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('getaddrinfo ENOTFOUND');
  });

  it('handles a non-Error being thrown', () => {
    expect(classifyThrown('nope').message).toBe('network request failed');
  });
});
