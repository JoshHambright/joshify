/**
 * Where the progress bar is *right now*, between polls.
 *
 * Polling runs every few seconds (P2-03) but the bar redraws at display
 * refresh rate, so almost every frame it draws is a local extrapolation:
 * the last position Spotify reported, plus the time elapsed since it was
 * reported. No network call is involved in asking.
 *
 * That elapsed time comes from `Clock.monotonic()` and nothing else (D-023).
 * The Pi 5 has no real-time clock: it boots believing an arbitrary past
 * instant and steps years forward the moment it reaches a network. A bar
 * driven by wall-clock differences would leap to the end of the track at that
 * moment, and every later NTP correction would nudge it by a few hundred
 * milliseconds in whichever direction it pleased. Every reading this module
 * takes is therefore named `monotonicMs`, and passing a wall-clock timestamp
 * for one is a bug even though the types cannot tell the difference.
 */
import type { PlaybackState } from './state.js';
import { playingItemKey } from './item-key.js';

export interface ProgressTrackerOptions {
  /**
   * How far behind the interpolated position a poll may report before it is
   * believed to be a real seek rather than ordinary lag. See `observe`.
   */
  readonly rewindToleranceMs?: number;
}

/**
 * Comfortably above a slow round trip plus Spotify's own coarse position
 * reporting, and comfortably below any seek a human performs — dragging the
 * scrubber moves whole seconds, and the skip-back button restarts a track.
 */
export const DEFAULT_REWIND_TOLERANCE_MS = 1_500;

export interface ProgressTracker {
  /** Duration of the item being tracked; 0 when nothing is playing. */
  readonly durationMs: number;
  readonly isPlaying: boolean;
  /** Position at `monotonicMs`, clamped to `[0, durationMs]`. */
  progressAt(monotonicMs: number): number;
  /** The same thing as 0..1, for anything drawing a bar. 0 with no item. */
  fractionAt(monotonicMs: number): number;
  /** Reconcile with a freshly polled state observed at `monotonicMs`. */
  observe(state: PlaybackState, monotonicMs: number): void;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

export const createProgressTracker = (
  state: PlaybackState,
  monotonicMs: number,
  options: ProgressTrackerOptions = {},
): ProgressTracker => {
  const rewindToleranceMs = options.rewindToleranceMs ?? DEFAULT_REWIND_TOLERANCE_MS;

  let key = playingItemKey(state.item);
  let durationMs = state.item?.durationMs ?? 0;
  let isPlaying = state.isPlaying;
  let anchorMs = clamp(state.progressMs, durationMs);
  let anchoredAt = monotonicMs;

  const progressAt = (at: number): number => {
    // Paused is frozen: the position is whatever it was when the pause was
    // observed, however long ago that was.
    const elapsed = isPlaying ? Math.max(0, at - anchoredAt) : 0;
    // Clamped because a track that ends between polls would otherwise keep
    // counting past its own duration and push the bar off the end of its
    // track — the next poll is what supplies the following item.
    return clamp(anchorMs + elapsed, durationMs);
  };

  return {
    get durationMs() {
      return durationMs;
    },
    get isPlaying() {
      return isPlaying;
    },
    progressAt,
    fractionAt: (at: number) => (durationMs > 0 ? progressAt(at) / durationMs : 0),

    /**
     * A poll almost always reports a position slightly *behind* the one we are
     * drawing: `progress_ms` is sampled on the playing device before the
     * response spends a few hundred milliseconds crossing the network, so by
     * the time we read it, it is that old. Snapping to it would make the bar
     * twitch backwards on every single poll, which reads as a bug even though
     * the data is correct.
     *
     * So a small backwards discrepancy on the same item is *held*: the
     * interpolated position stands and becomes the new anchor. The error it
     * preserves is bounded by the round trip and self-corrects as soon as the
     * true position catches up, whereas a visible rewind is not something the
     * eye forgives.
     *
     * Anything further back than the tolerance is taken at face value, because
     * that is a real seek or a restart and refusing to follow it would leave
     * the bar lying about where playback actually is. A new item resets
     * outright, and a position ahead of ours is simply adopted — we were
     * behind, and jumping forward is what a listener expects after a skip.
     */
    observe: (next: PlaybackState, at: number) => {
      const nextKey = playingItemKey(next.item);
      const nextDurationMs = next.item?.durationMs ?? 0;
      const reportedMs = clamp(next.progressMs, nextDurationMs);
      const interpolatedMs = progressAt(at);

      const hold =
        nextKey !== null &&
        nextKey === key &&
        reportedMs < interpolatedMs &&
        interpolatedMs - reportedMs <= rewindToleranceMs;

      key = nextKey;
      durationMs = nextDurationMs;
      isPlaying = next.isPlaying;
      anchorMs = hold ? interpolatedMs : reportedMs;
      anchoredAt = at;
    },
  };
};
