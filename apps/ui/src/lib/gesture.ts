/**
 * Swipe-to-dismiss, as arithmetic.
 *
 * The plate grows to hold whatever you are doing and shrinks back when you are
 * done (SCREENS.md). There is a `Done` button for that, and on a touchscreen a
 * button is the slowest way to say it — a downward flick is how every phone
 * has dismissed a sheet for a decade, and a panel that ignores it feels like a
 * web page.
 *
 * The decisions live here rather than in the component for the usual reason:
 * a threshold that is wrong by 30px, or a fling that only registers when slow,
 * is invisible in a screenshot and obvious in the hand. Both are numbers, and
 * numbers can be asserted.
 */

/** A pointer position and the moment it was sampled. */
export interface SwipeSample {
  readonly y: number;
  readonly atMs: number;
}

export interface SwipeState {
  readonly start: SwipeSample;
  readonly latest: SwipeSample;
}

/**
 * Far enough that it cannot be a stray touch while reading, near enough that
 * it does not need a whole-screen drag. About a thumb's comfortable travel.
 */
export const DISMISS_DISTANCE_PX = 96;

/**
 * A flick: short, fast, and over before it has travelled far. Below this it is
 * a drag, and a drag has to meet the distance instead.
 */
export const FLING_VELOCITY_PX_PER_MS = 0.5;

/** A fling still has to be a deliberate movement, not a twitch. */
export const FLING_MIN_DISTANCE_PX = 24;

/** How far down the pointer has travelled. Negative when it went up. */
export const swipeDistance = (state: SwipeState): number =>
  state.latest.y - state.start.y;

/**
 * Pixels per millisecond, downward.
 *
 * A zero-duration sample would divide by zero — which produces `Infinity`, and
 * `Infinity > threshold` is true, so every instantaneous tap would read as a
 * fling. Guarded to zero instead: a gesture with no elapsed time has no
 * measured speed, and pretending otherwise dismisses the screen on a tap.
 */
export const swipeVelocity = (state: SwipeState): number => {
  const elapsed = state.latest.atMs - state.start.atMs;
  if (elapsed <= 0) return 0;
  return swipeDistance(state) / elapsed;
};

/**
 * Whether releasing here should dismiss.
 *
 * Two ways to qualify, because the two natural gestures are different: a slow
 * deliberate drag that goes far enough, or a quick flick that does not.
 */
export const shouldDismiss = (state: SwipeState): boolean => {
  const distance = swipeDistance(state);
  if (distance >= DISMISS_DISTANCE_PX) return true;
  return (
    distance >= FLING_MIN_DISTANCE_PX && swipeVelocity(state) >= FLING_VELOCITY_PX_PER_MS
  );
};

/**
 * How far the surface should have moved, given the pointer.
 *
 * Upward drag is resisted rather than followed: the plate has nowhere to go up,
 * and letting it travel there would promise a gesture that does nothing. A
 * little movement is better than none, because a surface that ignores the
 * finger entirely reads as frozen.
 */
export const RUBBER_BAND = 0.25;

export const swipeOffset = (state: SwipeState): number => {
  const distance = swipeDistance(state);
  return distance >= 0 ? distance : distance * RUBBER_BAND;
};
