/**
 * Tier 0 — reactivity from nothing but a clock.
 *
 * This is the floor of D-010 and the only tier guaranteed to exist. No audio,
 * no BPM lookup, no network, no librespot. Time in, music-shaped signal out.
 *
 * ---
 *
 * **What makes a procedural signal feel musical.**
 *
 * The two failure modes are easy to describe and easy to hit. A signal that
 * pulses at a fixed rate with a fixed shape reads as a *screensaver*: the eye
 * finds the period within a couple of seconds and then stops looking, because
 * there is no more information coming. A signal driven by noise reads as
 * *broken*: it moves constantly and lands on nothing, so it never coincides
 * with anything the ear is doing. Music is neither. It is periodic at several
 * timescales at once, and it varies *within* those periods rather than between
 * random values. Four things get us there:
 *
 * 1. **A hierarchy of periods, not one period.** Beat (~0.5s), bar (4 beats),
 *    phrase (8 bars). Every real arrangement has this nesting, and it is what
 *    lets a listener anticipate. A single period has nothing to anticipate.
 * 2. **An accented bar** (`BAR_ACCENTS`). Four identical beats are a
 *    metronome; four beats with a strong one are a bar.
 * 3. **Tempo that drifts.** Nothing played by a human is metronomic, and the
 *    micro-variation is a surprisingly large part of why a groove feels alive.
 *    The drift here is slow (~37s) and small (±6%) — deliberately below the
 *    threshold where you would call it a tempo change and above the threshold
 *    where the pulse feels quantised.
 * 4. **An asymmetric envelope** (`beatEnvelope`) — instant attack, long fall.
 *    A sine wave at beat rate is the canonical wrong answer: it spends as long
 *    rising as falling, so there is no instant you can point at as *the* beat.
 *
 * **Drift is expressed in closed form, not integrated.** The naive way to vary
 * tempo is to recompute `phase = t * bpm(t) / 60` each frame, which is wrong in
 * a way that is worth naming: changing the frequency retroactively moves every
 * *past* beat, so the pulse jitters forwards and backwards instead of speeding
 * up. The correct phase is the integral of frequency, and for a sinusoidally
 * varying frequency that integral has a closed form (`proceduralBeatsAt`). So
 * the signal stays a pure function of `atMs` — no accumulator, therefore no
 * drift over an eight-hour run, and a headless test can sample instants in any
 * order and get the same answers.
 */
import {
  BAND_COUNT,
  BEAT_DECAY_MS,
  BEAT_HOLD_MS,
  barAccent,
  beatEnvelope,
  clamp01,
  createReactivityFrame,
  effectiveDecayMs,
  type Reactivity,
  type ReactivityProvider,
} from './provider.js';

/**
 * The invented tempo, in BPM.
 *
 * Mid-tempo on purpose. Fast enough that the screen is clearly *doing*
 * something, slow enough that it is not a strobe on a device that sits in a
 * room and is looked at sideways for hours. It is also close to the middle of
 * where most pop actually lives, so on the tracks where Tier 1 never resolves,
 * the invented pulse is at least in the neighbourhood.
 */
export const PROCEDURAL_BPM = 112;

/** Peak tempo deviation, as a fraction. ±6% is rubato, not a tempo change. */
export const TEMPO_DRIFT = 0.06;

/** Seconds for one full drift cycle. Long enough to be felt, not counted. */
export const TEMPO_DRIFT_PERIOD_S = 37;

export const BEATS_PER_BAR = 4;
export const BARS_PER_PHRASE = 8;
export const BEATS_PER_PHRASE = BEATS_PER_BAR * BARS_PER_PHRASE;

/**
 * Energy never falls below this. An effect scaled by energy should get quiet,
 * not vanish — a black screen reads as a crash rather than as a quiet passage.
 */
export const ENERGY_FLOOR = 0.18;

/** Weights of the three timescales in `energy`. They sum to 1 by design. */
export const ENERGY_SWELL_WEIGHT = 0.45;
export const ENERGY_DRIFT_WEIGHT = 0.35;
export const ENERGY_BEAT_WEIGHT = 0.2;

/** Seconds per cell of the slow energy noise — the "which record is this" drift. */
export const ENERGY_DRIFT_PERIOD_S = 23;

/** Bands never fall below this: empty spectrum bars look like a dead process. */
export const BAND_FLOOR = 0.05;

/** How much of the bass end the beat drives, versus the noise field. */
export const BAND_KICK_WEIGHT = 0.38;
export const BAND_NOISE_WEIGHT = 0.62;

/** Cells per second for the band noise, at the bass end and at the treble end. */
export const BAND_RATE_MIN_HZ = 1.1;
export const BAND_RATE_MAX_HZ = 4.5;

/**
 * How far apart neighbouring bands sit in the noise field.
 *
 * Below 1 they share lattice points, so adjacent bars are correlated — which
 * is what a real spectrum does, and what produces the wave that travels across
 * a Winamp bar display. Give each band its own independent noise and you get
 * static; give them all the same and you get one wide bar.
 */
export const BAND_STRIDE = 0.42;

/** Spectral tilt: how much quieter the top band is than the bottom one. */
export const BAND_TILT = 0.55;

/** Arbitrary but fixed seeds, so a run is reproducible and the fields differ. */
const SEED_ENERGY = 0x4a05_1f27;
const SEED_BANDS = 0x1d7b_9c03;

/**
 * A 32-bit integer avalanche hash, normalised to `0..1`.
 *
 * Integer operations rather than the GLSL-idiomatic `fract(sin(x) * 43758.5)`
 * because `Math.sin` is implementation-defined in ECMAScript: the shader-style
 * hash would give subtly different numbers in Node and in the Pi's Chromium,
 * which is a poor foundation for a test suite that asserts signal properties.
 */
const hash01 = (cell: number, seed: number): number => {
  let h = (cell | 0) ^ Math.imul(seed, 0x9e37_79b1);
  h = Math.imul(h ^ (h >>> 16), 0x21f0_aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a_2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 4_294_967_296;
};

/** Cubic ease, so the noise has no corners at the lattice points. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * One-dimensional value noise in `0..1`: smooth, deterministic, seedable, and
 * — unlike a random number per frame — *continuous*, which is the whole
 * difference between drift and static.
 */
export const valueNoise = (x: number, seed: number): number => {
  const cell = Math.floor(x);
  const t = smoothstep(x - cell);
  const a = hash01(cell, seed);
  const b = hash01(cell + 1, seed);
  return a + (b - a) * t;
};

const DRIFT_OMEGA = (2 * Math.PI) / TEMPO_DRIFT_PERIOD_S;
const BASE_BEATS_PER_S = PROCEDURAL_BPM / 60;
const BASE_BEAT_PERIOD_MS = 60_000 / PROCEDURAL_BPM;

/**
 * Total beats elapsed at `elapsedS` — the integral of a sinusoidally drifting
 * tempo, in closed form.
 *
 * `f(t) = f₀ · (1 + d · sin(ωt))`, so `∫f = f₀ · (t + (d/ω) · (1 − cos ωt))`.
 * Differentiating this back gives the frequency exactly, which is the property
 * that matters: the tempo really does speed up and slow down, and no past beat
 * ever moves. Monotonic for any `d < 1`, so beats never run backwards.
 */
export const proceduralBeatsAt = (elapsedS: number): number =>
  BASE_BEATS_PER_S *
  (elapsedS + (TEMPO_DRIFT / DRIFT_OMEGA) * (1 - Math.cos(DRIFT_OMEGA * elapsedS)));

/**
 * Overall intensity, from three timescales at once.
 *
 * The swell is locked to the *beat* count rather than to wall time, so it
 * breathes with the tempo instead of sliding against it — an eight-bar phrase
 * stays eight bars long when the tempo drifts. Tier 1 passes its own beat
 * count in here, which is why this takes beats as a parameter rather than
 * computing them: the phrase then locks to the track's real tempo.
 */
export const proceduralEnergy = (
  beats: number,
  elapsedS: number,
  beat: number,
): number => {
  const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * beats) / BEATS_PER_PHRASE);
  const drift = valueNoise(elapsedS / ENERGY_DRIFT_PERIOD_S, SEED_ENERGY);
  const shaped =
    ENERGY_SWELL_WEIGHT * swell + ENERGY_DRIFT_WEIGHT * drift + ENERGY_BEAT_WEIGHT * beat;
  return clamp01(ENERGY_FLOOR + (1 - ENERGY_FLOOR) * shaped);
};

/**
 * Fill a spectrum that is invented but not arbitrary.
 *
 * Three properties do all the work of making sixteen numbers read as a
 * spectrum analyser rather than as sixteen random numbers:
 *
 * - **Tilt.** Real music loses energy with frequency. A flat spectrum reads as
 *   a test pattern; the falling shape is what says "audio".
 * - **Bass follows the beat.** A kick lives almost entirely below 120Hz, so if
 *   the low bars do not jump with the pulse, the bars and the flash look like
 *   two different songs playing at once.
 * - **Neighbours are correlated, but not equal** (`BAND_STRIDE`), so movement
 *   travels sideways across the display the way a real spectrum does.
 *
 * Writes in place into a caller-owned buffer: this is the hot path, and it
 * runs sixty times a second for hours.
 */
export const fillBands = (
  out: Float32Array,
  elapsedS: number,
  beat: number,
  energy: number,
): void => {
  for (let i = 0; i < BAND_COUNT; i += 1) {
    const k = i / (BAND_COUNT - 1);
    const tilt = 1 - BAND_TILT * k;
    // Squared so the kick is felt in the bottom three or four bars and is gone
    // by the middle, which is roughly where a kick drum actually stops.
    const lowness = 1 - k;
    const kick = beat * lowness * lowness;
    const rate = BAND_RATE_MIN_HZ + (BAND_RATE_MAX_HZ - BAND_RATE_MIN_HZ) * k;
    const wobble = valueNoise(elapsedS * rate + i * BAND_STRIDE, SEED_BANDS);
    const raw =
      tilt *
      (BAND_NOISE_WEIGHT * energy * (0.45 + 0.55 * wobble) + BAND_KICK_WEIGHT * kick);
    out[i] = clamp01(BAND_FLOOR + (1 - BAND_FLOOR) * raw);
  }
};

export interface ProceduralOptions {
  /**
   * The monotonic reading that counts as `t = 0`. Defaults to `0`, which makes
   * `sample(atMs)` a pure function of its argument — the easiest thing to
   * reason about in a test. Pass the clock's reading at mount if you would
   * rather the signal start from its beginning when the visualiser opens.
   */
  readonly originMs?: number | undefined;
}

/**
 * Tier 0. Holds one frame buffer and no other state: the signal is a function
 * of time, so there is nothing to accumulate and nothing to go stale.
 */
export const createProceduralProvider = (
  options: ProceduralOptions = {},
): ReactivityProvider => {
  const originMs = options.originMs ?? 0;
  const frame = createReactivityFrame();
  const decayMs = effectiveDecayMs(BASE_BEAT_PERIOD_MS, BEAT_DECAY_MS);

  return {
    tier: 0,
    sample: (atMs: number): Reactivity => {
      // A reading before the origin is a caller bug, not a rewound clock —
      // monotonic time cannot go backwards (D-023). Clamped rather than
      // trusted, because a negative elapsed would put the beat index negative
      // and the noise field into a region nothing else ever visits.
      const elapsedS = Math.max(0, atMs - originMs) / 1000;
      const beats = proceduralBeatsAt(elapsedS);
      const beatIndex = Math.floor(beats);
      const phase = beats - beatIndex;
      // Converting phase back to milliseconds via the *base* period rather
      // than the instantaneous one: a 6% tempo difference moves the decay by
      // 16ms, which nothing can see, and the base period keeps the envelope
      // shape identical from beat to beat.
      const beat = barAccent(beatIndex) * beatEnvelope(phase * BASE_BEAT_PERIOD_MS, BEAT_HOLD_MS, decayMs);
      const energy = proceduralEnergy(beats, elapsedS, beat);
      fillBands(frame.bands, elapsedS, beat, energy);
      frame.beat = beat;
      frame.energy = energy;
      frame.phase = phase;
      return frame;
    },
  };
};
