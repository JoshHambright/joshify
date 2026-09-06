import { describe, expect, it } from 'vitest';
import {
  EMPTY_TAP_SESSION,
  MAX_TAPS,
  MIN_TAPS_FOR_BPM,
  NUDGE_FRACTION,
  TAP_DEBOUNCE_MS,
  TAP_TIMEOUT_MS,
  fitTaps,
  nudgeOffsetMs,
  registerTap,
  type TapSession,
} from './tap-tempo.js';

/** Tap out a sequence of monotonic instants, as a finger would. */
const tapAll = (instants: readonly number[]): TapSession =>
  instants.reduce(registerTap, EMPTY_TAP_SESSION);

/** `count` taps at a steady `periodMs`, starting at `fromMs`. */
const steady = (fromMs: number, periodMs: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => fromMs + i * periodMs);

describe('collecting taps', () => {
  it('starts a session on the first tap', () => {
    expect(registerTap(EMPTY_TAP_SESSION, 4_000).taps).toEqual([4_000]);
  });

  it('accumulates taps in order', () => {
    expect(tapAll([1_000, 1_500, 2_000]).taps).toEqual([1_000, 1_500, 2_000]);
  });

  // A touchscreen that bounces, or a `pointerdown` arriving beside a
  // synthesised `click`, would otherwise inject a half-length interval into
  // every estimate — and a half-length interval is a doubled tempo.
  it('ignores a second report of the same touch', () => {
    const session = tapAll([1_000, 1_000 + TAP_DEBOUNCE_MS - 1]);

    expect(session.taps).toEqual([1_000]);
  });

  /**
   * The distinction the whole outlier story rests on: a fumbled tap *within* a
   * gesture is an outlier to reject, but a long silence is someone starting
   * again, and folding that gap into the estimate would leave the tempo stuck
   * on a number nobody is tapping any more.
   */
  it('starts over after a silence rather than measuring it as a slow beat', () => {
    const session = tapAll([1_000, 1_500, 2_000, 2_000 + TAP_TIMEOUT_MS + 1]);

    expect(session.taps).toEqual([2_000 + TAP_TIMEOUT_MS + 1]);
  });

  // Runs for hours: nothing here may grow without bound. Two bars of four is
  // also short enough that a shaky start leaves the window quickly.
  it('keeps only the most recent taps, so nothing grows without bound', () => {
    const session = tapAll(steady(0, 400, MAX_TAPS + 6));

    expect(session.taps).toHaveLength(MAX_TAPS);
    expect(session.taps[MAX_TAPS - 1]).toBe((MAX_TAPS + 5) * 400);
  });
});

describe('reading a tempo out of the taps', () => {
  it('says nothing about an empty session', () => {
    expect(fitTaps(EMPTY_TAP_SESSION, null)).toBeNull();
  });

  /**
   * One interval cannot be checked against anything: a single late tap moves
   * the estimate by tens of BPM and nothing can notice. Three intervals is the
   * smallest sample with a defensible middle.
   */
  it('refuses to guess a tempo from fewer than four taps', () => {
    for (let count = 1; count < MIN_TAPS_FOR_BPM; count += 1) {
      expect(fitTaps(tapAll(steady(0, 500, count)), null)?.bpm).toBeNull();
    }
    expect(fitTaps(tapAll(steady(0, 500, MIN_TAPS_FOR_BPM)), null)?.bpm).toBeCloseTo(
      120,
      6,
    );
  });

  it('names the beat instant from a single tap, which is all phase needs', () => {
    const fit = fitTaps(tapAll([7_321]), null);

    expect(fit?.beatAtMs).toBe(7_321);
    expect(fit?.usedTaps).toBe(1);
  });

  /**
   * A missed beat is not a fumble and must not be discarded: the tap after the
   * gap is a perfectly good observation that simply belongs two beats along.
   * Placing it there rather than rejecting it keeps the whole session, and it
   * is the case that halves the tempo if it is handled naively.
   */
  it('places a tap after a missed beat rather than halving the tempo', () => {
    const fit = fitTaps(tapAll([0, 500, 1_000, 2_000, 2_500, 3_000]), null);

    expect(fit?.bpm).toBeCloseTo(120, 6);
    expect(fit?.usedTaps).toBe(6);
  });

  /**
   * The real fumble: one spurious tap, landing *between* beats rather than on
   * a wrong one. This is what has to be dropped, and it is the case that
   * doubles the tempo if it is not.
   */
  it('rejects a spurious extra tap instead of doubling the tempo', () => {
    const fit = fitTaps(tapAll([0, 500, 1_000, 1_250, 1_500, 2_000]), null);

    expect(fit?.bpm).toBeCloseTo(120, 6);
    expect(fit?.usedTaps).toBe(5);
  });

  // Small jitter is not an outlier — it is the hand, and averaging it is
  // exactly what the extra taps are for.
  it('averages ordinary jitter rather than discarding it', () => {
    // Six taps, each a few milliseconds off a perfect 500ms grid.
    const fit = fitTaps(tapAll([0, 512, 988, 1_505, 2_010, 2_500]), null);

    expect(fit?.bpm).toBeCloseTo(120, 0);
    expect(fit?.usedTaps).toBe(6);
  });

  /**
   * Why the tempo is a least-squares line and not the average interval.
   * Averaging intervals telescopes to `(last − first) / (taps − 1)` — it uses
   * the two end taps and throws the middle ones away, so eight taps are no
   * more precise than two. Here both ends are late and the middle is perfect,
   * and the fit has to notice.
   */
  it('uses every tap for the tempo, not just the first and the last', () => {
    const taps = [12, 500, 1_000, 1_500, 2_000, 2_493];
    const endpointsOnly = 60_000 / ((2_493 - 12) / 5);
    const fit = fitTaps(tapAll(taps), null);

    expect(Math.abs((fit?.bpm ?? 0) - 120)).toBeLessThan(Math.abs(endpointsOnly - 120));
  });

  // 20 BPM is indistinguishable from a stuck frame and 400 is a strobe. The
  // bounds only reject nonsense — half-time and double-time tapping are
  // deliberate choices and are left alone.
  it('refuses a tempo outside the plausible range', () => {
    expect(fitTaps(tapAll(steady(0, 100, 6)), null)?.bpm).toBeNull();
    expect(fitTaps(tapAll(steady(0, 1_600, 6)), null)?.bpm).toBeNull();
    expect(fitTaps(tapAll(steady(0, 800, 6)), null)?.bpm).toBeCloseTo(75, 6);
  });
});

describe('locating the beat against a tempo we already have', () => {
  /**
   * The common case, and the reason phase and tempo are separate gestures: the
   * ISRC lookup worked, so the only missing thing is where the beat falls, and
   * demanding four taps for information given in the first one would be rude.
   */
  it('places the beat from one tap when the tempo is already known', () => {
    const fit = fitTaps(tapAll([12_345]), 120);

    expect(fit?.bpm).toBeNull();
    expect(fit?.beatAtMs).toBe(12_345);
  });

  it('folds taps a beat apart onto one instant before averaging', () => {
    // Three taps on consecutive beats of a 120 BPM grid, all slightly late.
    const fit = fitTaps(tapAll([1_010, 1_510, 2_010]), 120);

    expect(fit?.beatAtMs).toBeCloseTo(2_010, 6);
    expect(fit?.usedTaps).toBe(3);
  });

  /**
   * Convergence, which is the reason the fit averages rather than snapping to
   * the last tap. Each additional tap is another measurement of the same
   * phase, so each one moves the answer less — the pulse settles instead of
   * chasing the jitter in the tapper's hand.
   */
  it('converges: each further tap moves the beat instant less than the last', () => {
    const jitter = [0, 24, -18, 21, -15, 12, -9, 6];
    const instants = jitter.map((offset, i) => 1_000 + i * 500 + offset);
    /** How far apart two phases are on a 500ms circle. */
    const apart = (a: number, b: number): number =>
      Math.abs(((((a - b) % 500) + 750) % 500) - 250);

    const movements: number[] = [];
    let previous: number | null = null;
    for (let count = 1; count <= instants.length; count += 1) {
      const fit = fitTaps(tapAll(instants.slice(0, count)), 120);
      // Compared as a phase, not as an instant: the fitted beat walks forward
      // by a whole beat with every tap, and that motion is not error.
      const phase = fit?.beatAtMs ?? 0;
      if (previous !== null) movements.push(apart(phase, previous));
      previous = phase;
    }

    const early = movements.slice(0, 2);
    const late = movements.slice(-2);
    expect(Math.max(...late)).toBeLessThan(Math.max(...early));
  });

  /**
   * The bounced-touch case, which is the one real fumble that lands *between*
   * beats rather than on a wrong one. It has to be dropped before it can drag
   * either the tempo or the phase.
   */
  it('drops a tap that landed between beats rather than on one', () => {
    const fit = fitTaps(tapAll([1_000, 1_500, 2_000, 2_240]), 120);

    expect(fit?.bpm).toBeCloseTo(120, 6);
    expect(fit?.usedTaps).toBe(3);
    expect(fit?.beatAtMs).toBeCloseTo(2_000, 6);
  });

  /**
   * A missed beat is not a fumble and must not be discarded: the tap after the
   * gap is a perfectly good observation that belongs two beats along, and
   * throwing it away would waste half the session.
   */
  it('places a tap after a missed beat rather than rejecting it', () => {
    const fit = fitTaps(tapAll([0, 500, 1_000, 2_000, 2_500, 3_000]), null);

    expect(fit?.bpm).toBeCloseTo(120, 6);
    expect(fit?.usedTaps).toBe(6);
  });
});

describe('nudging the phase', () => {
  /**
   * A musical amount rather than a fixed number of milliseconds: a sixteenth
   * is a sixteenth at any tempo, whereas 30ms is a meaningful shift at 180 BPM
   * and a rounding error at 60.
   */
  it('moves by a fixed fraction of a beat, so it scales with the tempo', () => {
    expect(nudgeOffsetMs(120, 1)).toBe(500 * NUDGE_FRACTION);
    expect(nudgeOffsetMs(60, 1)).toBe(1_000 * NUDGE_FRACTION);
    expect(nudgeOffsetMs(120, 1)).toBeGreaterThan(20);
  });

  it('goes both ways, because the pulse can be early or late', () => {
    expect(nudgeOffsetMs(120, -2)).toBe(-nudgeOffsetMs(120, 2));
  });

  it('takes sixteen steps to travel a whole beat', () => {
    expect(nudgeOffsetMs(140, 16)).toBeCloseTo(60_000 / 140, 6);
  });
});
