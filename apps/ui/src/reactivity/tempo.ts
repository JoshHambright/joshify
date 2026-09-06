/**
 * Tier 1, client half — a known BPM turned into a phase-locked pulse (P5-04).
 *
 * The server half (ISRC → BPM database → permanent disk cache) lives elsewhere;
 * everything here starts from the moment a number arrives. What arrives is a
 * *tempo*, and only a tempo: no beat grid, no downbeat, no bar. The pulse is
 * therefore built from three things —
 *
 *   - the tempo, which the lookup gives us,
 *   - the track position, which polling gives us (interpolated locally, D-024),
 *   - an offset, which nothing gives us and `tap-tempo.ts` supplies.
 *
 * ---
 *
 * **Phase is anchored in track position, not in wall time.** `beats = (position
 * − offset) / period`. Anchoring to the position rather than to the clock is
 * what makes a seek behave: the grid belongs to the *track*, so jumping to
 * 2:30 lands on the beat grid at 2:30 rather than wherever the clock had got
 * to. It is also what makes a pause correct — a paused track has no beats, and
 * the pulse stops rather than carrying on over silence.
 *
 * **But the position arrives jittery, and a jittery grid is a staggering
 * pulse.** Every poll is stale by a round trip, so successive anchors describe
 * the same line with ±100ms of noise on it. Left alone, that noise lands
 * straight on the phase — at 120 BPM, ±100ms is ±20% of a beat, and the pulse
 * visibly trips once per poll. The fix mirrors D-024's rule for the progress
 * bar: a *small* correction is poll noise and is absorbed by moving the grid
 * with it, so the beat instants do not move; a *large* one is a real seek and
 * is taken at face value, so the grid moves with the music. `positionMs`
 * should still be fed from the smoothed progress model rather than from a raw
 * poll payload — this is a safety net, not a licence to feed it noise.
 *
 * **What we cannot know, we do not assert.** With a tempo alone, every beat is
 * equally likely to be the downbeat, so before anyone taps, all beats are
 * given the same weight — no bar accent. Claiming a bar we have not been told
 * about is the same error as claiming a phase we have not been told about, and
 * it is worse than doing nothing, because a wrong accent is *legible*: the eye
 * locks to it and then keeps being wrong. After a tap, the tapped beat is the
 * downbeat and the accents come on.
 */
import {
  BEATS_PER_BAR,
  createProceduralProvider,
  fillBands,
  proceduralEnergy,
} from './procedural.js';
import {
  BEAT_DECAY_MS,
  BEAT_HOLD_MS,
  barAccent,
  beatEnvelope,
  createReactivityFrame,
  effectiveDecayMs,
  type Reactivity,
  type ReactivityProvider,
  type ReactivityTier,
} from './provider.js';
import {
  EMPTY_TAP_SESSION,
  MAX_TAP_BPM,
  MIN_TAP_BPM,
  fitTaps,
  nudgeOffsetMs,
  registerTap,
  type TapSession,
} from './tap-tempo.js';

/**
 * What the pulse is hung on: a tempo, plus one known (position, instant) pair
 * to extrapolate the position from.
 */
export interface TempoAnchor {
  /** Beats per minute for the current track. */
  readonly bpm: number;
  /**
   * Track position in milliseconds at `atMs`. Feed this from the interpolated
   * progress model, not from a raw poll — see the note on jitter above.
   */
  readonly positionMs: number;
  /** The monotonic reading at which `positionMs` was true (D-023). */
  readonly atMs: number;
  /** Whether the position is advancing. A paused track produces no beats. */
  readonly playing: boolean;
}

/**
 * How far a re-anchor may move the position before it counts as a seek rather
 * than poll noise. Deliberately the same 1.5s D-024 chose for the progress
 * bar, and for the same reason: it sits above a slow round trip and below any
 * seek a human would bother performing.
 */
export const ANCHOR_TOLERANCE_MS = 1_500;

/** Tempos this tier will accept. Shared with tap tempo — same question. */
export const isUsableBpm = (bpm: number): boolean =>
  Number.isFinite(bpm) && bpm >= MIN_TAP_BPM && bpm <= MAX_TAP_BPM;

export const beatPeriodMs = (bpm: number): number => 60_000 / bpm;

/**
 * Track position at `atMs`, extrapolated from the anchor.
 *
 * Extrapolates in both directions rather than clamping at the anchor instant:
 * the anchor describes a line, not a starting gun, and a tap fitted across the
 * last few seconds legitimately asks about instants before the most recent
 * poll.
 */
export const positionAt = (anchor: TempoAnchor, atMs: number): number =>
  anchor.playing ? anchor.positionMs + (atMs - anchor.atMs) : anchor.positionMs;

/** Continuous beat count — integer at every beat, fractional between them. */
export const beatsAt = (anchor: TempoAnchor, offsetMs: number, atMs: number): number =>
  (positionAt(anchor, atMs) - offsetMs) / beatPeriodMs(anchor.bpm);

/** Wrap into `0..limit`, correctly for negative values (JS `%` keeps the sign). */
const wrap = (value: number, limit: number): number => ((value % limit) + limit) % limit;

export interface TempoProvider extends ReactivityProvider {
  /** The tempo currently driving the pulse, or `null` when there is none. */
  readonly bpm: number | null;
  /** Whether a tap has told us where the bar starts. */
  readonly barAligned: boolean;
  /** Adopt or refresh the tempo and position anchor. */
  setAnchor(anchor: TempoAnchor): void;
  /**
   * The track changed: forget the tempo, the phase and the taps.
   *
   * All three belonged to the previous recording and none of them transfers. A
   * phase locked to the last track is worse than no phase at all — it is a
   * confident, wrong answer, and the visualiser will spend the whole of the
   * new song insisting on it. Dropping to Tier 0 until a new BPM arrives is
   * the graceful degradation D-010 exists to provide: the screen keeps moving
   * and stops claiming to know something it does not.
   */
  trackChanged(): void;
  /**
   * Register a beat tap. Returns the tempo now in force, or `null` if there
   * still is not one.
   */
  tap(atMs: number): number | null;
  /** Shift the grid by `steps` sixteenths of a beat. Never changes the tempo. */
  nudge(steps: number): void;
}

export interface TempoProviderOptions {
  /** Monotonic origin for the synthesised energy and band fields. */
  readonly originMs?: number | undefined;
  /**
   * What to fall back to when there is no tempo. Defaults to Tier 0, which is
   * the whole point of D-010: an unresolved lookup is a quieter visualiser,
   * not a stopped one.
   */
  readonly fallback?: ReactivityProvider | undefined;
}

export const createTempoProvider = (
  options: TempoProviderOptions = {},
): TempoProvider => {
  const originMs = options.originMs ?? 0;
  const fallback = options.fallback ?? createProceduralProvider({ originMs });
  const frame = createReactivityFrame();

  let anchor: TempoAnchor | null = null;
  /**
   * Track position, in ms, at which a *bar* starts. Held modulo the bar rather
   * than the beat so that the beat a tap lands on becomes beat one — without
   * that, aligning the phase would still leave the accent on an arbitrary beat
   * of the bar, which is the same lie in a smaller font.
   */
  let offsetMs = 0;
  let barAligned = false;
  /** True while the grid is hung on the monotonic clock rather than a track. */
  let clockAnchored = false;
  let session: TapSession = EMPTY_TAP_SESSION;

  const barMs = (bpm: number): number => beatPeriodMs(bpm) * BEATS_PER_BAR;

  const reset = (): void => {
    anchor = null;
    clockAnchored = false;
    offsetMs = 0;
    barAligned = false;
    session = EMPTY_TAP_SESSION;
  };

  /** Adopt `next`, preserving the phase when the change is only poll noise. */
  const adopt = (next: TempoAnchor): void => {
    const previous = anchor;
    if (previous !== null && !clockAnchored && previous.bpm === next.bpm) {
      const delta = next.positionMs - positionAt(previous, next.atMs);
      // Small: the poll disagrees with our extrapolation by a round trip.
      // Move the grid by the same amount so no beat instant moves at all.
      // Large: a real seek. Leave the grid where it is, in track-position
      // space, so it lands correctly on the music at the new position.
      if (Math.abs(delta) <= ANCHOR_TOLERANCE_MS) offsetMs += delta;
    } else if (previous !== null && clockAnchored) {
      // The grid was hung on the clock and is moving to track position. The
      // music has not changed, only the coordinates, so carry the phase across
      // rather than discarding a tap the user has already made.
      const withinBar = wrap(beatsAt(previous, offsetMs, next.atMs), BEATS_PER_BAR);
      offsetMs = next.positionMs - withinBar * beatPeriodMs(next.bpm);
    }
    anchor = next;
    clockAnchored = false;
    offsetMs = wrap(offsetMs, barMs(next.bpm));
  };

  const alignTo = (beatAtMs: number, bpm: number): void => {
    const current = anchor;
    if (current === null) {
      // No playback position to hang a grid on, so hang it on the clock the
      // taps were measured with. Arbitrary but self-consistent, and it means a
      // tapped tempo works on its own — no lookup, no server, no track.
      anchor = { bpm, positionMs: beatAtMs, atMs: beatAtMs, playing: true };
      clockAnchored = true;
      offsetMs = wrap(beatAtMs, barMs(bpm));
    } else {
      const next = { ...current, bpm };
      offsetMs = wrap(positionAt(next, beatAtMs), barMs(bpm));
      anchor = next;
    }
    barAligned = true;
  };

  return {
    get tier(): ReactivityTier {
      return anchor === null ? 0 : 1;
    },
    get bpm(): number | null {
      return anchor?.bpm ?? null;
    },
    get barAligned(): boolean {
      return barAligned;
    },

    setAnchor: (next: TempoAnchor): void => {
      // A lookup that returns 0, 900 or a NaN must not become a stopped pulse
      // or a strobe. An unusable tempo is not information, so it changes
      // nothing — it neither starts a grid nor destroys one the user has
      // already tapped in. Ending a track's grid is `trackChanged`'s job.
      if (!isUsableBpm(next.bpm)) return;
      adopt(next);
    },

    trackChanged: reset,

    tap: (atMs: number): number | null => {
      session = registerTap(session, atMs);
      const fit = fitTaps(session, anchor?.bpm ?? null);
      if (fit === null) return null;
      const bpm = fit.bpm ?? anchor?.bpm ?? null;
      // Too few taps and no tempo already in hand: the tap is recorded and
      // will count towards the estimate, but there is no grid to move yet.
      if (bpm === null) return null;
      alignTo(fit.beatAtMs, bpm);
      return bpm;
    },

    nudge: (steps: number): void => {
      const current = anchor;
      if (current === null) return;
      offsetMs = wrap(offsetMs + nudgeOffsetMs(current.bpm, steps), barMs(current.bpm));
    },

    sample: (atMs: number): Reactivity => {
      const current = anchor;
      if (current === null) return fallback.sample(atMs);

      const elapsedS = Math.max(0, atMs - originMs) / 1000;
      const periodMs = beatPeriodMs(current.bpm);
      const beats = beatsAt(current, offsetMs, atMs);
      const beatIndex = Math.floor(beats);
      const phase = beats - beatIndex;
      // A paused track is not playing beats. Holding the envelope at whatever
      // value it happened to reach would leave the screen lit and stuck; the
      // bands keep drifting, so the visualiser idles rather than freezing.
      const accent = barAligned ? barAccent(beatIndex) : 1;
      const beat = current.playing
        ? accent *
          beatEnvelope(
            phase * periodMs,
            BEAT_HOLD_MS,
            effectiveDecayMs(periodMs, BEAT_DECAY_MS),
          )
        : 0;
      const energy = proceduralEnergy(beats, elapsedS, beat);
      fillBands(frame.bands, elapsedS, beat, energy);
      frame.beat = beat;
      frame.energy = energy;
      frame.phase = phase;
      return frame;
    },
  };
};
