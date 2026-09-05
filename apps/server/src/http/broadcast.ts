/**
 * One playback state, many watching sockets (P2-08).
 *
 * The poller hands every tick to `publish`; this decides what — if anything —
 * each connected client needs to hear about it. Three rules do the work:
 *
 *  1. A new subscriber gets a full snapshot, immediately and always.
 *  2. A change goes out as a diff against the version everyone already holds.
 *  3. A tick that changed nothing sends nothing at all.
 *
 * Rule 3 is the one worth defending. The poll cadence is the server's private
 * business (P2-03) and a paused player is polled for hours; a client that
 * hears nothing has learned exactly what a "nothing changed" frame would have
 * told it, at no cost. Liveness is a separate question with a separate answer,
 * `heartbeat`, which runs on its own interval rather than on the poll's.
 *
 * Transport-free by design: a subscriber is anything with a `send`, so the
 * whole push protocol is testable without opening a socket, and the WebSocket
 * route stays a twelve-line adapter.
 */
import { IDLE_PLAYBACK, type PlaybackState } from '@joshify/core';
import {
  diffPlaybackState,
  isEmptyDiff,
  type DiffMessage,
  type HeartbeatMessage,
  type ServerMessage,
  type SnapshotMessage,
} from '@joshify/core';

/** One connected client, seen only as somewhere to put a frame. */
export interface Subscriber {
  /**
   * Deliver one encoded frame.
   *
   * Allowed to throw: a socket can die between the close event and the next
   * broadcast, and that must not be the caller's problem.
   */
  readonly send: (payload: string) => void;
}

export interface Subscription {
  /** Send a fresh snapshot. The server's answer to a client reporting a gap. */
  readonly resync: () => void;
  /** Idempotent — a socket that errors and then closes unsubscribes twice. */
  readonly unsubscribe: () => void;
}

export interface BroadcasterOptions {
  /**
   * State before the first poll completes. Idle by default, which is what the
   * screen should show while the first `GET /me/player` is in flight.
   */
  readonly initialState?: PlaybackState | undefined;
  /** Called when a subscriber's transport throws; that subscriber is dropped. */
  readonly onSendFailure?: ((error: unknown) => void) | undefined;
}

export interface Broadcaster {
  readonly getState: () => PlaybackState;
  readonly getVersion: () => number;
  readonly subscriberCount: () => number;
  /** Registers the subscriber and sends it a snapshot before returning. */
  readonly subscribe: (subscriber: Subscriber) => Subscription;
  /** True when the state differed and a diff went out. */
  readonly publish: (state: PlaybackState) => boolean;
  readonly heartbeat: () => void;
}

/**
 * Versions start at 1 so that 0 is available to a client as "I hold nothing",
 * and are per-process: a restarted server starts over at 1. That is safe only
 * because a diff is never sent to a socket that has not been handed a snapshot
 * on that same socket first, so no client can ever meet two numbering schemes.
 */
const FIRST_VERSION = 1;

export const createBroadcaster = (options: BroadcasterOptions = {}): Broadcaster => {
  const subscribers = new Set<Subscriber>();
  let state = options.initialState ?? IDLE_PLAYBACK;
  let version = FIRST_VERSION;

  const snapshot = (): SnapshotMessage => ({ type: 'snapshot', version, state });

  /**
   * Encode once, send many. The album art URLs and device list make a snapshot
   * the largest thing this process serialises, and on a Pi doing it per
   * subscriber is work with no output.
   */
  const encode = (message: ServerMessage): string => JSON.stringify(message);

  const deliver = (subscriber: Subscriber, payload: string): void => {
    try {
      subscriber.send(payload);
    } catch (error) {
      // A dead socket takes itself out rather than aborting the broadcast:
      // one client whose wifi vanished must not cost every other client its
      // update. `close` usually gets here first; this is the race where it
      // does not.
      subscribers.delete(subscriber);
      options.onSendFailure?.(error);
    }
  };

  const broadcast = (message: ServerMessage): void => {
    if (subscribers.size === 0) return;
    const payload = encode(message);
    // Iterate a copy: `deliver` can remove entries from the live set.
    for (const subscriber of [...subscribers]) deliver(subscriber, payload);
  };

  const subscribe = (subscriber: Subscriber): Subscription => {
    subscribers.add(subscriber);
    // Synchronously, before this returns, so there is no window in which a
    // publish could send this socket a diff against a version it never saw.
    deliver(subscriber, encode(snapshot()));
    return {
      resync: () => {
        deliver(subscriber, encode(snapshot()));
      },
      unsubscribe: () => {
        subscribers.delete(subscriber);
      },
    };
  };

  const publish = (next: PlaybackState): boolean => {
    const changes = diffPlaybackState(state, next);
    if (isEmptyDiff(changes)) return false;

    const message: DiffMessage = {
      type: 'diff',
      version: version + 1,
      from: version,
      changes,
    };
    state = next;
    version += 1;
    broadcast(message);
    return true;
  };

  const heartbeat = (): void => {
    const message: HeartbeatMessage = { type: 'heartbeat', version };
    broadcast(message);
  };

  return {
    getState: () => state,
    getVersion: () => version,
    subscriberCount: () => subscribers.size,
    subscribe,
    publish,
    heartbeat,
  };
};
