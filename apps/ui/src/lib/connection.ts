/**
 * The client's half of the state protocol: one socket, one held state, and one
 * recovery path.
 *
 * This is deliberately not a Svelte component, a rune, or anything that needs a
 * DOM. It implements the Svelte store contract by hand — `subscribe` returning
 * an unsubscribe — so `$connection` works in a template while the whole thing
 * stays testable in plain Node with a fake socket. The reconnect timing is the
 * part most likely to be wrong, and it is not testable at all if it can only be
 * exercised inside a mounted component.
 *
 * Everything with a schedule attached is injected, for the same reason the
 * engine injects its scheduler (D-042): backoff is asserted as a value rather
 * than waited out.
 */
import {
  applyServerMessage,
  parseServerMessage,
  type ClientState,
  type PlaybackState,
  type ProtocolGap,
} from '@joshify/core';

/** What the UI shows about the link itself: a lamp, not a modal (SCREENS.md). */
export type LinkStatus = 'connecting' | 'live' | 'reconnecting';

export interface ConnectionState {
  readonly link: LinkStatus;
  /** The last state we hold. Never null after the first snapshot — and never
   *  cleared on a drop, because the screen keeps showing the last truth. */
  readonly state: PlaybackState | null;
  /** The version stamp `state` carries, or null before the first snapshot. */
  readonly version: number | null;
  /**
   * Consecutive failed connection attempts. Surfaced so the status rail can
   * distinguish "a blip" from "this has been down for a minute".
   */
  readonly attempt: number;
}

/** The bits of `WebSocket` this store touches. Narrow enough to fake honestly. */
export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Cancels a pending scheduled call. */
export type CancelScheduled = () => void;
export type Scheduler = (delayMs: number, run: () => void) => CancelScheduled;

const realScheduler: Scheduler = (delayMs, run) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

export interface ConnectionConfig {
  readonly url: string;
  readonly socket: SocketFactory;
  readonly scheduler?: Scheduler | undefined;
  /**
   * Reported when the client detects it has fallen behind. The store already
   * recovers on its own; this exists so a gap is visible in logs rather than
   * being silently papered over.
   */
  readonly onGap?: ((gap: ProtocolGap) => void) | undefined;
}

/**
 * Backoff for a device nobody is standing next to.
 *
 * The server is on loopback: if it is down it is either restarting (back in
 * about a second) or gone until someone intervenes. So the first few retries
 * are fast enough to be invisible, and the ceiling is low enough that a screen
 * left alone recovers on its own within seconds of the server returning —
 * a ten-minute backoff would be technically polite and practically useless.
 */
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export const reconnectDelayMs = (attempt: number): number => {
  const index = Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1;
  return RECONNECT_DELAYS_MS[index] ?? 5_000;
};

export interface Connection {
  /** The Svelte store contract: called immediately, then on every change. */
  readonly subscribe: (run: (value: ConnectionState) => void) => () => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly current: () => ConnectionState;
}

export const createConnection = (config: ConnectionConfig): Connection => {
  const schedule = config.scheduler ?? realScheduler;
  const subscribers = new Set<(value: ConnectionState) => void>();

  let held: ClientState | null = null;
  let socket: SocketLike | null = null;
  let cancelRetry: CancelScheduled | null = null;
  let wanted = false;
  let attempt = 0;
  let link: LinkStatus = 'connecting';

  const snapshotOf = (): ConnectionState => ({
    link,
    state: held?.state ?? null,
    version: held?.version ?? null,
    attempt,
  });

  const publish = (): void => {
    const value = snapshotOf();
    for (const run of subscribers) run(value);
  };

  const resync = (): void => {
    socket?.send(JSON.stringify({ type: 'resync' }));
  };

  const receive = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const message = parseServerMessage(raw);
    // A frame we cannot read is not a reason to tear down a working socket —
    // the server's own parser takes the same view (protocol.ts).
    if (message === null) return;

    const next = applyServerMessage(held, message);
    if (!next.ok) {
      config.onGap?.(next.error);
      // One recovery path: ask for a snapshot. Deliberately not a reconnect —
      // the socket is fine, it is our copy of the state that is stale.
      resync();
      return;
    }
    held = next.value;
    publish();
  };

  const connect = (): void => {
    if (!wanted) return;
    const active = config.socket(config.url);
    socket = active;

    active.onopen = () => {
      attempt = 0;
      link = 'live';
      // Ask for a fresh snapshot rather than trusting what we held across a
      // drop: the server sends one on connect anyway, and asking costs one
      // frame while guessing costs a wrong screen (P2-09).
      resync();
      publish();
    };
    active.onmessage = (event) => {
      receive(event.data);
    };
    active.onerror = () => {
      // Left to `onclose`: browsers fire error then close for the same failure,
      // and retrying from both schedules two reconnects for one drop.
    };
    active.onclose = () => {
      if (socket !== active) return; // a close from a socket we already replaced
      socket = null;
      if (!wanted) return;
      attempt += 1;
      link = 'reconnecting';
      publish();
      cancelRetry = schedule(reconnectDelayMs(attempt), connect);
    };
  };

  return {
    subscribe: (run) => {
      subscribers.add(run);
      run(snapshotOf());
      return () => {
        subscribers.delete(run);
      };
    },
    open: () => {
      if (wanted) return;
      wanted = true;
      attempt = 0;
      link = 'connecting';
      publish();
      connect();
    },
    close: () => {
      wanted = false;
      cancelRetry?.();
      cancelRetry = null;
      const active = socket;
      socket = null;
      active?.close();
    },
    current: snapshotOf,
  };
};
