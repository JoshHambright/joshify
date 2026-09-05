/**
 * Where the bar is drawn, and what a finger on it means.
 *
 * The interpolation itself is core's (`createProgressTracker`, D-024) and is
 * deliberately not repeated here: the rule that a stale poll never rewinds the
 * bar is a property of the *state*, not of the panel, and the server reasons
 * about the same thing. What this adds is the one thing only a touchscreen has
 * — a finger currently holding the thumb somewhere the clock disagrees with.
 *
 * A drag suppresses interpolation outright. While the pointer is down the
 * position is whatever the finger says, because a thumb that keeps creeping
 * forward under a stationary finger is not a progress bar, it is a fight. On
 * release the model re-anchors at the position the user chose, so the bar
 * holds the new value through the round trip rather than snapping back to the
 * pre-seek position for the second it takes the server's optimistic state to
 * come back over the socket (D-028).
 *
 * Every instant here is a monotonic reading passed in by the caller (D-023).
 * Pure, DOM-free and clock-free, which is why it is a module rather than a
 * rune: a drag can be driven from a Node test without a pointer or a frame.
 */
import {
  createProgressTracker,
  playingItemKey,
  type PlaybackState,
  type ProgressTracker,
} from '@joshify/core';

export interface ProgressReading {
  /** Position to draw, in ms. The finger's while dragging, the clock's otherwise. */
  readonly positionMs: number;
  /** Duration of the item being tracked; 0 when nothing is playing. */
  readonly durationMs: number;
  /** The same as 0..1, for the bar's width. 0 with no item. */
  readonly fraction: number;
  /** Whether a pointer currently owns the position. */
  readonly isScrubbing: boolean;
}

/** Starts a per-frame callback and returns the function that stops it. */
export type FrameLoop = (tick: () => void) => () => void;

export interface ProgressModel {
  readonly isScrubbing: boolean;
  /** Reconcile with a freshly polled state observed at `monotonicMs`. */
  observe(state: PlaybackState, monotonicMs: number): void;
  /** What to draw at `monotonicMs`. */
  readAt(monotonicMs: number): ProgressReading;
  /** Take the position under a pointer. Ignored when there is nothing to seek. */
  beginScrub(fraction: number): void;
  /** Move the held position. Ignored when no drag is in progress. */
  moveScrub(fraction: number): void;
  /**
   * Finish a drag: returns the position to seek to and anchors the bar there,
   * or null if no drag was in progress to finish.
   */
  endScrub(monotonicMs: number): number | null;
  /** Abandon a drag without seeking — a cancelled pointer, or a track change. */
  cancelScrub(): void;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Where along the bar a pointer landed.
 *
 * A zero-width rect yields 0 rather than `NaN` or `Infinity`: an element that
 * has not been laid out yet is a state that reaches the screen (the first
 * frame after a mount), and a `NaN` seek position would be sent to Spotify.
 */
export const fractionAtX = (
  clientX: number,
  rect: { readonly left: number; readonly width: number },
): number => (rect.width <= 0 ? 0 : clamp01((clientX - rect.left) / rect.width));

/** The absolute position a fraction of the bar means, as whole ms. */
export const seekTargetMs = (fraction: number, durationMs: number): number =>
  Math.round(clamp01(fraction) * Math.max(0, durationMs));

export const createProgressModel = (
  state: PlaybackState,
  monotonicMs: number,
): ProgressModel => {
  let latest = state;
  let key = playingItemKey(state.item);
  let tracker: ProgressTracker = createProgressTracker(state, monotonicMs);
  /** The held position, 0..1, or null when no pointer owns the bar. */
  let held: number | null = null;

  const readAt = (at: number): ProgressReading => {
    const durationMs = tracker.durationMs;
    if (held !== null) {
      return {
        positionMs: seekTargetMs(held, durationMs),
        durationMs,
        fraction: held,
        isScrubbing: true,
      };
    }
    return {
      positionMs: tracker.progressAt(at),
      durationMs,
      fraction: tracker.fractionAt(at),
      isScrubbing: false,
    };
  };

  return {
    get isScrubbing() {
      return held !== null;
    },
    readAt,

    observe: (next, at) => {
      const nextKey = playingItemKey(next.item);
      // A track that changes under a held finger invalidates the drag: the
      // fraction was chosen against the old item's duration, and releasing
      // would seek the *new* one to a position nobody asked for. Dropping the
      // drag loses a gesture; honouring it jumps a track the user never
      // touched.
      if (nextKey !== key) held = null;
      key = nextKey;
      latest = next;
      tracker.observe(next, at);
    },

    beginScrub: (fraction) => {
      // Nothing playing has no position to choose, and a seek into it would be
      // a command Spotify refuses. The bar is inert rather than lying.
      if (tracker.durationMs <= 0) return;
      held = clamp01(fraction);
    },

    moveScrub: (fraction) => {
      if (held === null) return;
      held = clamp01(fraction);
    },

    endScrub: (at) => {
      if (held === null) return null;
      const positionMs = seekTargetMs(held, tracker.durationMs);
      held = null;
      // Re-anchored, not merely released: the next poll arrives up to a few
      // seconds later, and without this the bar would run from the *old*
      // position in the meantime and then jump. Rebuilding the tracker at the
      // chosen position is the whole of the optimistic hold the panel needs —
      // the server owns the real one (D-028) and echoes this value back.
      tracker = createProgressTracker({ ...latest, progressMs: positionMs }, at);
      return positionMs;
    },

    cancelScrub: () => {
      held = null;
    },
  };
};
