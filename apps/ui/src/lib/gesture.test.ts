import { describe, expect, it } from 'vitest';
import {
  DISMISS_DISTANCE_PX,
  FLING_MIN_DISTANCE_PX,
  shouldDismiss,
  swipeDistance,
  swipeOffset,
  swipeVelocity,
  type SwipeState,
} from './gesture.js';

const swipe = (fromY: number, toY: number, overMs: number): SwipeState => ({
  start: { y: fromY, atMs: 1_000 },
  latest: { y: toY, atMs: 1_000 + overMs },
});

describe('measuring a swipe', () => {
  it('reads downward travel as positive and upward as negative', () => {
    expect(swipeDistance(swipe(100, 260, 200))).toBe(160);
    expect(swipeDistance(swipe(260, 100, 200))).toBe(-160);
  });

  it('is pixels per millisecond', () => {
    expect(swipeVelocity(swipe(0, 100, 200))).toBe(0.5);
  });

  // Infinity passes every `>` comparison, so an instantaneous sample would
  // make every tap read as a fling and dismiss the screen under the finger.
  it('reports no speed rather than infinite speed for a zero-duration sample', () => {
    expect(swipeVelocity(swipe(0, 100, 0))).toBe(0);
    expect(swipeVelocity(swipe(0, 100, -5))).toBe(0);
  });
});

describe('deciding to dismiss', () => {
  it('accepts a slow drag that goes far enough', () => {
    expect(shouldDismiss(swipe(0, DISMISS_DISTANCE_PX, 2_000))).toBe(true);
  });

  it('accepts a quick flick that does not', () => {
    // Half the distance, but fast.
    expect(shouldDismiss(swipe(0, 48, 60))).toBe(true);
  });

  it('refuses a short slow drag, which is someone changing their mind', () => {
    expect(shouldDismiss(swipe(0, 40, 1_500))).toBe(false);
  });

  // A tap is a zero-distance gesture in zero time. It must never dismiss.
  it('refuses a tap', () => {
    expect(shouldDismiss(swipe(120, 120, 0))).toBe(false);
    expect(shouldDismiss(swipe(120, 121, 8))).toBe(false);
  });

  it('refuses a fast twitch below the minimum distance', () => {
    expect(shouldDismiss(swipe(0, FLING_MIN_DISTANCE_PX - 1, 1))).toBe(false);
  });

  it('refuses an upward gesture however far or fast', () => {
    expect(shouldDismiss(swipe(400, 0, 50))).toBe(false);
    expect(shouldDismiss(swipe(400, 0, 5_000))).toBe(false);
  });
});

describe('following the finger', () => {
  it('tracks a downward drag one to one', () => {
    expect(swipeOffset(swipe(0, 150, 100))).toBe(150);
  });

  // The plate has nowhere to go up. Following the finger there would promise a
  // gesture that does nothing; ignoring it entirely would read as frozen.
  it('resists an upward drag rather than following or ignoring it', () => {
    const offset = swipeOffset(swipe(0, -100, 100));

    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-100);
  });

  it('is still at rest', () => {
    expect(swipeOffset(swipe(80, 80, 0))).toBe(0);
  });
});
