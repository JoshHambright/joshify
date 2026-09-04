import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOk, ok, type JoshifyError } from '@joshify/core';
import {
  startFakeSpotify,
  type FakeSpotify,
  type RecordedRequest,
} from '../testing/fake-spotify.js';
import { createSpotifyClient } from './client.js';
import {
  createSpotifyCommands,
  type CommandResult,
  type SpotifyCommands,
} from './commands.js';

let spotify: FakeSpotify;

const commands = (): SpotifyCommands =>
  createSpotifyCommands(
    createSpotifyClient({
      tokenSource: {
        getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
        refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
      },
      baseUrl: spotify.origin,
      sleep: () => Promise.resolve(),
      jitter: () => 1,
    }),
  );

const lastRequest = (): RecordedRequest => {
  const request = spotify.requests.at(-1);
  if (request === undefined) throw new Error('the fake served no request');
  return request;
};

/** A command that fails is a bug in the test unless the test says otherwise. */
const expectAccepted = (result: CommandResult): void => {
  if (!isOk(result)) throw new Error(`expected success, got: ${result.error.message}`);
};

const expectRejected = (result: CommandResult): JoshifyError => {
  if (isOk(result)) throw new Error('expected failure');
  return result.error;
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
});
afterEach(async () => {
  await spotify.close();
});

// 204 is the *success* answer for every one of these. A client that treated an
// empty body as a failed parse would report every working command as broken.
describe('the transport surface', () => {
  it('resumes with a bodyless PUT', async () => {
    expectAccepted(await commands().play());
    expect(lastRequest()).toMatchObject({
      method: 'PUT',
      path: '/v1/me/player/play',
      search: '',
      json: undefined,
    });
  });

  it('pauses', async () => {
    expectAccepted(await commands().pause());
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/pause' });
  });

  // next/previous are POST while everything else is PUT. Sending PUT here gets
  // a 405 from the fake, which is the whole point of it enforcing the verb.
  it('skips forward with POST', async () => {
    expectAccepted(await commands().next());
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/v1/me/player/next' });
  });

  it('skips back with POST', async () => {
    expectAccepted(await commands().previous());
    expect(lastRequest()).toMatchObject({
      method: 'POST',
      path: '/v1/me/player/previous',
    });
  });

  it('seeks with position_ms', async () => {
    expectAccepted(await commands().seek(42_000));
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/seek' });
    expect(lastRequest().query).toEqual({ position_ms: '42000' });
  });

  it('sets volume with volume_percent', async () => {
    expectAccepted(await commands().setVolume(35));
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/volume' });
    expect(lastRequest().query).toEqual({ volume_percent: '35' });
  });

  // Spotify wants the literal strings "true"/"false" here, not 1/0.
  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('sets shuffle %s as state=%s', async (enabled, expected) => {
    expectAccepted(await commands().setShuffle(enabled));
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/shuffle' });
    expect(lastRequest().query).toEqual({ state: expected });
  });

  it.each(['off', 'track', 'context'] as const)('sets repeat mode %s', async (mode) => {
    expectAccepted(await commands().setRepeat(mode));
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/repeat' });
    expect(lastRequest().query).toEqual({ state: mode });
  });
});

describe('device targeting', () => {
  // The classic silent bug: a parameter named device or id instead of
  // device_id is accepted by Spotify and simply ignored, so the command runs
  // on whatever happens to be active. Only asserting the query catches it.
  it('names the target device as device_id', async () => {
    expectAccepted(await commands().pause({ deviceId: 'dev-1' }));
    expect(lastRequest().query).toEqual({ device_id: 'dev-1' });
  });

  it('keeps the command parameter and device_id together', async () => {
    expectAccepted(await commands().seek(1_000, { deviceId: 'dev-1' }));
    expect(lastRequest().search).toBe('?position_ms=1000&device_id=dev-1');
  });

  // An empty device_id is not the same as omitting it: Spotify treats the
  // parameter as present and fails to match any device.
  it('omits device_id entirely when no device is given', async () => {
    expectAccepted(await commands().setVolume(10));
    expect(lastRequest().search).toBe('?volume_percent=10');
    expect(lastRequest().query['device_id']).toBeUndefined();
  });
});

describe('play with a context', () => {
  it('sends context_uri for "play this album"', async () => {
    expectAccepted(
      await commands().play({ contextUri: 'spotify:album:1', offset: { position: 3 } }),
    );
    expect(lastRequest().json).toEqual({
      context_uri: 'spotify:album:1',
      offset: { position: 3 },
    });
  });

  it('sends explicit tracks as uris with a uri offset', async () => {
    expectAccepted(
      await commands().play({
        uris: ['spotify:track:a', 'spotify:track:b'],
        offset: { uri: 'spotify:track:b' },
        positionMs: 5_000,
      }),
    );
    expect(lastRequest().json).toEqual({
      uris: ['spotify:track:a', 'spotify:track:b'],
      offset: { uri: 'spotify:track:b' },
      position_ms: 5_000,
    });
  });

  it('targets a device by query while the context stays in the body', async () => {
    expectAccepted(
      await commands().play({ contextUri: 'spotify:playlist:1', deviceId: 'dev-1' }),
    );
    expect(lastRequest().query).toEqual({ device_id: 'dev-1' });
    expect(lastRequest().json).toEqual({ context_uri: 'spotify:playlist:1' });
  });

  it('resumes at a position without any context', async () => {
    expectAccepted(await commands().play({ positionMs: 0 }));
    expect(lastRequest().json).toEqual({ position_ms: 0 });
  });
});

describe('transfer playback', () => {
  // The device lives in the body here, not the query — the one player write
  // that differs — and the field is a plural array holding exactly one id.
  it('puts the device in device_ids', async () => {
    expectAccepted(await commands().transferPlayback('dev-1'));
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player' });
    expect(lastRequest().json).toEqual({ device_ids: ['dev-1'] });
  });

  it('starts playback on the new device when asked', async () => {
    expectAccepted(await commands().transferPlayback('dev-1', { play: true }));
    expect(lastRequest().json).toEqual({ device_ids: ['dev-1'], play: true });
  });

  // Omitting `play` means "keep doing what you were doing". Sending false
  // instead would pause a device the user just moved music onto.
  it('omits play when the caller does not care', async () => {
    expectAccepted(await commands().transferPlayback('dev-1', {}));
    expect(lastRequest().json).toEqual({ device_ids: ['dev-1'] });
  });
});

describe('input validation', () => {
  // Spotify's answer to any of these is "Player command failed" with a 400 and
  // no field name, so failing locally is the only way the caller learns which
  // value was wrong.
  it.each([
    ['above the maximum', 101],
    ['below zero', -1],
    ['fractional', 12.5],
    ['not a number at all', Number.NaN],
  ])('refuses a volume %s', async (_label, value) => {
    const error = expectRejected(await commands().setVolume(value));
    expect(error.kind).toBe('unexpected');
    expect(error.message).toContain('volume_percent');
    expect(spotify.requests).toHaveLength(0);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a %s seek position', async (_label, value) => {
    const error = expectRejected(await commands().seek(value));
    expect(error.message).toContain('position_ms');
    expect(spotify.requests).toHaveLength(0);
  });

  it('refuses a context and explicit uris together', async () => {
    const error = expectRejected(
      await commands().play({ contextUri: 'spotify:album:1', uris: ['spotify:track:a'] }),
    );
    expect(error.message).toContain('not both');
  });

  it('refuses an empty uris list', async () => {
    const error = expectRejected(await commands().play({ uris: [] }));
    expect(error.message).toContain('empty');
  });

  it('refuses an offset with nothing to index into', async () => {
    const error = expectRejected(await commands().play({ offset: { position: 1 } }));
    expect(error.message).toContain('offset');
  });

  it('refuses a negative offset position', async () => {
    const error = expectRejected(
      await commands().play({ contextUri: 'spotify:album:1', offset: { position: -1 } }),
    );
    expect(error.message).toContain('offset.position');
  });

  it('refuses a negative play position', async () => {
    const error = expectRejected(await commands().play({ positionMs: -1 }));
    expect(error.message).toContain('position_ms');
    expect(spotify.requests).toHaveLength(0);
  });

  it('accepts a uri offset without checking its shape further', async () => {
    expectAccepted(
      await commands().play({
        contextUri: 'spotify:album:1',
        offset: { uri: 'spotify:track:a' },
      }),
    );
  });
});

describe('failures the device has to show', () => {
  // Not every Connect target can be volume-controlled — TVs, receivers and
  // cast groups answer 403. Papering over it would leave the UI drawing a
  // slider position the speaker never took.
  it('reports a device that refuses volume changes', async () => {
    spotify.volumeSupported = false;
    const error = expectRejected(await commands().setVolume(50));
    expect(error.kind).toBe('forbidden');
    expect(error.message).toContain('Cannot control device volume');
  });

  // The commonest real failure: everything is authorised, nothing is playing
  // anywhere, so there is no device to command.
  it('reports no active device', async () => {
    spotify.failNext({
      status: 404,
      body: {
        error: { status: 404, message: 'Player command failed: No active device' },
      },
    });
    const error = expectRejected(await commands().next());
    expect(error.kind).toBe('no-active-device');
  });

  // Every /me/player write needs Premium; a free account can read state all
  // day and control nothing.
  it('reports a free account', async () => {
    spotify.failNext({
      status: 403,
      body: {
        error: { status: 403, message: 'Player command failed: Premium required' },
      },
    });
    const error = expectRejected(await commands().pause());
    expect(error.kind).toBe('not-premium');
  });

  // A retried command still ends on a 204, and the retry must not turn that
  // empty success into "no result" on the way back out.
  it('still reports success when a command succeeds only after a retry', async () => {
    spotify.failNext({ status: 503 });
    expectAccepted(await commands().pause());
    expect(lastRequest()).toMatchObject({ method: 'PUT', path: '/v1/me/player/pause' });
  });
});
