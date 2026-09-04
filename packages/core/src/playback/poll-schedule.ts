/**
 * How long to wait before the next `GET /me/player`.
 *
 * Spotify has no push channel for playback state, so the only way to notice
 * that someone hit skip on their phone is to ask again. Asking constantly is
 * the obvious fix and the wrong one: the Web API rate limit is a rolling
 * window over *all* of this app's requests, and a device that burns it on
 * idle polling has nothing left for the commands the user actually taps.
 *
 * So the cadence tracks how likely the state is to have changed on its own.
 * Nothing playing changes only when a human does something elsewhere; a
 * playing track changes by itself exactly once, at its boundary, and that is
 * the moment where lag is most visible — the screen still showing the old
 * cover art is the failure users report. Progress itself is not a reason to
 * poll at all, because it is interpolated locally (P2-04).
 *
 * Pure: no timers, no clock. The caller owns scheduling and passes back what
 * it knows.
 */
import type { PlaybackState } from './state.js';

export interface PollScheduleOptions {
  /**
   * Hard floor on every delay. A bug upstream — a mis-parsed duration, a
   * negative elapsed time, an options object full of zeroes — must not be able
   * to turn the poll loop into a request flood that gets the app 429'd.
   */
  readonly floorMs?: number;
  /** Delay used while a just-issued command is still being reconciled. */
  readonly afterCommandMs?: number;
  /**
   * How long a command keeps the fast cadence. A Connect device does not
   * apply a command the instant the write returns 204 — the state we read
   * back can still be the pre-command one for a few hundred milliseconds —
   * so one quick poll is not reliably enough to confirm an optimistic update.
   */
  readonly commandWindowMs?: number;
  /** Paused, idle, or no active device: nothing changes without a human. */
  readonly idleMs?: number;
  /** Playing, mid-track: watching only for changes made somewhere else. */
  readonly playingMs?: number;
  /** How close to the end of a track counts as approaching the boundary. */
  readonly boundaryWindowMs?: number;
  /** Cadence inside that window. */
  readonly boundaryMs?: number;
}

/**
 * Defaults sized against the rate limit rather than against how snappy they
 * feel in isolation: mid-track this is 20 requests a minute, and the boundary
 * burst adds ten more per track, which leaves the limit with plenty of room
 * for command traffic. Idle polling is the one that runs unattended for hours,
 * so it is the slowest.
 */
export const DEFAULT_POLL_SCHEDULE: Required<PollScheduleOptions> = {
  floorMs: 250,
  afterCommandMs: 400,
  commandWindowMs: 1_500,
  idleMs: 5_000,
  playingMs: 3_000,
  boundaryWindowMs: 10_000,
  boundaryMs: 1_000,
};

export interface PollContext {
  /**
   * Monotonic milliseconds since the last user command was issued, or omitted
   * when no command is outstanding.
   *
   * Monotonic (D-023): a wall-clock difference here would go negative — and
   * silently disable the reconciliation burst — the first time the Pi 5 gets a
   * network and steps its clock.
   */
  readonly msSinceCommand?: number;
}

export const nextPollDelayMs = (
  state: PlaybackState,
  context: PollContext = {},
  options: PollScheduleOptions = {},
): number => {
  const tuning = { ...DEFAULT_POLL_SCHEDULE, ...options };
  const floor = (delay: number): number => Math.max(tuning.floorMs, delay);

  const sinceCommand = context.msSinceCommand;
  if (sinceCommand !== undefined && sinceCommand < tuning.commandWindowMs) {
    return floor(tuning.afterCommandMs);
  }

  // An inactive or absent device counts as idle even when the payload claims
  // `is_playing`: nothing is advancing, so the only thing that can change the
  // state is a command, and a command already has its own cadence above.
  const item = state.item;
  const device = state.device;
  if (item === null || device === null || !device.isActive || !state.isPlaying) {
    return floor(tuning.idleMs);
  }

  const remainingMs = item.durationMs - state.progressMs;
  // Already past the end: Spotify's `progress_ms` is sampled on the device and
  // arrives a round trip late, so between polls the interpolated position
  // routinely runs past the duration. The boundary is behind us, the next poll
  // is the one that reveals the new track, and it should not be delayed.
  if (remainingMs <= 0) return tuning.floorMs;

  const target =
    remainingMs <= tuning.boundaryWindowMs ? tuning.boundaryMs : tuning.playingMs;

  // Never schedule past the boundary itself — landing after it is exactly the
  // lag this whole function exists to avoid. The floor still wins over this:
  // in the last quarter-second of a track the request would not complete
  // before the boundary anyway, so there is nothing to be gained by racing it.
  return floor(Math.min(target, remainingMs));
};
