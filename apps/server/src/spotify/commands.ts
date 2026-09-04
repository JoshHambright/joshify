/**
 * The write half of the player API — everything a tap on the screen issues.
 *
 * Each command is deliberately thin: build a path, maybe a JSON body, hand it
 * to the client, which owns auth, retries and the failure taxonomy. What is
 * not thin is the input checking. Spotify answers an out-of-range volume or a
 * negative seek with a flat "Player command failed", so the local error is the
 * only one that will ever name which value was wrong — and these are the
 * values a slider drag is most likely to get wrong.
 */
import {
  createError,
  err,
  ok,
  type JoshifyError,
  type RepeatMode,
  type Result,
} from '@joshify/core';
import type { SpotifyClient } from './client.js';

/** No player write returns a payload; only whether it was accepted. */
export type CommandResult = Result<void, JoshifyError>;

export interface CommandTarget {
  /**
   * Which Connect device to command. Omit to let Spotify use the active one.
   *
   * Explicit `undefined` is allowed despite `exactOptionalPropertyTypes`
   * because callers hold a device id that legitimately may not exist yet
   * (nothing is playing, no device chosen), and making every call site spread
   * conditionally to express that buys no safety.
   */
  readonly deviceId?: string | undefined;
}

/**
 * Where in the context to start.
 *
 * `position` is an index into the album or playlist; `uri` names a track
 * inside it. Spotify accepts one shape or the other, never both.
 */
export type PlayOffset = { readonly position: number } | { readonly uri: string };

export interface PlayOptions extends CommandTarget {
  /** An album or playlist URI. This is what "play this album" actually is. */
  readonly contextUri?: string | undefined;
  /** Explicit tracks to play instead of a context. */
  readonly uris?: readonly string[] | undefined;
  readonly offset?: PlayOffset | undefined;
  /** Start this far into the first item, for resuming a known position. */
  readonly positionMs?: number | undefined;
}

export interface TransferOptions {
  /** Omit to carry the current playing/paused state over to the new device. */
  readonly play?: boolean | undefined;
}

export interface SpotifyCommands {
  /** With no options, resumes whatever is already loaded. */
  readonly play: (options?: PlayOptions) => Promise<CommandResult>;
  readonly pause: (target?: CommandTarget) => Promise<CommandResult>;
  readonly next: (target?: CommandTarget) => Promise<CommandResult>;
  readonly previous: (target?: CommandTarget) => Promise<CommandResult>;
  readonly seek: (positionMs: number, target?: CommandTarget) => Promise<CommandResult>;
  /** Fails with `forbidden` on devices whose volume Spotify cannot control. */
  readonly setVolume: (
    volumePercent: number,
    target?: CommandTarget,
  ) => Promise<CommandResult>;
  readonly setShuffle: (
    enabled: boolean,
    target?: CommandTarget,
  ) => Promise<CommandResult>;
  readonly setRepeat: (
    mode: RepeatMode,
    target?: CommandTarget,
  ) => Promise<CommandResult>;
  readonly transferPlayback: (
    deviceId: string,
    options?: TransferOptions,
  ) => Promise<CommandResult>;
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
};

/** Drops absent parameters entirely — `device_id=` is not the same as omitting it. */
const withQuery = (path: string, params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
};

const rangeError = (name: string, value: number, bounds: string): JoshifyError =>
  createError('unexpected', `${name} must be ${bounds}, got ${String(value)}`);

const checkAtLeast = (name: string, value: number, min: number): JoshifyError | null =>
  Number.isInteger(value) && value >= min
    ? null
    : rangeError(name, value, `an integer >= ${String(min)}`);

const checkInRange = (
  name: string,
  value: number,
  min: number,
  max: number,
): JoshifyError | null =>
  Number.isInteger(value) && value >= min && value <= max
    ? null
    : rangeError(name, value, `an integer between ${String(min)} and ${String(max)}`);

/**
 * The combinations Spotify rejects, caught before the request goes out.
 *
 * These are all "400 Bad Request, Player command failed" on the wire, with no
 * indication of which field was at fault — and the caller cannot fix what it
 * cannot see.
 */
const checkPlayOptions = (options: PlayOptions): JoshifyError | null => {
  if (options.contextUri !== undefined && options.uris !== undefined) {
    return createError('unexpected', 'play takes either contextUri or uris, not both');
  }
  if (options.uris !== undefined && options.uris.length === 0) {
    return createError('unexpected', 'play was given an empty uris list');
  }
  if (
    options.offset !== undefined &&
    options.contextUri === undefined &&
    options.uris === undefined
  ) {
    return createError('unexpected', 'play offset needs a contextUri or uris to index');
  }
  if (options.offset !== undefined && 'position' in options.offset) {
    const invalid = checkAtLeast('offset.position', options.offset.position, 0);
    if (invalid !== null) return invalid;
  }
  if (options.positionMs !== undefined) {
    return checkAtLeast('position_ms', options.positionMs, 0);
  }
  return null;
};

export const createSpotifyCommands = (
  client: Pick<SpotifyClient, 'request'>,
): SpotifyCommands => {
  /**
   * Every player write answers `204 No Content`, which the client turns into
   * `ok(null)`. Collapsing that to `ok(undefined)` here keeps a caller from
   * ever reading meaning into a body that is guaranteed to be empty — and
   * from mistaking the empty success for a failure.
   */
  const send = async (path: string, init: RequestInit): Promise<CommandResult> => {
    const result = await client.request(path, init);
    return result.ok ? ok(undefined) : err(result.error);
  };

  /** The commands that carry nothing but an optional target device. */
  const bare = (
    path: string,
    method: string,
    to: CommandTarget,
  ): Promise<CommandResult> =>
    send(withQuery(path, { device_id: to.deviceId }), { method });

  const play = async (options: PlayOptions = {}): Promise<CommandResult> => {
    const invalid = checkPlayOptions(options);
    if (invalid !== null) return err(invalid);

    const body: Record<string, unknown> = {};
    if (options.contextUri !== undefined) body['context_uri'] = options.contextUri;
    if (options.uris !== undefined) body['uris'] = [...options.uris];
    if (options.offset !== undefined) body['offset'] = options.offset;
    if (options.positionMs !== undefined) body['position_ms'] = options.positionMs;

    const path = withQuery('/v1/me/player/play', { device_id: options.deviceId });
    // A resume sends no body at all. An empty `{}` would also work today, but
    // "change nothing" and "start this" reading identically on the wire is the
    // kind of ambiguity that makes a bad request hard to spot in a log.
    return Object.keys(body).length === 0
      ? await send(path, { method: 'PUT' })
      : await send(path, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });
  };

  const seek = async (
    positionMs: number,
    to: CommandTarget = {},
  ): Promise<CommandResult> => {
    const invalid = checkAtLeast('position_ms', positionMs, 0);
    if (invalid !== null) return err(invalid);
    return await send(
      withQuery('/v1/me/player/seek', {
        position_ms: String(positionMs),
        device_id: to.deviceId,
      }),
      { method: 'PUT' },
    );
  };

  const setVolume = async (
    volumePercent: number,
    to: CommandTarget = {},
  ): Promise<CommandResult> => {
    const invalid = checkInRange('volume_percent', volumePercent, 0, 100);
    if (invalid !== null) return err(invalid);
    // Devices that cannot be volume-controlled answer 403. That surfaces as a
    // `forbidden` error rather than being swallowed: the UI needs to know the
    // slider did nothing, so it can stop pretending it did (P2-05).
    return await send(
      withQuery('/v1/me/player/volume', {
        volume_percent: String(volumePercent),
        device_id: to.deviceId,
      }),
      { method: 'PUT' },
    );
  };

  return {
    play,
    pause: (to = {}) => bare('/v1/me/player/pause', 'PUT', to),
    next: (to = {}) => bare('/v1/me/player/next', 'POST', to),
    previous: (to = {}) => bare('/v1/me/player/previous', 'POST', to),
    seek,
    setVolume,
    setShuffle: (enabled, to = {}) =>
      send(
        withQuery('/v1/me/player/shuffle', {
          state: String(enabled),
          device_id: to.deviceId,
        }),
        { method: 'PUT' },
      ),
    setRepeat: (mode, to = {}) =>
      send(withQuery('/v1/me/player/repeat', { state: mode, device_id: to.deviceId }), {
        method: 'PUT',
      }),
    transferPlayback: (deviceId, options = {}) => {
      // The only player write that names its device in the body. `device_ids`
      // is an array for future-proofing that never arrived — Spotify rejects
      // more than one — so the signature takes exactly one id.
      const body: Record<string, unknown> = { device_ids: [deviceId] };
      if (options.play !== undefined) body['play'] = options.play;
      return send('/v1/me/player', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    },
  };
};
