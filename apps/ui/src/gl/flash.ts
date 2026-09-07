/**
 * The flash floor.
 *
 * A screen on a wall, running unattended, pulsing on every beat is the exact
 * shape of a photosensitivity hazard. WCAG 2.2 §2.3.1 draws the line at **three
 * flashes per second**, where a flash is a pair of opposing changes in relative
 * luminance of 10% or more with the darker state below 0.8.
 *
 * Three per second is 180 BPM. That is not an exotic tempo — it is drum and
 * bass, a lot of hardcore, and any track where the beat lands on eighths at 90.
 * So this is not a theoretical limit the presets happen to sit under; it is a
 * line the visualiser would cross on ordinary music, on a device nobody is
 * standing next to, quite possibly in a room with a child in it.
 *
 * ## Why it is enforced here rather than in each pass
 *
 * The same argument as the legibility floor (D-068). A rule each effect has to
 * remember is a rule the twenty-third effect forgets. `uBeat` is the single
 * channel every beat-driven effect reads, so attenuating *it* covers every
 * effect that exists and every effect nobody has written yet.
 *
 * ## Why attenuate rather than drop beats
 *
 * Skipping beats above the threshold makes the visualiser fall out of time with
 * the music, which is worse than a shallower pulse and much more noticeable.
 * Attenuation keeps the rhythm and reduces the depth: at 200 BPM the panel still
 * moves on every beat, it just stops flashing hard enough to count as a flash.
 */

/** WCAG 2.2 §2.3.1. Three in any one second. */
export const MAX_FLASHES_PER_SECOND = 3;

/**
 * The relative-luminance swing below which a change is not a "flash" at all.
 *
 * WCAG's general flash threshold. Staying under it means the rate limit stops
 * applying, which is the escape hatch fast music needs.
 */
export const FLASH_LUMINANCE_THRESHOLD = 0.1;

/**
 * Headroom under the threshold.
 *
 * The 10% figure is the point at which a change *becomes* a flash, so sitting
 * exactly on it is sitting exactly on the hazard. Effects also stack — two
 * beat-driven passes in one chain each swinging 9% is not 9%.
 */
export const FLASH_SAFETY_MARGIN = 0.6;

/** The usable excursion: 6% relative luminance. */
export const SAFE_LUMINANCE_SWING = FLASH_LUMINANCE_THRESHOLD * FLASH_SAFETY_MARGIN;

/** Beats per second. */
export const beatRateHz = (bpm: number): number => {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  return bpm / 60;
};

/**
 * How much of a requested beat amplitude is safe at this tempo.
 *
 * Returns 1 below the rate limit — most music, most of the time, unattenuated.
 * Above it, the factor that brings a full-depth pulse under the luminance
 * threshold, so the flash stops being a flash rather than the beat stopping
 * being a beat.
 */
export const safeBeatAmplitude = (bpm: number, requested = 1): number => {
  const amplitude = Math.min(1, Math.max(0, requested));
  if (amplitude === 0) return 0;

  const rate = beatRateHz(bpm);
  if (rate <= MAX_FLASHES_PER_SECOND) return amplitude;

  // Above the rate limit the only way to stay compliant is to stop crossing
  // the luminance threshold. A pulse of `amplitude` swings roughly that much
  // of the full range, so the cap is the swing budget expressed as a fraction
  // of what was asked for.
  return Math.min(amplitude, SAFE_LUMINANCE_SWING);
};

/**
 * Apply the floor to a sampled beat value.
 *
 * The signal keeps its shape and its timing; only its depth changes. A caller
 * that does not know the tempo — Tier 0, where there is no BPM to know — passes
 * `null` and gets the value back untouched, because a procedural pulse is
 * already slow by construction (D-063) and inventing a tempo to police it
 * against would be policing a number we made up.
 */
export const limitBeat = (beat: number, bpm: number | null): number => {
  if (!Number.isFinite(beat)) return 0;
  const clamped = Math.min(1, Math.max(0, beat));
  if (bpm === null) return clamped;
  return clamped * safeBeatAmplitude(bpm);
};

/** Whether a tempo needs the limiter at all. Exported so the UI can say so. */
export const isAttenuated = (bpm: number | null): boolean =>
  bpm !== null && beatRateHz(bpm) > MAX_FLASHES_PER_SECOND;

/**
 * The fastest tempo that passes unattenuated, for documentation and tests.
 * 180 BPM.
 */
export const MAX_UNATTENUATED_BPM = MAX_FLASHES_PER_SECOND * 60;
