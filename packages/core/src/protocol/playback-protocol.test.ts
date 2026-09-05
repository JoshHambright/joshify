import { describe, expect, it } from 'vitest';
import { IDLE_PLAYBACK, isOk, type PlaybackState } from '../index.js';
import {
  applyPlaybackDiff,
  applyServerMessage,
  diffPlaybackState,
  isEmptyDiff,
  nextReconnectDelayMs,
  parseClientMessage,
  parseServerMessage,
  RECONNECT_MAX_DELAY_MS,
  type ClientState,
  type DiffMessage,
} from './playback-protocol.js';

/** Shapes matching the normaliser's output for a playing track (P2-01). */
const TRACK: NonNullable<PlaybackState['item']> = {
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Windowlicker',
  subtitle: 'Aphex Twin',
  durationMs: 366_000,
  images: [
    { url: 'https://i.example/640.jpg', width: 640, height: 640 },
    { url: 'https://i.example/64.jpg', width: 64, height: 64 },
  ],
  isLocal: false,
};

const DEVICE: NonNullable<PlaybackState['device']> = {
  id: 'device-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: true,
  volumePercent: 40,
  supportsVolume: true,
};

const playing = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  isPlaying: true,
  progressMs: 12_000,
  shuffle: false,
  repeat: 'off',
  item: TRACK,
  device: DEVICE,
  ...overrides,
});

describe('diffPlaybackState', () => {
  it('finds nothing to send when a paused player is polled again', () => {
    // The idle cadence polls a paused player for hours. Every one of those
    // ticks parses a fresh, structurally identical state object, and a diff
    // that reported those objects as changed would push the full track and
    // device payload down the socket forever for no reason.
    expect(isEmptyDiff(diffPlaybackState(playing(), playing()))).toBe(true);
  });

  it('sends only progressMs on an ordinary mid-track tick', () => {
    // The case that justifies diffing at all: several times a second the only
    // thing that moved is the progress bar, and the album art URL, the device
    // list and the track metadata must not ride along with it.
    const changes = diffPlaybackState(playing(), playing({ progressMs: 15_000 }));
    expect(changes).toEqual({ progressMs: 15_000 });
  });

  it('replaces the item wholesale when the track changes', () => {
    const next = playing({
      item: { ...TRACK, id: 'track-2', title: 'Nannou' },
      progressMs: 0,
    });
    const changes = diffPlaybackState(playing(), next);
    expect(changes.item?.title).toBe('Nannou');
    expect(changes.progressMs).toBe(0);
    expect(changes.device).toBeUndefined();
  });

  it('notices artwork changing without the track id changing', () => {
    // Podcast episodes and playlist mosaics get re-arted server-side, and a
    // diff keyed on the id alone would leave the old cover on screen forever.
    const next = playing({
      item: {
        ...TRACK,
        images: [{ url: 'https://i.example/new.jpg', width: 640, height: 640 }],
      },
    });
    expect(diffPlaybackState(playing(), next).item).toBeDefined();
  });

  it('notices an image list that grew without its first entry changing', () => {
    const next = playing({ item: { ...TRACK, images: TRACK.images.slice(0, 1) } });
    expect(diffPlaybackState(playing(), next).item).toBeDefined();
  });

  it('sees through a fresh copy of an identical image list', () => {
    // Every poll rebuilds the artwork array from scratch. Comparing by
    // reference would call each of those a change and push the whole track
    // payload down the socket several times a second.
    const next = playing({ item: { ...TRACK, images: [...TRACK.images] } });
    expect(isEmptyDiff(diffPlaybackState(playing(), next))).toBe(true);
  });

  it('notices an image list of the same length whose entries moved', () => {
    const next = playing({ item: { ...TRACK, images: [...TRACK.images].reverse() } });
    expect(diffPlaybackState(playing(), next).item).toBeDefined();
  });

  it('reports a volume change as a new device rather than a nested patch', () => {
    // A volume drag changes one number inside the device; the client gets the
    // whole device back, because a nested merge is the one place it could get
    // the state subtly wrong.
    const next = playing({ device: { ...DEVICE, volumePercent: 55 } });
    expect(diffPlaybackState(playing(), next)).toEqual({ device: next.device });
  });

  it('distinguishes an absent device from a device with fewer fields', () => {
    const trimmed: Record<string, unknown> = { ...DEVICE };
    delete trimmed['supportsVolume'];
    const next = playing({ device: trimmed as unknown as PlaybackState['device'] });
    expect(diffPlaybackState(playing(), next).device).toBeDefined();
  });

  it('carries null when the last device disappears', () => {
    // Spotify answers 204 once every device goes idle. `null` here has to mean
    // "nothing is playing", never "no news", or the screen keeps showing a
    // track that stopped ten minutes ago.
    const changes = diffPlaybackState(playing(), IDLE_PLAYBACK);
    expect(changes.item).toBeNull();
    expect(changes.device).toBeNull();
    expect(changes.isPlaying).toBe(false);
  });

  it('reports every flag that moved when playback resumes elsewhere', () => {
    const next = playing({ isPlaying: false, shuffle: true, repeat: 'track' });
    expect(diffPlaybackState(playing(), next)).toEqual({
      isPlaying: false,
      shuffle: true,
      repeat: 'track',
    });
  });

  it('treats a device that gained a null-valued field as changed', () => {
    const next = playing({ device: { ...DEVICE, volumePercent: null } });
    expect(diffPlaybackState(playing(), next).device).toBeDefined();
  });

  it('round-trips: applying a diff reproduces the state it was taken from', () => {
    const next = playing({ progressMs: 90_000, repeat: 'context', item: null });
    expect(applyPlaybackDiff(playing(), diffPlaybackState(playing(), next))).toEqual(
      next,
    );
  });
});

describe('applyServerMessage', () => {
  const held: ClientState = { version: 7, state: playing() };
  const diff = (from: number, version: number): DiffMessage => ({
    type: 'diff',
    from,
    version,
    changes: { progressMs: 20_000 },
  });

  it('accepts a snapshot whatever the client was holding', () => {
    // The only way into a client's state, and therefore the only recovery
    // path: it must work from nothing and from arbitrarily stale state alike.
    const fromNothing = applyServerMessage(null, {
      type: 'snapshot',
      version: 3,
      state: playing(),
    });
    expect(isOk(fromNothing) && fromNothing.value.version).toBe(3);
  });

  it('applies a diff computed against the version the client holds', () => {
    const result = applyServerMessage(held, diff(7, 8));
    expect(isOk(result) && result.value.version).toBe(8);
    expect(isOk(result) && result.value.state.progressMs).toBe(20_000);
  });

  it('refuses a diff computed against a version the client no longer holds', () => {
    // The seam this whole protocol exists for: after a dropped frame or a
    // reconnect the client's state is arbitrarily old, and merging a diff into
    // it would produce a state that never existed — a paused player with a
    // moving progress bar, or the previous track's art under the new title.
    const result = applyServerMessage(held, diff(9, 10));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ reason: 'version-mismatch', held: 7, expected: 9 });
  });

  it('refuses a diff that arrives before any snapshot', () => {
    const result = applyServerMessage(null, diff(1, 2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('no-snapshot');
  });

  it('leaves state untouched on a matching heartbeat', () => {
    const result = applyServerMessage(held, { type: 'heartbeat', version: 7 });
    expect(isOk(result) && result.value).toBe(held);
  });

  it('detects a missed update from a heartbeat alone', () => {
    // Someone pauses from their phone, the diff is lost, and nothing else
    // changes for an hour. Without the version on the heartbeat the screen
    // would show a playing track until the next human touched something.
    const result = applyServerMessage(held, { type: 'heartbeat', version: 9 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ reason: 'version-mismatch', held: 7, expected: 9 });
  });

  it('refuses a heartbeat before any snapshot', () => {
    const result = applyServerMessage(null, { type: 'heartbeat', version: 1 });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage', () => {
  it('reads the three frames the server sends', () => {
    expect(parseServerMessage('{"type":"heartbeat","version":4}')).toEqual({
      type: 'heartbeat',
      version: 4,
    });
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'snapshot', version: 1, state: IDLE_PLAYBACK }),
      ),
    ).toEqual({ type: 'snapshot', version: 1, state: IDLE_PLAYBACK });
    expect(
      parseServerMessage(
        '{"type":"diff","version":2,"from":1,"changes":{"shuffle":true}}',
      ),
    ).toEqual({ type: 'diff', version: 2, from: 1, changes: { shuffle: true } });
  });

  it.each([
    ['not json at all', 'not json'],
    ['a bare array', '[1,2,3]'],
    ['a frame with no version', '{"type":"heartbeat"}'],
    ['a version that is not a number', '{"type":"heartbeat","version":"4"}'],
    ['a non-finite version', '{"type":"heartbeat","version":null}'],
    ['a snapshot with no state', '{"type":"snapshot","version":1}'],
    ['a diff with no base version', '{"type":"diff","version":2,"changes":{}}'],
    ['a diff with no changes', '{"type":"diff","version":2,"from":1}'],
    ['a type we do not speak', '{"type":"goodbye","version":1}'],
  ])('rejects %s', (_case, raw) => {
    // A truncated or foreign frame must be discardable. Throwing here would
    // take down a socket that is otherwise fine.
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe('parseClientMessage', () => {
  it('reads a resync request', () => {
    expect(parseClientMessage('{"type":"resync"}')).toEqual({ type: 'resync' });
  });

  it.each(['', '{}', 'null', '"resync"', '{"type":"shutdown"}'])('ignores %s', (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe('nextReconnectDelayMs', () => {
  it('retries almost immediately after the first failure', () => {
    // The usual cause is this server restarting, which takes well under a
    // second. A polite five-second first backoff is five seconds of a frozen
    // screen on a wall nobody is standing at.
    expect(nextReconnectDelayMs(1)).toBe(250);
    expect(nextReconnectDelayMs(2)).toBe(500);
    expect(nextReconnectDelayMs(3)).toBe(1_000);
  });

  it('caps rather than doubling forever', () => {
    // Wifi comes back without announcing itself; a client that has backed off
    // to minutes would leave the screen stale long after the link returned.
    expect(nextReconnectDelayMs(50)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('treats a zeroth or nonsense attempt as the first', () => {
    expect(nextReconnectDelayMs(0)).toBe(250);
    expect(nextReconnectDelayMs(-3)).toBe(250);
  });
});
