/**
 * The reactivity contract — one shape, three possible sources.
 *
 * Spotify's `audio-analysis` and `audio-features` endpoints have returned 403
 * for new applications since 2024-11-27, so there is no beat grid, no tempo and
 * no loudness curve coming from the API (D-010). Reactivity is therefore
 * *manufactured*, from whichever of three sources happens to be available:
 *
 * - **Tier 0** — procedural. Time in, plausible music-shaped signal out. No
 *   audio, no network, no BPM. Always works, which is why it is the floor:
 *   every preset has to look right on it, because Tier 1 needs a lookup that
 *   can miss and Tier 2 needs librespot, which is opt-in (D-013).
 * - **Tier 1** — a known BPM turned into a phase-locked pulse (`tempo.ts`).
 * - **Tier 2** — a real FFT off librespot's PCM tap. Not built here.
 *
 * Shaders never learn which one they got. That is the whole point of putting a
 * contract here: an effect is written once against `Reactivity` and keeps
 * working when the tier under it changes mid-track, which it does — a BPM
 * lookup resolving is a Tier 0 → Tier 1 promotion in the middle of a song.
 *
 * **The provider owns no clock.** `sample(atMs)` takes the instant to sample as
 * an argument, in line with D-042/D-043: anything with a schedule takes its
 * clock as a parameter, so the headless engine test (P5-17) can drive a whole
 * track in a millisecond and assert the frames it got. `atMs` is a *monotonic*
 * reading (D-023) — the Pi has no RTC, and a visualiser whose beat grid jumped
 * a year sideways on first NTP contact would be a memorable bug.
 */

/** Spectrum buckets, bass to treble. Matches `uniform float uBands[16]`. */
export const BAND_COUNT = 16;

/**
 * Which source is currently filling the frame. Exposed because the UI has a
 * legitimate use for it — "128 BPM" is worth showing, and so is the absence of
 * it, since that is what tells the user a tap would help.
 */
export type ReactivityTier = 0 | 1 | 2;

/**
 * One frame of reactivity. Plain numbers, all normalised, all finite.
 *
 * What a consumer may assume:
 *
 * - Every value is in `0..1` inclusive. Never `NaN`, never `Infinity`. This is
 *   load-bearing rather than tidy: a `NaN` reaching a uniform makes the whole
 *   fragment shader's output undefined, so one bad sample blacks the screen of
 *   an appliance that is supposed to run unattended for hours.
 * - `sample()` is a pure function of `atMs` for Tiers 0 and 1 — the same
 *   instant always yields the same frame, and nothing accumulates between
 *   calls, so a dropped frame cannot shift the animation and a long run cannot
 *   drift.
 *
 * What a consumer may **not** assume: that the object survives the next call.
 * See `sample()`.
 */
export interface Reactivity {
  /**
   * The beat envelope: `1` at the instant of a beat, falling to `0` before the
   * next one. Not a boolean and not a trigger — it is meant to be multiplied
   * into something (a scale, a flash, an emission rate).
   *
   * On Tier 0 the beats are invented and do not claim to be the track's. On
   * Tier 1 they are the track's tempo, at an arbitrary offset within the bar
   * until someone taps (`tap-tempo.ts`).
   */
  readonly beat: number;
  /**
   * Overall intensity, moving on the order of seconds rather than frames. The
   * "how loud is this record" dial. It has a floor and never reaches `0`, so
   * an effect scaled by energy fades but never disappears — a visualiser that
   * goes completely black reads as a crash, not as a quiet passage.
   */
  readonly energy: number;
  /**
   * Position within the current beat as a sawtooth: `0` at the beat, rising to
   * just under `1`, then wrapping. Use it for anything that should travel
   * *between* beats — a tunnel's advance, a sweep, a rotation. Discontinuous
   * at the beat by construction; that discontinuity is the beat.
   */
  readonly phase: number;
  /**
   * `BAND_COUNT` spectrum buckets, bass at index 0. Uploaded straight to
   * `uBands` with `uniform1fv`, which is why it is a `Float32Array` rather
   * than a `number[]`.
   *
   * Only Tier 2 can know the real spectrum. Tiers 0 and 1 synthesise something
   * spectrum-shaped: bass-tilted, bass tied to the beat, neighbouring bands
   * correlated. Honest about being an invention, but the bars have to move or
   * the classic Winamp preset has nothing to draw.
   */
  readonly bands: Float32Array;
}

/**
 * The frame as its producer sees it. A provider allocates exactly one of these
 * and rewrites it in place — see `sample()` for why.
 */
export interface MutableReactivity {
  beat: number;
  energy: number;
  phase: number;
  readonly bands: Float32Array;
}

export interface ReactivityProvider {
  /** Which tier is actually filling frames right now. May change mid-track. */
  readonly tier: ReactivityTier;
  /**
   * The frame for the monotonic instant `atMs`.
   *
   * **The returned object is owned by the provider and is only valid until the
   * next call.** This is deliberate: the render loop calls `sample()` sixty
   * times a second for hours, and a fresh object plus a fresh `Float32Array`
   * per frame is 60 allocations a second of garbage on a Pi that also has to
   * hold a multi-pass shader chain at frame rate. The consumer reads the four
   * numbers out and uploads them; nothing needs to retain the object. If you
   * do need to keep a frame — a scripted sequence in a test, say — copy it.
   */
  sample(atMs: number): Reactivity;
}

/** A frame with its band buffer allocated once, at construction. */
export const createReactivityFrame = (): MutableReactivity => ({
  beat: 0,
  energy: 0,
  phase: 0,
  bands: new Float32Array(BAND_COUNT),
});

/**
 * Clamp into `0..1`, mapping `NaN` to `0`.
 *
 * `Math.min(1, Math.max(0, x))` propagates `NaN` instead of clamping it, which
 * is exactly the value that must never leave this module. Written as
 * comparisons because every comparison against `NaN` is false, so it falls
 * through to `0` without a separate `Number.isNaN` check in the hot path.
 */
export const clamp01 = (value: number): number => {
  if (value > 1) return 1;
  if (value > 0) return value;
  return 0;
};

/**
 * How long the envelope holds at full before it starts to fall.
 *
 * A struck instrument has no rise time worth modelling — the attack *is* the
 * event. But a 60Hz sampler looking at an instantaneous attack sees whatever
 * the decay had reached by the next frame boundary, which is somewhere between
 * 100% and 78% depending on where the frame happened to land. That is a
 * beat-to-beat brightness flicker with no musical cause, and it is visible.
 *
 * Holding for one frame's worth of time guarantees at least one sample at the
 * full peak whatever the frame phase, without softening the attack into a
 * swell. It is a sampling fix, not an envelope shape.
 */
export const BEAT_HOLD_MS = 16;

/**
 * How long the fall takes. Percussion decay is a property of the instrument,
 * not of the tempo — a snare does not ring longer because the song is slow —
 * so this is an absolute duration rather than a fraction of the beat.
 */
export const BEAT_DECAY_MS = 260;

/**
 * ...except that at fast tempos an absolute decay would run into the next
 * beat, and an envelope that never reaches zero is a glow, not a pulse. The
 * darkness between beats is what makes the eye read them as separate events,
 * so the decay is capped to leave a clear gap.
 */
export const MAX_DECAY_BEAT_FRACTION = 0.6;

/** The decay to actually use at a given tempo. */
export const effectiveDecayMs = (beatPeriodMs: number, decayMs: number): number =>
  Math.min(decayMs, beatPeriodMs * MAX_DECAY_BEAT_FRACTION);

/**
 * The beat envelope: instant attack, quartic decay.
 *
 * **Why decay is slower than attack.** Physically, a struck body takes its
 * whole excitation in one impulse and then radiates it away over the body's
 * resonance — energy in fast, energy out slow. Perceptually, the ear locates a
 * musical event by its *onset*: sharpen the attack and a sound reads as a hit,
 * soften it and the same sound reads as a swell. A symmetric envelope reads as
 * breathing — the pumping of an over-compressed mix — and never as percussion.
 *
 * For a *visualiser* the asymmetry matters more than it does for audio. At
 * 60fps the attack is at most one frame, so it is not really seen at all; the
 * decay is the entire visible gesture. The rise is what the eye interprets as
 * the impact and the fall is what it actually watches. Make them equal and you
 * get a throb; keep them asymmetric and you get a strike.
 *
 * The quartic fall (`(1 - x)⁴`, as in VISUALIZER.md's `pow(1 - phase, 4)`)
 * spends most of its time near zero and lands on it with zero slope, so the
 * frame goes dark smoothly rather than switching off.
 *
 * @param sinceBeatMs milliseconds since the most recent beat instant
 * @param holdMs      full-value hold, normally `BEAT_HOLD_MS`
 * @param decayMs     fall duration; a non-positive value yields silence
 */
export const beatEnvelope = (
  sinceBeatMs: number,
  holdMs: number,
  decayMs: number,
): number => {
  // Written as a negated `>=` so `NaN` — which fails every comparison — takes
  // this branch rather than propagating into the arithmetic below.
  if (!(sinceBeatMs >= 0)) return 0;
  if (!(decayMs > 0)) return 0;
  if (sinceBeatMs <= holdMs) return 1;
  const x = (sinceBeatMs - holdMs) / decayMs;
  if (x >= 1) return 0;
  const fall = 1 - x;
  return fall * fall * fall * fall;
};

/**
 * Relative loudness of each beat of a 4/4 bar.
 *
 * A pulse of identical beats is a metronome, and a metronome is the sound of
 * counting rather than of music. The hierarchy — the downbeat strongest, the
 * backbeat next, the offbeats lightest — is most of what makes four evenly
 * spaced events read as a bar instead of a click track. It is also the
 * cheapest musicality available: one lookup, no extra state.
 */
export const BAR_ACCENTS: readonly number[] = [1, 0.62, 0.82, 0.62];

/** The accent for a beat index, safe for any integer including negatives. */
export const barAccent = (beatIndex: number): number => {
  const count = BAR_ACCENTS.length;
  // `%` keeps the sign of the dividend in JS, so a negative index would fall
  // off the front of the table and read `undefined`.
  const slot = ((beatIndex % count) + count) % count;
  return BAR_ACCENTS[slot] ?? 1;
};
