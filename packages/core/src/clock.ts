/**
 * Time, injected.
 *
 * Adaptive polling (P2-03), progress interpolation (P2-04) and token refresh
 * scheduling (P1-05) are all time-dependent, and none of them should need a
 * real timer to be tested. Everything that reads a clock takes one as an
 * argument instead of reaching for the globals.
 *
 * ---
 *
 * **Two readings, because they answer different questions.**
 *
 * `now()` is wall-clock: what a human calls the current time. It is the right
 * answer for "what time is it" and nothing else, because it is *adjustable* —
 * an NTP correction, a timezone daemon or a user setting can move it, in
 * either direction, at any moment. A Pi with no RTC is the worst case: it
 * boots believing it is some point in the past and jumps years forward the
 * moment it gets a network.
 *
 * `monotonic()` counts forward from an arbitrary origin and cannot go
 * backwards. It is therefore the only correct basis for measuring *elapsed*
 * time. Progress interpolation advances the playback position between network
 * polls by adding elapsed time to the last known position; if that elapsed
 * time were derived from the wall clock, an NTP step would make the progress
 * bar visibly jump backwards or leap ahead, and a seek that never happened
 * would be reported to the UI.
 *
 * The rule: measure durations with `monotonic()`, display times with `now()`,
 * and never subtract one from the other — their origins are unrelated.
 */
export interface Clock {
  /** Wall-clock time as epoch milliseconds. Adjustable; may jump either way. */
  now(): number;
  /**
   * Milliseconds from an arbitrary origin. Only differences are meaningful,
   * and they are guaranteed never to be negative.
   */
  monotonic(): number;
}

/**
 * The real clock.
 *
 * `performance.now()` rather than `Date.now()` for the monotonic reading: it
 * is specified never to decrease, and it carries sub-millisecond resolution,
 * which matters when interpolation runs at frame rate.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export interface TestClock extends Clock {
  /**
   * Move both readings forward by `ms`. Negative values throw: a test that
   * rewinds a monotonic clock is asserting something the real one cannot do,
   * so it would prove nothing.
   */
  advance(ms: number): void;
  /**
   * Move the wall clock only, leaving the monotonic reading untouched — the
   * NTP correction that progress interpolation must survive.
   */
  setWallClock(epochMs: number): void;
}

export interface TestClockOptions {
  /** Starting epoch ms. Defaults to a fixed, arbitrary instant in 2023. */
  readonly now?: number;
  /** Starting monotonic reading. Deliberately unrelated to `now`. */
  readonly monotonic?: number;
}

/** An arbitrary but fixed instant, so tests read the same on every run. */
const DEFAULT_EPOCH_MS = 1_700_000_000_000;

/**
 * A non-zero default origin, because a monotonic clock that starts at 0 lets
 * a bug that treats the reading as an absolute timestamp pass unnoticed.
 */
const DEFAULT_MONOTONIC_MS = 10_000;

export const createTestClock = (options: TestClockOptions = {}): TestClock => {
  let wall = options.now ?? DEFAULT_EPOCH_MS;
  let mono = options.monotonic ?? DEFAULT_MONOTONIC_MS;

  return {
    now: () => wall,
    monotonic: () => mono,
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`cannot advance a clock by ${String(ms)}ms`);
      }
      wall += ms;
      mono += ms;
    },
    setWallClock: (epochMs: number) => {
      wall = epochMs;
    },
  };
};
