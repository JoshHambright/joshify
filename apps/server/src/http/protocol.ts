/**
 * The wire contract between the server and the kiosk UI.
 *
 * Both halves of it live here on purpose. The rules that keep a client's copy
 * of the state honest — a diff only applies to the version it was computed
 * against, a snapshot is the only way to start — are worth exactly nothing if
 * the sender and the receiver each implement them from prose. So the sender's
 * `diffPlaybackState` and the receiver's `applyServerMessage` are written
 * against each other, in one file, with one set of tests.
 *
 * Everything here is pure: no sockets, no timers, no Fastify.
 */
import { err, ok, type PlaybackState, type Result } from '@joshify/core';

/**
 * A shallow partial of `PlaybackState`: a key that is present replaces the
 * client's value, a key that is absent means "unchanged".
 *
 * Absent-means-unchanged is why this cannot be a `Partial<PlaybackState>` the
 * client spreads blindly — `item` and `device` are legitimately `null`, and
 * `null` here means "nothing is playing", never "no news".
 */
export type PlaybackDiff = {
  readonly [K in keyof PlaybackState]?: PlaybackState[K];
};

/** The full state, and the version it is. The only way into a client's state. */
export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly version: number;
  readonly state: PlaybackState;
}

export interface DiffMessage {
  readonly type: 'diff';
  /** The version a client holds after applying this. */
  readonly version: number;
  /**
   * The version this was computed against.
   *
   * Carried explicitly rather than implied by `version - 1` so that a client
   * checks an equality it was *given* instead of arithmetic it inferred; the
   * check then survives any later change to how versions are allocated.
   */
  readonly from: number;
  readonly changes: PlaybackDiff;
}

/**
 * Proof of life, carrying the version the server believes the client holds.
 *
 * Silence on a WebSocket is indistinguishable from a dropped wifi link — the
 * browser's socket stays `OPEN` for minutes after the other end has gone — and
 * on a wall-mounted screen nobody is going to click anything to find out. The
 * version rides along because it costs nothing and turns the heartbeat into a
 * checksum: a client that missed a diff learns about it within one interval
 * instead of at the next state change, which on a paused player is never.
 */
export interface HeartbeatMessage {
  readonly type: 'heartbeat';
  readonly version: number;
}

export type ServerMessage = SnapshotMessage | DiffMessage | HeartbeatMessage;

/** Ask for a fresh snapshot. The client's one move when it detects a gap. */
export interface ResyncMessage {
  readonly type: 'resync';
}

export type ClientMessage = ResyncMessage;

/** What a client holds: a state and the version stamp that state carries. */
export interface ClientState {
  readonly version: number;
  readonly state: PlaybackState;
}

export interface ProtocolGap {
  /**
   * `no-snapshot` — a diff or heartbeat arrived before any snapshot did.
   * `version-mismatch` — the client's version is not the one the server
   * computed against, so at least one message was lost.
   */
  readonly reason: 'no-snapshot' | 'version-mismatch';
  /** The version the client holds, or null when it holds nothing. */
  readonly held: number | null;
  /** The version the message expected it to hold. */
  readonly expected: number;
}

/**
 * Structural equality over the JSON-shaped values a `PlaybackState` is made of.
 *
 * Reference equality is useless for this: every poll parses a fresh response
 * into brand new objects, so `!==` would report the album art and the device
 * list as changed several times a second — which is the entire cost diffing
 * exists to avoid.
 */
const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((entry, index) => sameValue(entry, right[index]))
    );
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (left === null || right === null) return false;

  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && sameValue(a[key], b[key]));
};

/**
 * What changed between two states.
 *
 * `item` and `device` are replaced wholesale rather than diffed field by
 * field. A track change rewrites every field of the item anyway, so a nested
 * diff would save a few dozen bytes on the rare message and add a merge path
 * — the one place a client can go subtly wrong — to every message.
 */
export const diffPlaybackState = (
  from: PlaybackState,
  to: PlaybackState,
): PlaybackDiff => {
  const changes: { -readonly [K in keyof PlaybackState]?: PlaybackState[K] } = {};
  if (from.isPlaying !== to.isPlaying) changes.isPlaying = to.isPlaying;
  if (from.progressMs !== to.progressMs) changes.progressMs = to.progressMs;
  if (from.shuffle !== to.shuffle) changes.shuffle = to.shuffle;
  if (from.repeat !== to.repeat) changes.repeat = to.repeat;
  if (!sameValue(from.item, to.item)) changes.item = to.item;
  if (!sameValue(from.device, to.device)) changes.device = to.device;
  return changes;
};

export const isEmptyDiff = (diff: PlaybackDiff): boolean =>
  Object.keys(diff).length === 0;

export const applyPlaybackDiff = (
  state: PlaybackState,
  changes: PlaybackDiff,
): PlaybackState => ({ ...state, ...changes });

/**
 * Fold one server message into what the client holds.
 *
 * This is the guard the task calls for: applying a diff to the wrong state is
 * not a mistake a caller can make, because the caller never gets to do the
 * applying. A mismatch comes back as an `Err`, and the only sensible reaction
 * to it is to ask for a snapshot — which is also the reaction to holding
 * nothing at all, so there is exactly one recovery path to get right.
 */
export const applyServerMessage = (
  held: ClientState | null,
  message: ServerMessage,
): Result<ClientState, ProtocolGap> => {
  if (message.type === 'snapshot') {
    return ok({ version: message.version, state: message.state });
  }
  const expected = message.type === 'diff' ? message.from : message.version;
  if (held === null) {
    return err({ reason: 'no-snapshot', held: null, expected });
  }
  if (held.version !== expected) {
    return err({ reason: 'version-mismatch', held: held.version, expected });
  }
  if (message.type === 'heartbeat') return ok(held);
  return ok({
    version: message.version,
    state: applyPlaybackDiff(held.state, message.changes),
  });
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * Read a frame the server sent, or `null` if it is not one of ours.
 *
 * Only the envelope is validated — the version stamps and the discriminator,
 * which is what every recovery decision is made from. The `state` inside a
 * snapshot is not re-validated field by field: it was built by the normaliser
 * (P2-01) from a payload that was already checked once, and duplicating that
 * here would mean two definitions of a valid state that can drift apart.
 */
export const parseServerMessage = (raw: string): ServerMessage | null => {
  const body = asRecord(parseJson(raw));
  if (body === null) return null;
  const version = body['version'];
  if (typeof version !== 'number' || !Number.isFinite(version)) return null;

  if (body['type'] === 'heartbeat') return { type: 'heartbeat', version };
  if (body['type'] === 'snapshot') {
    const state = asRecord(body['state']);
    if (state === null) return null;
    return { type: 'snapshot', version, state: state as unknown as PlaybackState };
  }
  if (body['type'] === 'diff') {
    const from = body['from'];
    const changes = asRecord(body['changes']);
    if (typeof from !== 'number' || changes === null) return null;
    return { type: 'diff', version, from, changes };
  }
  return null;
};

/**
 * Read a frame a client sent.
 *
 * Returns `null` for anything unrecognised rather than throwing: a stray or
 * truncated frame is not a reason to tear down the socket, and tearing it down
 * would blank a screen that is otherwise working perfectly.
 */
export const parseClientMessage = (raw: string): ClientMessage | null => {
  const body = asRecord(parseJson(raw));
  return body !== null && body['type'] === 'resync' ? { type: 'resync' } : null;
};

/** First reconnect wait, doubling per consecutive failure. */
export const RECONNECT_BASE_DELAY_MS = 250;

/** Ceiling on that doubling. */
export const RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * How long a client should wait before its next reconnect attempt.
 *
 * The first retry is fast because the overwhelmingly common cause is the
 * server process restarting, which takes well under a second — waiting a
 * polite five seconds for that leaves a visibly frozen screen on a wall. The
 * tail is capped rather than doubling forever because the other common cause
 * is wifi, which comes back without warning and needs the client to still be
 * trying when it does.
 */
export const nextReconnectDelayMs = (consecutiveFailures: number): number => {
  const attempt = Math.max(1, Math.trunc(consecutiveFailures));
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
};
