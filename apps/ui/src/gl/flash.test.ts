/**
 * The flash floor, checked the way the legibility floor is: as a property of
 * the system, over the whole input range, rather than as a claim about the
 * presets somebody happened to write.
 */
import { describe, expect, it } from 'vitest';
import {
  beatRateHz,
  isAttenuated,
  limitBeat,
  MAX_FLASHES_PER_SECOND,
  MAX_UNATTENUATED_BPM,
  SAFE_LUMINANCE_SWING,
  safeBeatAmplitude,
} from './flash.js';

describe('the rate', () => {
  it.each([
    [60, 1],
    [120, 2],
    [180, 3],
    [240, 4],
  ])('reads %i BPM as %i flashes a second', (bpm, hz) => {
    expect(beatRateHz(bpm)).toBeCloseTo(hz, 6);
  });

  it('treats nonsense as no beats rather than as infinite ones', () => {
    expect(beatRateHz(0)).toBe(0);
    expect(beatRateHz(-120)).toBe(0);
    expect(beatRateHz(Number.NaN)).toBe(0);
  });
});

describe('most music is untouched', () => {
  // If the limiter fired on ordinary tempos it would be a bug dressed as a
  // safety feature: the visualiser would look flat on the music it is for.
  it.each([60, 90, 110, 128, 140, 160, 174, 180])('leaves %i BPM alone', (bpm) => {
    expect(safeBeatAmplitude(bpm)).toBe(1);
    expect(isAttenuated(bpm)).toBe(false);
    expect(limitBeat(1, bpm)).toBe(1);
  });

  it('draws the line exactly at three a second', () => {
    expect(MAX_UNATTENUATED_BPM).toBe(180);
    expect(isAttenuated(180)).toBe(false);
    expect(isAttenuated(181)).toBe(true);
  });
});

describe('fast music is attenuated, not silenced', () => {
  // 200 BPM is drum and bass, not an exotic case, and an eighth-note pulse at
  // 90 gets here too.
  it.each([181, 200, 240, 400])('holds %i BPM under the luminance threshold', (bpm) => {
    const amplitude = safeBeatAmplitude(bpm);

    expect(amplitude).toBeLessThanOrEqual(SAFE_LUMINANCE_SWING);
    expect(amplitude).toBeGreaterThan(0);
  });

  // Dropping beats to stay under the rate would put the visualiser out of time
  // with the music, which is both worse and far more noticeable.
  it('keeps the pulse on every beat, only shallower', () => {
    const fast = limitBeat(1, 220);

    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(limitBeat(1, 120));
  });

  it('scales a partial beat the same way, so the envelope keeps its shape', () => {
    const full = limitBeat(1, 220);
    const half = limitBeat(0.5, 220);

    expect(half).toBeCloseTo(full / 2, 6);
  });
});

describe('the signal it is given', () => {
  it('stays in range whatever it is handed', () => {
    for (const beat of [-1, 0, 0.5, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limited = limitBeat(beat, 200);
      expect(limited).toBeGreaterThanOrEqual(0);
      expect(limited).toBeLessThanOrEqual(1);
    }
  });

  // Tier 0 has no tempo to police against. Inventing one to check the pulse is
  // policing a number we made up.
  it('passes a procedural pulse through untouched', () => {
    expect(limitBeat(1, null)).toBe(1);
    expect(limitBeat(0.4, null)).toBeCloseTo(0.4, 6);
    expect(isAttenuated(null)).toBe(false);
  });

  it('respects a caller asking for less than full depth', () => {
    expect(safeBeatAmplitude(120, 0.3)).toBeCloseTo(0.3, 6);
    expect(safeBeatAmplitude(240, 0.3)).toBeLessThanOrEqual(SAFE_LUMINANCE_SWING);
    expect(safeBeatAmplitude(120, 0)).toBe(0);
  });
});

/**
 * The guarantee, stated as one assertion over the whole tempo range rather
 * than as a set of examples.
 */
describe('the guarantee', () => {
  it('never allows more than three threshold-crossing flashes a second', () => {
    for (let bpm = 1; bpm <= 400; bpm += 1) {
      const amplitude = safeBeatAmplitude(bpm);
      const crossesThreshold = amplitude > SAFE_LUMINANCE_SWING;
      const rate = beatRateHz(bpm);

      // Either the pulse is too shallow to count as a flash, or it happens at
      // most three times a second. Never both loud and fast.
      expect(
        !crossesThreshold || rate <= MAX_FLASHES_PER_SECOND,
        `${String(bpm)} BPM: amplitude ${String(amplitude)} at ${String(rate)} Hz`,
      ).toBe(true);
    }
  });
});
