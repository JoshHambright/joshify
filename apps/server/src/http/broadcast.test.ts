import { describe, expect, it, vi } from 'vitest';
import { IDLE_PLAYBACK, type PlaybackState } from '@joshify/core';
import { createBroadcaster, type Subscriber } from './broadcast.js';
import { parseServerMessage, type ServerMessage } from './protocol.js';

const PLAYING: PlaybackState = {
  isPlaying: true,
  progressMs: 1_000,
  shuffle: false,
  repeat: 'off',
  item: {
    kind: 'track',
    id: 'track-1',
    uri: 'spotify:track:track-1',
    title: 'Xtal',
    subtitle: 'Aphex Twin',
    durationMs: 293_000,
    images: [{ url: 'https://i.example/640.jpg', width: 640, height: 640 }],
    isLocal: false,
  },
  device: {
    id: 'device-1',
    name: 'Kitchen',
    type: 'Speaker',
    isActive: true,
    volumePercent: 40,
    supportsVolume: true,
  },
};

interface Recorder extends Subscriber {
  readonly frames: ServerMessage[];
}

/** A subscriber that keeps what it was sent, decoded the way a client would. */
const recorder = (): Recorder => {
  const frames: ServerMessage[] = [];
  return {
    frames,
    send: (payload) => {
      const message = parseServerMessage(payload);
      if (message !== null) frames.push(message);
    },
  };
};

describe('subscribing', () => {
  it('sends a snapshot before subscribe returns', () => {
    // Synchronously, not on a tick: a publish landing between "registered"
    // and "snapshot sent" would give this socket a diff against a version it
    // has never seen, which is the one thing the protocol must never do.
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const client = recorder();
    broadcaster.subscribe(client);
    expect(client.frames).toEqual([{ type: 'snapshot', version: 1, state: PLAYING }]);
  });

  it('starts idle so the first paint is not a blank screen', () => {
    const client = recorder();
    createBroadcaster().subscribe(client);
    expect(client.frames[0]).toEqual({
      type: 'snapshot',
      version: 1,
      state: IDLE_PLAYBACK,
    });
  });

  it('gives a client that connects mid-session the current version', () => {
    // The reconnect case: a UI that reloads at version 4 must not be handed
    // version 1 and four diffs it has no way to ask for.
    const broadcaster = createBroadcaster();
    broadcaster.publish(PLAYING);
    broadcaster.publish({ ...PLAYING, progressMs: 2_000 });

    const client = recorder();
    broadcaster.subscribe(client);
    expect(client.frames).toEqual([
      { type: 'snapshot', version: 3, state: { ...PLAYING, progressMs: 2_000 } },
    ]);
  });
});

describe('publishing', () => {
  it('sends nothing when a poll tick changed nothing', () => {
    // A paused player is polled every few seconds for hours. Those ticks are
    // the server's business; a client that hears nothing has learned exactly
    // what an empty frame would have told it.
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const client = recorder();
    broadcaster.subscribe(client);
    client.frames.length = 0;

    expect(broadcaster.publish({ ...PLAYING })).toBe(false);
    expect(client.frames).toEqual([]);
    expect(broadcaster.getVersion()).toBe(1);
  });

  it('sends one diff, chained to the version everyone holds', () => {
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const first = recorder();
    const second = recorder();
    broadcaster.subscribe(first);
    broadcaster.subscribe(second);

    expect(broadcaster.publish({ ...PLAYING, progressMs: 4_000 })).toBe(true);
    const expected = { type: 'diff', version: 2, from: 1, changes: { progressMs: 4_000 } };
    expect(first.frames[1]).toEqual(expected);
    expect(second.frames[1]).toEqual(expected);
  });

  it('keeps the state current with nobody listening', () => {
    // The screen can be asleep or the socket down while the poller keeps
    // running; `GET /api/state` has to answer with the truth when it wakes.
    const broadcaster = createBroadcaster();
    expect(broadcaster.publish(PLAYING)).toBe(true);
    expect(broadcaster.getState()).toEqual(PLAYING);
    expect(broadcaster.getVersion()).toBe(2);
  });
});

describe('failing sockets', () => {
  it('drops a socket that throws and still serves the others', () => {
    // The real case: wifi drops, the browser goes away, and `close` has not
    // fired yet. One dead socket must not cost every other client its update.
    const onSendFailure = vi.fn();
    const broadcaster = createBroadcaster({ initialState: PLAYING, onSendFailure });
    const dead: Subscriber = {
      send: () => {
        throw new Error('WebSocket is not open');
      },
    };
    const alive = recorder();
    broadcaster.subscribe(dead);
    broadcaster.subscribe(alive);

    broadcaster.publish({ ...PLAYING, progressMs: 5_000 });
    expect(alive.frames).toHaveLength(2);
    expect(broadcaster.subscriberCount()).toBe(1);
    expect(onSendFailure).toHaveBeenCalledTimes(1);
  });

  it('drops a socket that is already dead when it subscribes', () => {
    const broadcaster = createBroadcaster();
    broadcaster.subscribe({
      send: () => {
        throw new Error('WebSocket is not open');
      },
    });
    expect(broadcaster.subscriberCount()).toBe(0);
  });
});

describe('subscription handles', () => {
  it('stops delivery once unsubscribed, twice over', () => {
    // A socket that errors and then closes unsubscribes twice; the second one
    // must not throw and must not remove a socket that reconnected since.
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const client = recorder();
    const subscription = broadcaster.subscribe(client);

    subscription.unsubscribe();
    subscription.unsubscribe();
    broadcaster.publish({ ...PLAYING, progressMs: 9_000 });

    expect(client.frames).toHaveLength(1);
    expect(broadcaster.subscriberCount()).toBe(0);
  });

  it('answers a resync with a fresh snapshot at the current version', () => {
    // What a client sends when it detects a gap. It must come back with
    // everything, not with the diff it missed, because the server does not
    // keep a history to replay.
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const client = recorder();
    const subscription = broadcaster.subscribe(client);
    broadcaster.publish({ ...PLAYING, progressMs: 7_000 });

    subscription.resync();
    expect(client.frames[2]).toEqual({
      type: 'snapshot',
      version: 2,
      state: { ...PLAYING, progressMs: 7_000 },
    });
  });
});

describe('heartbeats', () => {
  it('carries the current version to every subscriber', () => {
    const broadcaster = createBroadcaster({ initialState: PLAYING });
    const client = recorder();
    broadcaster.subscribe(client);
    broadcaster.publish({ ...PLAYING, progressMs: 3_000 });

    broadcaster.heartbeat();
    expect(client.frames[2]).toEqual({ type: 'heartbeat', version: 2 });
  });

  it('costs nothing with nobody connected', () => {
    const broadcaster = createBroadcaster();
    expect(() => {
      broadcaster.heartbeat();
    }).not.toThrow();
  });
});
