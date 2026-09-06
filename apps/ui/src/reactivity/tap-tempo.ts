/**
 * Tap tempo and phase nudge (P5-11) — the fix for what Tier 1 cannot know.
 *
 * A BPM lookup returns a tempo and nothing else. Tempo without a downbeat is
 * the right speed at the wrong offset: the pulse is exactly as fast as the
 * music and lands between the beats, which looks *worse* than an unrelated
 * pulse because the eye can tell it is nearly right and keeps trying to lock
 * to it. Two taps fix it, and tapping along with music is fun in a way that a
 * settings slider is not.
 *
 * ---
 *
 * **Tapping is two gestures, not one.**
 *
 * "The beat is *now*" and "the tempo is *this*" are different statements, they
 * are needed at different times, and conflating them makes both worse.
 *
 * - **Phase.** One tap is enough. The intent is unambiguous and the payoff is
 *   immediate — you tap, the pulse jumps to where you tapped. When the BPM
 *   lookup has already succeeded this is the *only* thing missing, and it
 *   would be perverse to make someone tap four times to supply information
 *   they gave in the first one.
 * - **Tempo.** Four taps minimum (`MIN_TAPS_FOR_BPM`), i.e. three intervals.
 *   Two taps give one interval, and one interval cannot be checked against
 *   anything: a single late tap moves the estimate by tens of BPM and there is
 *   no way to notice. Three intervals is the smallest sample with a meaningful
 *   median, and a median is the only reason a mistimed tap is survivable.
 * - **Nudge.** A third gesture, deliberately separate: two small buttons that
 *   shift the pulse by a fixed musical fraction and never touch the tempo.
 *   When the tempo is right and the pulse is just early, re-tapping the whole
 *   thing is the wrong tool — you would be discarding a good tempo to fix a
 *   30ms offset.
 *
 * **Outliers, and the two ways a tap can be wrong.**
 *
 * A *fumbled* tap — one landing early or late inside an otherwise steady
 * sequence — is rejected: intervals more than `TAP_OUTLIER_TOLERANCE` from the
 * median are dropped and the surviving ones averaged. This handles the two
 * real cases, a missed beat (one double-length interval) and a bounced touch
 * (two half-length ones), because in both the majority is still correct.
 *
 * A *restart* — the user stops, thinks, and taps again, or taps along to the
 * next song — is not an outlier at all, and treating it as one would leave the
 * estimate permanently stuck on a tempo nobody is tapping any more. A gap
 * longer than `TAP_TIMEOUT_MS` therefore clears the session instead of being
 * measured. That is the distinction: reject a bad tap *within* a gesture,
 * start over *between* gestures.
 *
 * Everything here is pure and immutable. Taps arrive at human rate — a handful
 * per second, never per frame — so this is not the hot path, and the clarity
 * of returning a new session is worth more than the allocation it costs.
 */

/**
 * Taps further apart than this are separate gestures.
 *
 * 2s is 30 BPM. Nobody taps a tempo that slow; anyone still tapping after two
 * seconds of silence has started again.
 */
export const TAP_TIMEOUT_MS = 2_000;

/**
 * Taps closer together than this are one touch reported twice.
 *
 * 60ms is 1000 BPM. A touchscreen that bounces, or a `pointerdown` arriving
 * beside a synthesised `click`, would otherwise inject a half-length interval
 * into every estimate.
 */
export const TAP_DEBOUNCE_MS = 60;

/**
 * How many taps are kept.
 *
 * Two bars of four. Enough that the average means something; short enough that
 * when the tapper settles into the groove after a shaky start, the shaky start
 * has left the window within two bars instead of dragging the estimate for the
 * rest of the song.
 */
export const MAX_TAPS = 8;

/** Four taps, three intervals — the smallest sample a median can defend. */
export const MIN_TAPS_FOR_BPM = 4;

/** How far an interval may sit from the median before it is treated as a fumble. */
export const TAP_OUTLIER_TOLERANCE = 0.35;

/** How far a tap may sit from the fitted grid before it is left out of the phase. */
export const TAP_PHASE_TOLERANCE = 0.25;

/**
 * Tempos accepted from a tap session.
 *
 * Wide, because tapping half-time or double-time is a legitimate thing to do —
 * a half-time pulse on a fast track is a good look, and second-guessing the
 * user by folding their tempo into a "sensible" octave would override a
 * deliberate choice. The bounds exist only to reject nonsense: a 20 BPM pulse
 * is indistinguishable from a stuck frame, and a 400 BPM one is a strobe.
 */
export const MIN_TAP_BPM = 40;
export const MAX_TAP_BPM = 240;

/** Recorded taps, oldest first. Bounded to `MAX_TAPS`. */
export interface TapSession {
  readonly taps: readonly number[];
}

export const EMPTY_TAP_SESSION: TapSession = { taps: [] };

/**
 * Record a tap at the monotonic instant `atMs`.
 *
 * Returns the session unchanged for a bounced touch, a fresh single-tap
 * session after a long gap, and the extended session otherwise.
 */
export const registerTap = (session: TapSession, atMs: number): TapSession => {
  const last = session.taps[session.taps.length - 1];
  if (last === undefined) return { taps: [atMs] };
  const gap = atMs - last;
  if (gap < TAP_DEBOUNCE_MS) return session;
  if (gap > TAP_TIMEOUT_MS) return { taps: [atMs] };
  const taps = [...session.taps, atMs];
  return { taps: taps.length > MAX_TAPS ? taps.slice(taps.length - MAX_TAPS) : taps };
};

/** Median of a non-empty list. Copies, because sorting the input would be rude. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

export interface TapFit {
  /**
   * The tempo the taps describe, or `null` when there are too few of them to
   * say — in which case the caller keeps whatever tempo it already had.
   */
  readonly bpm: number | null;
  /**
   * A monotonic instant at which a beat falls, according to the whole session
   * rather than to the last tap alone.
   *
   * Fitting rather than snapping is what makes repeated tapping *converge*:
   * each new tap moves this by less than the one before, so the pulse settles
   * instead of chasing the jitter in the tapper's hand. A single tap has
   * nothing to fit and simply is the answer.
   */
  readonly beatAtMs: number;
  /** How many taps survived rejection and went into `beatAtMs`. */
  readonly usedTaps: number;
}

/** Beats per minute for an interval in milliseconds. */
const bpmFromPeriod = (periodMs: number): number => 60_000 / periodMs;

/**
 * Estimate tempo and beat position from a tap session.
 *
 * `referenceBpm` is the tempo already in force — from an ISRC lookup, or from
 * an earlier tap session. It lets one or two taps refine the *phase* against a
 * known grid, which is the common case: the lookup worked, and the user is
 * only telling us where the bar starts.
 *
 * Returns `null` for an empty session — there is nothing to say, and returning
 * a fabricated instant would move the pulse for no reason.
 */
export const fitTaps = (
  session: TapSession,
  referenceBpm: number | null,
): TapFit | null => {
  const taps = session.taps;
  const lastTap = taps[taps.length - 1];
  if (lastTap === undefined) return null;

  let bpm: number | null = null;
  if (taps.length >= MIN_TAPS_FOR_BPM) {
    const intervals: number[] = [];
    for (let i = 1; i < taps.length; i += 1) {
      intervals.push((taps[i] ?? 0) - (taps[i - 1] ?? 0));
    }
    const typical = median(intervals);
    // The median is the centre; the mean of everything near it is the
    // estimate. Median alone would quantise to one observed interval and
    // ignore the precision the other taps carry; mean alone would swallow the
    // outlier the median is here to find.
    const inliers = intervals.filter(
      (value) => Math.abs(value - typical) <= typical * TAP_OUTLIER_TOLERANCE,
    );
    const periodMs = inliers.length > 0 ? mean(inliers) : typical;
    const candidate = bpmFromPeriod(periodMs);
    if (candidate >= MIN_TAP_BPM && candidate <= MAX_TAP_BPM) bpm = candidate;
  }

  const gridBpm = bpm ?? referenceBpm;
  if (gridBpm === null) {
    // No grid to fit against: the last tap is the only beat we can name.
    return { bpm, beatAtMs: lastTap, usedTaps: 1 };
  }

  // Fold every tap onto the beat nearest the last one, then average. Each tap
  // is an independent measurement of the same phase, so averaging them is
  // exactly the right thing — and it is why the fourth tap moves the pulse
  // less than the second did.
  const periodMs = 60_000 / gridBpm;
  const residuals = taps.map(
    (tap) => tap - Math.round((tap - lastTap) / periodMs) * periodMs,
  );
  const centre = median(residuals);
  const kept = residuals.filter(
    (value) => Math.abs(value - centre) <= periodMs * TAP_PHASE_TOLERANCE,
  );
  const used = kept.length > 0 ? kept : [lastTap];
  return { bpm, beatAtMs: mean(used), usedTaps: used.length };
};

/**
 * How far one nudge moves the pulse, as a fraction of a beat.
 *
 * A fraction rather than a fixed number of milliseconds, because a nudge is a
 * musical amount: a sixteenth is a sixteenth at any tempo, whereas 30ms is a
 * meaningful shift at 180 BPM and a rounding error at 60. A sixteenth is also
 * comfortably above the ~20ms at which a timing change becomes visible, so one
 * press does something you can see, and four presses is a whole sixteenth
 * note — a unit the hand already understands.
 */
export const NUDGE_FRACTION = 1 / 16;

/** Milliseconds one nudge step moves the beat grid at a given tempo. */
export const nudgeOffsetMs = (bpm: number, steps: number): number =>
  (60_000 / bpm) * NUDGE_FRACTION * steps;
