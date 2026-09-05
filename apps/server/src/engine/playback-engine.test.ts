import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestClock,
  DEFAULT_THEME,
  err,
  isOk,
  ok,
  type JoshifyError,
  type PanelState,
  type ThemeTokens,
} from '@joshify/core';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { createSpotifyClient } from '../spotify/client.js';
import { createSpotifyCommands } from '../spotify/commands.js';
import { createBroadcaster } from '../http/broadcast.js';
import {
  createPlaybackEngine,
  realScheduler,
  type PlaybackEngineConfig,
  type Scheduler,
} from './playback-engine.js';

/**
 * A scheduler tests drive by hand. The engine never touches a real timer, so
 * the whole loop — including the after-command burst and the boundary
 * tightening — runs in microseconds instead of minutes.
 */
const manualScheduler = () => {
  let pending: { delay: number; run: () => void } | null = null;
  const scheduler: Scheduler = (delay, run) => {
    pending = { delay, run };
    return () => {
      pending = null;
    };
  };
  return {
    scheduler,
    delay: () => pending?.delay ?? null,
    fire: () => {
      const p = pending;
      pending = null;
      p?.run();
    },
  };
};

const trackPayload = (over: Record<string, unknown> = {}) => ({
  is_playing: true,
  progress_ms: 30_000,
  shuffle_state: false,
  repeat_state: 'off',
  device: {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    is_active: true,
    volume_percent: 55,
  },
  item: {
    type: 'track',
    id: 'track-1',
    uri: 'spotify:track:track-1',
    name: 'Velocity Division',
    duration_ms: 211_000,
    artists: [{ name: 'Nitrous Cartel' }],
    album: {
      name: 'Velocity Division',
      images: [{ url: 'https://i/640', width: 640, height: 640 }],
    },
  },
  ...over,
});

/** The scheduled delay, or a useful failure rather than a null comparison. */
const delayNow = (): number => {
  const d = sched.delay();
  if (d === null) throw new Error('nothing is scheduled — is the engine started?');
  return d;
};

let spotify: FakeSpotify;
let clock: ReturnType<typeof createTestClock>;
let sched: ReturnType<typeof manualScheduler>;

const build = (
  onProblem?: (error: JoshifyError) => void,
  extra: Partial<PlaybackEngineConfig> = {},
) => {
  const client = createSpotifyClient({
    tokenSource: {
      getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
      refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
    },
    baseUrl: spotify.origin,
    sleep: () => Promise.resolve(),
  });
  const broadcaster = createBroadcaster();
  const engine = createPlaybackEngine({
    client,
    commands: createSpotifyCommands(client),
    broadcaster,
    clock,
    scheduler: sched.scheduler,
    ...(onProblem === undefined ? {} : { onProblem }),
    ...extra,
  });
  return { engine, broadcaster };
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  clock = createTestClock();
  sched = manualScheduler();
});
afterEach(async () => {
  await spotify.close();
});

describe('the poll loop', () => {
  it('polls, normalises and publishes what is playing', async () => {
    spotify.playbackState = trackPayload();
    const { engine, broadcaster } = build();

    await engine.poll();

    const state: PanelState = broadcaster.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.item?.title).toBe('Velocity Division');
    expect(state.item?.subtitle).toBe('Nitrous Cartel');
    expect(state.device?.name).toBe('Kitchen');
    expect(state.progressMs).toBe(30_000);
  });

  it('treats nothing playing as a state, not a failure', async () => {
    spotify.playbackState = null; // the fake answers 204, as Spotify does
    const { engine, broadcaster } = build();

    await engine.poll();

    expect(broadcaster.getState().item).toBeNull();
    expect(broadcaster.getState().isPlaying).toBe(false);
  });

  // A network blip must not blank the screen. The device keeps showing the last
  // truth and tries again on the normal cadence.
  it('keeps the last known state when a poll fails', async () => {
    spotify.playbackState = trackPayload();
    const problems: unknown[] = [];
    const { engine, broadcaster } = build((e) => problems.push(e));
    await engine.poll();

    spotify.failNext({ status: 503 });
    spotify.failNext({ status: 503 });
    spotify.failNext({ status: 503 });
    await engine.poll();

    expect(broadcaster.getState().item?.title).toBe('Velocity Division');
    expect(problems).toHaveLength(1);
  });

  // A malformed payload is the same class of problem as a network blip: report
  // it, keep the last truth on screen, and try again.
  it('keeps the last known state when a payload will not normalise', async () => {
    spotify.playbackState = trackPayload();
    const problems: unknown[] = [];
    const { engine, broadcaster } = build((e) => problems.push(e));
    await engine.poll();

    spotify.playbackState = { nonsense: true }; // no is_playing flag
    await engine.poll();

    expect(broadcaster.getState().item?.title).toBe('Velocity Division');
    expect(problems).toHaveLength(1);
  });

  it('re-arms itself after each poll and stops when told to', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();

    engine.start();
    await vi.waitFor(() => {
      expect(sched.delay()).not.toBeNull();
    });
    expect(sched.delay()).toBeGreaterThan(0);

    engine.stop();
    sched.fire();
    expect(sched.delay()).toBeNull();
  });

  // The boundary is the one moment playback changes on its own, so lag there
  // is the most visible failure the device can have (D-025).
  // Two loops means two polls per cadence, which is how a device talks itself
  // into a 429.
  it('ignores a second start', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();

    engine.start();
    engine.start();
    await vi.waitFor(() => {
      expect(sched.delay()).not.toBeNull();
    });
    engine.stop();

    const polls = spotify.requests.filter((r) => r.path === '/v1/me/player');
    expect(polls).toHaveLength(1);
  });

  it('polls faster near a track boundary than mid-track', async () => {
    spotify.playbackState = trackPayload({ progress_ms: 30_000 });
    const { engine } = build();
    engine.start();
    await vi.waitFor(() => {
      expect(sched.delay()).not.toBeNull();
    });
    const midTrack = delayNow();

    spotify.playbackState = trackPayload({ progress_ms: 208_000 }); // 3s left
    sched.fire(); // runs the scheduled poll, which re-arms with a new delay
    await vi.waitFor(() => {
      expect(sched.delay()).not.toBeNull();
    });
    const nearEnd = delayNow();

    engine.stop();
    expect(nearEnd).toBeLessThan(midTrack);
  });
});

describe('commands', () => {
  it('publishes the optimistic state before the network answers', async () => {
    spotify.playbackState = trackPayload();
    const { engine, broadcaster } = build();
    await engine.poll();
    expect(broadcaster.getState().isPlaying).toBe(true);

    // Not awaited: the published state must already have changed.
    const inFlight = engine.command({ change: { kind: 'pause' } });
    expect(broadcaster.getState().isPlaying).toBe(false);

    await inFlight;
  });

  it('sends the command Spotify expects', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();
    await engine.command({ change: { kind: 'shuffle', enabled: true } });

    const call = spotify.requests.find((r) => r.path === '/v1/me/player/shuffle');
    expect(call?.method).toBe('PUT');
    expect(call?.query['state']).toBe('true');
  });

  // The alternative is a control that silently lies about what the speaker did.
  it('rolls the optimistic change back when the command fails', async () => {
    spotify.playbackState = trackPayload();
    const problems: unknown[] = [];
    const { engine, broadcaster } = build((e) => problems.push(e));
    await engine.poll();

    spotify.failNext({ status: 403, body: { error: { message: 'Premium required' } } });
    const result = await engine.command({ change: { kind: 'pause' } });

    expect(isOk(result)).toBe(false);
    expect(broadcaster.getState().isPlaying).toBe(true); // back to the truth
    expect(problems).toHaveLength(1);
  });

  // Without this the burst waits out whatever long idle delay was already
  // pending, and the optimistic update sits unconfirmed for seconds (D-025).
  it('re-arms the poll immediately so the reconciling burst starts now', async () => {
    spotify.playbackState = trackPayload({ is_playing: false });
    const { engine } = build();
    engine.start();
    await vi.waitFor(() => {
      expect(sched.delay()).not.toBeNull();
    });
    const idleDelay = delayNow();

    await engine.command({ change: { kind: 'play' } });
    const afterCommand = delayNow();

    engine.stop();
    expect(afterCommand).toBeLessThan(idleDelay);
  });

  // Every arm of the dispatch, because a mis-wired one — next calling previous,
  // repeat sent to the shuffle endpoint — is invisible until someone taps it.
  it.each([
    [{ kind: 'play' } as const, 'PUT', '/v1/me/player/play', {}],
    [{ kind: 'pause' } as const, 'PUT', '/v1/me/player/pause', {}],
    [{ kind: 'next' } as const, 'POST', '/v1/me/player/next', {}],
    [{ kind: 'previous' } as const, 'POST', '/v1/me/player/previous', {}],
    [
      { kind: 'seek', positionMs: 42_000 } as const,
      'PUT',
      '/v1/me/player/seek',
      { position_ms: '42000' },
    ],
    [
      { kind: 'volume', volumePercent: 20 } as const,
      'PUT',
      '/v1/me/player/volume',
      { volume_percent: '20' },
    ],
    [
      { kind: 'shuffle', enabled: false } as const,
      'PUT',
      '/v1/me/player/shuffle',
      { state: 'false' },
    ],
    [
      { kind: 'repeat', mode: 'track' } as const,
      'PUT',
      '/v1/me/player/repeat',
      { state: 'track' },
    ],
  ])('routes %o to the right endpoint', async (change, method, path, query) => {
    spotify.playbackState = trackPayload();
    const { engine } = build();

    const result = await engine.command({ change });

    expect(isOk(result)).toBe(true);
    const call = spotify.requests.find((r) => r.path === path);
    expect(call?.method).toBe(method);
    for (const [key, value] of Object.entries(query)) {
      expect(call?.query[key]).toBe(value);
    }
  });

  it('targets a specific device when asked to', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();
    await engine.command({
      change: { kind: 'volume', volumePercent: 30 },
      target: { deviceId: 'dev-9' },
    });

    const call = spotify.requests.find((r) => r.path === '/v1/me/player/volume');
    expect(call?.query['device_id']).toBe('dev-9');
    expect(call?.query['volume_percent']).toBe('30');
  });
});

describe('reconciliation end to end', () => {
  // The real sequence: tap pause, Spotify has not applied it yet, a poll lands
  // still saying "playing". The button must not bounce back (D-028).
  it('holds the optimistic value while a poll still reports the old one', async () => {
    spotify.playbackState = trackPayload();
    const { engine, broadcaster } = build();
    await engine.poll();

    await engine.command({ change: { kind: 'pause' } });
    expect(broadcaster.getState().isPlaying).toBe(false);

    clock.advance(200); // well inside the settle window
    await engine.poll(); // the device has not obeyed yet
    expect(broadcaster.getState().isPlaying).toBe(false);
  });

  it('yields once the settle window has passed without the command landing', async () => {
    spotify.playbackState = trackPayload();
    const { engine, broadcaster } = build();
    await engine.poll();

    await engine.command({ change: { kind: 'pause' } });
    clock.advance(30_000); // far beyond any plausible device delay
    await engine.poll();

    expect(broadcaster.getState().isPlaying).toBe(true);
  });

  it('adopts a change made from another device immediately', async () => {
    spotify.playbackState = trackPayload({ shuffle_state: false });
    const { engine, broadcaster } = build();
    await engine.poll();

    await engine.command({ change: { kind: 'repeat', mode: 'track' } });
    // Someone else turned shuffle on: a value we never set, so it is not our
    // pending command failing to land and must be taken at once.
    spotify.playbackState = trackPayload({ shuffle_state: true });
    await engine.poll();

    expect(broadcaster.getState().shuffle).toBe(true);
  });
});

// The default scheduler is the one thing here that touches a real timer, so it
// gets the one test that does too.
describe('the real scheduler', () => {
  it('runs the callback and can be cancelled before it does', async () => {
    const ran: string[] = [];
    realScheduler(1, () => ran.push('kept'));
    const cancel = realScheduler(1, () => ran.push('cancelled'));
    cancel();

    await vi.waitFor(() => {
      expect(ran).toEqual(['kept']);
    });
  });
});

/**
 * The presentation half (P3-13). The timing is the whole risk here: the theme
 * legitimately lands after the track it belongs to, and a fence that is wrong
 * repaints the new album in the old album's colour.
 */
describe('the theme', () => {
  const BLUE: ThemeTokens = {
    surface: '#0d1418',
    foreground: '#eef4f6',
    accent: '#4fa8ff',
    onAccent: '#04121f',
    controlTint: '#7d94a0',
  };
  const PINK: ThemeTokens = { ...BLUE, accent: '#ff5c8a' };

  /** A presenter the test resolves by hand, so "in flight" is a real state. */
  const heldPresenter = () => {
    const pending: { key: string; resolve: (theme: ThemeTokens) => void }[] = [];
    return {
      presenter: {
        themeFor: (item: { id: string | null }) =>
          new Promise<ThemeTokens>((resolve) => {
            pending.push({ key: item.id ?? '', resolve });
          }),
      },
      pending,
      settle: async (index: number, theme: ThemeTokens) => {
        pending[index]?.resolve(theme);
        await vi.waitFor(() => {
          expect(true).toBe(true);
        });
      },
    };
  };

  it('starts neutral, and says so with a null themeFor', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();
    await engine.poll();

    expect(engine.state().theme).toEqual(DEFAULT_THEME);
    expect(engine.state().themeFor).toBeNull();
  });

  it('publishes the track first and the colour after', async () => {
    spotify.playbackState = trackPayload();
    const held = heldPresenter();
    const { engine, broadcaster } = build(undefined, { presenter: held.presenter });

    await engine.poll();

    // The title is already on screen while extraction is still running —
    // making the poll wait for a colour would be exactly backwards.
    expect(broadcaster.getState().item?.title).toBe('Velocity Division');
    expect(broadcaster.getState().theme).toEqual(DEFAULT_THEME);
    expect(held.pending).toHaveLength(1);

    await held.settle(0, BLUE);

    expect(broadcaster.getState().theme).toEqual(BLUE);
    expect(broadcaster.getState().themeFor).toBe('track-1');
  });

  it('does not re-extract for a track that has not changed', async () => {
    spotify.playbackState = trackPayload();
    const held = heldPresenter();
    const { engine } = build(undefined, { presenter: held.presenter });

    await engine.poll();
    await held.settle(0, BLUE);
    await engine.poll();
    await engine.poll();

    expect(held.pending).toHaveLength(1);
  });

  // The fence. Without it, an image that decodes slowly repaints whatever is
  // playing *now* in the colour of whatever prompted the extraction.
  it('discards a theme for a track that has already changed', async () => {
    spotify.playbackState = trackPayload();
    const held = heldPresenter();
    const { engine, broadcaster } = build(undefined, { presenter: held.presenter });
    await engine.poll();

    spotify.playbackState = trackPayload({
      item: { ...trackPayload().item, id: 'track-2', name: 'Coolant' },
    });
    await engine.poll();
    expect(held.pending).toHaveLength(2);

    // The first track's extraction finishes last. It must not win.
    await held.settle(1, PINK);
    await held.settle(0, BLUE);

    expect(broadcaster.getState().theme).toEqual(PINK);
    expect(broadcaster.getState().themeFor).toBe('track-2');
  });

  // The artwork is still on screen, dimmed. Snapping the chrome to grey while
  // the album is still showing would look like a fault.
  it('keeps the last album colour when playback stops', async () => {
    spotify.playbackState = trackPayload();
    const held = heldPresenter();
    const { engine, broadcaster } = build(undefined, { presenter: held.presenter });
    await engine.poll();
    await held.settle(0, BLUE);

    spotify.playbackState = null;
    await engine.poll();

    expect(broadcaster.getState().item).toBeNull();
    expect(broadcaster.getState().theme).toEqual(BLUE);
  });

  // A colour is the least important thing on the panel.
  it('keeps the colour it has when extraction fails', async () => {
    spotify.playbackState = trackPayload();
    const problems: unknown[] = [];
    const { engine, broadcaster } = build((e) => problems.push(e), {
      presenter: { themeFor: () => Promise.reject(new Error('decoder exploded')) },
    });

    await engine.poll();
    await vi.waitFor(() => {
      expect(problems).toHaveLength(1);
    });

    expect(broadcaster.getState().item?.title).toBe('Velocity Division');
    expect(broadcaster.getState().theme).toEqual(DEFAULT_THEME);
  });
});

describe('the Premium flag', () => {
  it('stays null until the account has been read', async () => {
    spotify.playbackState = trackPayload();
    const { engine } = build();
    await engine.poll();

    // Null, not false: accusing an account of being free before we know is the
    // confident lie D-022 exists to prevent.
    expect(engine.state().isPremium).toBeNull();
  });

  it('publishes the answer once the profile is read', async () => {
    spotify.playbackState = trackPayload();
    const { engine, broadcaster } = build(undefined, {
      readProfile: () => Promise.resolve(ok({ isPremium: true })),
    });

    engine.start();
    await vi.waitFor(() => {
      expect(broadcaster.getState().isPremium).toBe(true);
    });
    engine.stop();
  });

  it('leaves the account unclassified when the profile read fails', async () => {
    spotify.playbackState = trackPayload();
    const problems: unknown[] = [];
    const { engine } = build((e) => problems.push(e), {
      readProfile: () =>
        Promise.resolve(
          err({ kind: 'network' as const, message: 'offline', retryable: true }),
        ),
    });

    engine.start();
    await vi.waitFor(() => {
      expect(problems).toHaveLength(1);
    });
    expect(engine.state().isPremium).toBeNull();
    engine.stop();
  });
});
