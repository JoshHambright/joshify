import { beforeEach, describe, expect, it } from 'vitest';
import { IDLE_PANEL, type PanelState, type ServerMessage } from '@joshify/core';
import {
  createConnection,
  reconnectDelayMs,
  type ConnectionState,
  type Scheduler,
  type SocketLike,
} from './connection.js';

/**
 * A socket the test opens, drops and feeds by hand. The store only ever sees
 * the four handlers a real `WebSocket` gives it, so nothing here is a
 * convenience the production path does not have.
 */
const fakeSocket = () => {
  const sent: string[] = [];
  let closed = false;
  const socket: SocketLike = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    open: () => socket.onopen?.(),
    drop: () => socket.onclose?.(),
    deliver: (message: ServerMessage | string) => {
      socket.onmessage?.({
        data: typeof message === 'string' ? message : JSON.stringify(message),
      });
    },
  };
};

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

const playing = (over: Partial<PanelState> = {}): PanelState => ({
  ...IDLE_PANEL,
  isPlaying: true,
  progressMs: 30_000,
  ...over,
});

let sockets: ReturnType<typeof fakeSocket>[];
let sched: ReturnType<typeof manualScheduler>;

const build = (onGap?: (gap: unknown) => void) => {
  const connection = createConnection({
    url: 'ws://127.0.0.1:8080/ws',
    socket: () => {
      const next = fakeSocket();
      sockets.push(next);
      return next.socket;
    },
    scheduler: sched.scheduler,
    ...(onGap === undefined ? {} : { onGap }),
  });
  return connection;
};

/** The socket the store is currently using. */
const live = () => {
  const last = sockets.at(-1);
  if (last === undefined) throw new Error('no socket was opened');
  return last;
};

beforeEach(() => {
  sockets = [];
  sched = manualScheduler();
});

describe('the connection store', () => {
  it('gives a subscriber the current value immediately', () => {
    const connection = build();
    const seen: ConnectionState[] = [];
    connection.subscribe((v) => seen.push(v));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.link).toBe('connecting');
    expect(seen[0]?.state).toBeNull();
  });

  it('stops calling a subscriber that has unsubscribed', () => {
    const connection = build();
    const seen: ConnectionState[] = [];
    const off = connection.subscribe((v) => seen.push(v));
    off();

    connection.open();
    live().open();

    expect(seen).toHaveLength(1);
  });

  it('holds a snapshot and reports the link as live', () => {
    const connection = build();
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });

    expect(connection.current().link).toBe('live');
    expect(connection.current().version).toBe(4);
    expect(connection.current().state?.isPlaying).toBe(true);
  });

  it('applies a diff onto the version it was computed against', () => {
    const connection = build();
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });
    live().deliver({ type: 'diff', version: 5, from: 4, changes: { isPlaying: false } });

    expect(connection.current().version).toBe(5);
    expect(connection.current().state?.isPlaying).toBe(false);
    expect(connection.current().state?.progressMs).toBe(30_000); // untouched
  });

  // The socket is fine; our copy of the state is stale. Reconnecting would
  // blank the screen to fix a problem one frame can fix.
  it('asks for a snapshot rather than reconnecting when it falls behind', () => {
    const gaps: unknown[] = [];
    const connection = build((g) => gaps.push(g));
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });

    live().deliver({ type: 'diff', version: 9, from: 8, changes: { isPlaying: false } });

    expect(gaps).toHaveLength(1);
    expect(connection.current().state?.isPlaying).toBe(true); // unchanged
    expect(sockets).toHaveLength(1); // no reconnect
    expect(live().sent.filter((s) => s.includes('resync'))).toHaveLength(2); // open + gap
  });

  // A heartbeat's whole job: tell a paused client it missed something, when no
  // state change is coming to tell it.
  it('detects a missed message from a heartbeat alone', () => {
    const gaps: unknown[] = [];
    const connection = build((g) => gaps.push(g));
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });

    live().deliver({ type: 'heartbeat', version: 7 });

    expect(gaps).toHaveLength(1);
    expect(connection.current().version).toBe(4);
  });

  it('leaves the held version alone on a matching heartbeat', () => {
    const connection = build();
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });
    live().deliver({ type: 'heartbeat', version: 4 });

    expect(connection.current().version).toBe(4);
    expect(connection.current().link).toBe('live');
  });

  // A truncated or foreign frame is not worth tearing down a working socket.
  it.each(['not json at all', '{"type":"nonsense","version":1}', '{"version":"four"}'])(
    'ignores an unreadable frame (%s)',
    (frame) => {
      const connection = build();
      connection.open();
      live().open();
      live().deliver({ type: 'snapshot', version: 4, state: playing() });

      live().deliver(frame);

      expect(connection.current().version).toBe(4);
      expect(sockets).toHaveLength(1);
    },
  );

  it('ignores a frame that is not a string', () => {
    const connection = build();
    connection.open();
    live().open();
    live().socket.onmessage?.({ data: { type: 'snapshot' } });

    expect(connection.current().state).toBeNull();
  });
});

describe('reconnecting', () => {
  // The screen keeps showing the last truth. Blanking it is never the right
  // answer to a dropped packet (SCREENS.md).
  it('keeps the last state on screen while the link is down', () => {
    const connection = build();
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });

    live().drop();

    expect(connection.current().link).toBe('reconnecting');
    expect(connection.current().state?.isPlaying).toBe(true);
  });

  it('backs off further on each consecutive failure', () => {
    const connection = build();
    connection.open();

    live().drop();
    const first = sched.delay();
    sched.fire();
    live().drop();
    const second = sched.delay();

    expect(first).toBe(250);
    expect(second).toBe(500);
    expect(connection.current().attempt).toBe(2);
  });

  it('resets the backoff once a connection succeeds', () => {
    const connection = build();
    connection.open();
    live().drop();
    sched.fire();
    live().drop();
    sched.fire();

    live().open();
    expect(connection.current().attempt).toBe(0);

    live().drop();
    expect(sched.delay()).toBe(250);
  });

  it('caps the delay so an unattended screen still recovers on its own', () => {
    expect(reconnectDelayMs(1)).toBe(250);
    expect(reconnectDelayMs(5)).toBe(5_000);
    expect(reconnectDelayMs(400)).toBe(5_000);
    expect(reconnectDelayMs(0)).toBe(250); // never negative-indexes
  });

  it('asks for a fresh snapshot on every reconnect', () => {
    const connection = build();
    connection.open();
    live().open();
    live().deliver({ type: 'snapshot', version: 4, state: playing() });
    live().drop();
    sched.fire();
    live().open();

    expect(sockets).toHaveLength(2);
    expect(live().sent).toContain(JSON.stringify({ type: 'resync' }));
    expect(connection.current().link).toBe('live');
  });

  // Browsers fire error and close for the same failure. Retrying from both
  // schedules two reconnects for one drop.
  it('does not schedule a second reconnect for an error before its close', () => {
    const connection = build();
    connection.open();

    live().socket.onerror?.();
    expect(sched.delay()).toBeNull();

    live().drop();
    expect(sched.delay()).toBe(250);
    expect(connection.current().attempt).toBe(1);
  });

  it('does not reconnect after close() and does not reopen twice', () => {
    const connection = build();
    connection.open();
    connection.open(); // idempotent
    expect(sockets).toHaveLength(1);

    const active = live();
    connection.close();
    expect(active.isClosed()).toBe(true);

    active.drop();
    expect(sched.delay()).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  // A socket that closes after we have already replaced it must not schedule a
  // retry against the one that is working.
  it('ignores a close from a socket it has already replaced', () => {
    const connection = build();
    connection.open();
    const stale = live();
    stale.drop();
    sched.fire();
    live().open();

    stale.drop();

    expect(connection.current().link).toBe('live');
    expect(sched.delay()).toBeNull();
  });
});
