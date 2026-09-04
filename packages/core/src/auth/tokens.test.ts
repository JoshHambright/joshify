import { describe, expect, it } from 'vitest';
import { isOk } from '../result.js';
import {
  isExpired,
  missingScopes,
  msUntilRefresh,
  needsRefresh,
  parseTokenResponse,
  type TokenSet,
} from './tokens.js';

const NOW = 1_700_000_000_000;

const response = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  scope: 'user-read-playback-state user-modify-playback-state',
  ...overrides,
});

const parseOrThrow = (body: unknown, previousRefreshToken?: string): TokenSet => {
  const result = parseTokenResponse(body, {
    now: NOW,
    ...(previousRefreshToken === undefined ? {} : { previousRefreshToken }),
  });
  if (!isOk(result)) throw new Error(result.error.message);
  return result.value;
};

describe('parseTokenResponse', () => {
  it('reads a complete response', () => {
    const tokens = parseOrThrow(response());
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBe(NOW + 3_600_000);
    expect(tokens.scopes).toEqual([
      'user-read-playback-state',
      'user-modify-playback-state',
    ]);
  });

  it('schedules the refresh at 80% of the lifetime', () => {
    expect(parseOrThrow(response()).refreshAt).toBe(NOW + 2_880_000);
  });

  // Spotify usually omits refresh_token when refreshing. Dropping it here
  // logs the device out days later for no visible reason.
  it('keeps the existing refresh token when the response omits one', () => {
    const tokens = parseOrThrow(response({ refresh_token: undefined }), 'refresh-old');
    expect(tokens.refreshToken).toBe('refresh-old');
  });

  it('prefers a newly issued refresh token over the held one', () => {
    const tokens = parseOrThrow(
      response({ refresh_token: 'refresh-new' }),
      'refresh-old',
    );
    expect(tokens.refreshToken).toBe('refresh-new');
  });

  it('treats an empty refresh token as absent', () => {
    expect(
      parseOrThrow(response({ refresh_token: '' }), 'refresh-old').refreshToken,
    ).toBe('refresh-old');
  });

  it('never schedules a refresh inside the last 30 seconds of a short token', () => {
    // 80% of 60s would be 48s, leaving only 12s to recover from a failure.
    const tokens = parseOrThrow(response({ expires_in: 60 }));
    expect(tokens.refreshAt).toBe(tokens.expiresAt - 30_000);
  });

  it('handles a missing scope string', () => {
    expect(parseOrThrow(response({ scope: undefined })).scopes).toEqual([]);
  });

  describe('rejects malformed responses', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['not an object', 'nope'],
      ['null', null],
      ['no access_token', response({ access_token: undefined })],
      ['empty access_token', response({ access_token: '' })],
      ['no expires_in', response({ expires_in: undefined })],
      ['non-numeric expires_in', response({ expires_in: 'soon' })],
    ];

    it.each(cases)('%s', (_label, body) => {
      const result = parseTokenResponse(body, { now: NOW });
      expect(isOk(result)).toBe(false);
      if (!isOk(result)) expect(result.error.kind).toBe('unexpected');
    });

    it('no refresh token anywhere', () => {
      const result = parseTokenResponse(response({ refresh_token: undefined }), {
        now: NOW,
      });
      expect(isOk(result)).toBe(false);
    });
  });
});

describe('token lifecycle', () => {
  const tokens = parseOrThrow(response());

  it('is not expired or due for refresh when fresh', () => {
    expect(isExpired(tokens, NOW)).toBe(false);
    expect(needsRefresh(tokens, NOW)).toBe(false);
    expect(msUntilRefresh(tokens, NOW)).toBe(2_880_000);
  });

  it('is due for refresh well before it expires', () => {
    const atRefresh = tokens.refreshAt;
    expect(needsRefresh(tokens, atRefresh)).toBe(true);
    expect(isExpired(tokens, atRefresh)).toBe(false);
  });

  it('is expired at and after expiry', () => {
    expect(isExpired(tokens, tokens.expiresAt)).toBe(true);
    expect(isExpired(tokens, tokens.expiresAt + 1)).toBe(true);
  });

  it('never reports a negative wait', () => {
    expect(msUntilRefresh(tokens, tokens.expiresAt + 10_000)).toBe(0);
  });
});

describe('missingScopes', () => {
  const tokens = parseOrThrow(response());

  it('is empty when everything required was granted', () => {
    expect(missingScopes(tokens, ['user-read-playback-state'])).toEqual([]);
  });

  it('names only what is absent', () => {
    expect(
      missingScopes(tokens, ['user-read-playback-state', 'user-library-read']),
    ).toEqual(['user-library-read']);
  });
});
