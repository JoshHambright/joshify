import { describe, expect, it } from 'vitest';
import {
  BAND_COUNT,
  BAR_ACCENTS,
  BEAT_DECAY_MS,
  BEAT_HOLD_MS,
  MAX_DECAY_BEAT_FRACTION,
  barAccent,
  beatEnvelope,
  clamp01,
  createReactivityFrame,
  effectiveDecayMs,
} from './provider.js';

/** One frame at 60fps. The rate the Pi's kiosk browser will call `sample()`. */
const FRAME_MS = 1000 / 60;

describe('clamping into the contract range', () => {
  it('passes values inside the range through untouched', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.37)).toBe(0.37);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps either end rather than reporting an out-of-range uniform', () => {
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
  });

  // A NaN uniform makes the whole fragment shader's output undefined, so one
  // bad sample blanks the screen of a device that is meant to run unattended
  // for hours. `Math.min(1, Math.max(0, NaN))` is NaN; this must not be.
  it('maps NaN to zero rather than letting it reach a shader', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('the beat envelope', () => {
  it('is at full value for the whole hold and nowhere else', () => {
    expect(beatEnvelope(0, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(1);
    expect(beatEnvelope(BEAT_HOLD_MS, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(1);
    expect(beatEnvelope(BEAT_HOLD_MS + 1, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBeLessThan(1);
  });

  /**
   * The reason the hold exists. With a truly instantaneous attack, a 60Hz
   * sampler sees whatever the decay had reached by the next frame boundary —
   * between 100% and about 78% depending on where the frame happened to fall.
   * That is a beat-to-beat brightness flicker with no musical cause.
   */
  it('is sampled at full value on some frame however the frames fall', () => {
    for (let phase = 0; phase < FRAME_MS; phase += 0.25) {
      let peak = 0;
      for (let t = phase; t < 500; t += FRAME_MS) {
        peak = Math.max(peak, beatEnvelope(t, BEAT_HOLD_MS, BEAT_DECAY_MS));
      }
      expect(peak).toBe(1);
    }
  });

  it('falls monotonically and reaches exactly zero at the end of the decay', () => {
    let previous = 1;
    for (let t = BEAT_HOLD_MS; t <= BEAT_HOLD_MS + BEAT_DECAY_MS; t += 1) {
      const value = beatEnvelope(t, BEAT_HOLD_MS, BEAT_DECAY_MS);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    expect(beatEnvelope(BEAT_HOLD_MS + BEAT_DECAY_MS, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(
      0,
    );
    expect(beatEnvelope(10_000, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(0);
  });

  // Symmetry is the thing to avoid: an envelope that rises as slowly as it
  // falls reads as breathing, never as a hit. Measured as the time spent in
  // the top half of the range before versus after the peak.
  it('spends far longer falling than rising, which is what reads as a strike', () => {
    let aboveHalf = 0;
    for (let t = 0; t < 500; t += 1) {
      if (beatEnvelope(t, BEAT_HOLD_MS, BEAT_DECAY_MS) >= 0.5) aboveHalf += 1;
    }
    // The rise is instantaneous, so everything above half is decay.
    expect(aboveHalf).toBeGreaterThan(BEAT_HOLD_MS * 2);
  });

  it('is silent before the beat, and for a NaN reading', () => {
    expect(beatEnvelope(-1, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(0);
    expect(beatEnvelope(Number.NaN, BEAT_HOLD_MS, BEAT_DECAY_MS)).toBe(0);
  });

  // A zero-length decay would divide by zero and put a NaN on the wire at
  // exactly the hold boundary, which is the one input value a caller is most
  // likely to hand it.
  it('is silent rather than NaN when asked for a decay of no length', () => {
    expect(beatEnvelope(BEAT_HOLD_MS, BEAT_HOLD_MS, 0)).toBe(0);
    expect(beatEnvelope(0, 0, 0)).toBe(0);
  });
});

describe('fitting the decay to the tempo', () => {
  // Percussion decay is a property of the instrument, not of the tempo, so it
  // is normally left alone...
  it('leaves the decay alone at ordinary tempos', () => {
    expect(effectiveDecayMs(500, BEAT_DECAY_MS)).toBe(BEAT_DECAY_MS);
    expect(effectiveDecayMs(1000, BEAT_DECAY_MS)).toBe(BEAT_DECAY_MS);
  });

  // ...but a pulse that never reaches zero is a glow, and the darkness between
  // beats is the whole reason the eye reads them as separate events.
  it('shortens it at fast tempos so the pulse still goes dark between beats', () => {
    const fastPeriod = 200;
    const decay = effectiveDecayMs(fastPeriod, BEAT_DECAY_MS);

    expect(decay).toBeLessThan(fastPeriod);
    expect(beatEnvelope(fastPeriod - 1, BEAT_HOLD_MS, decay)).toBe(0);
    expect(decay).toBe(fastPeriod * MAX_DECAY_BEAT_FRACTION);
  });
});

describe('the bar accent', () => {
  // Four identical beats are a metronome. The hierarchy is what makes them a
  // bar, and it is the cheapest musicality on offer.
  it('makes the downbeat the strongest beat of the bar', () => {
    const accents = BAR_ACCENTS.map((_, index) => barAccent(index));

    expect(accents[0]).toBe(1);
    for (const accent of accents.slice(1)) expect(accent).toBeLessThan(1);
  });

  it('repeats every bar, so any beat index is a valid question', () => {
    expect(barAccent(4)).toBe(barAccent(0));
    expect(barAccent(4_001)).toBe(barAccent(1));
  });

  // A track anchored ahead of the current position produces negative beat
  // indices, and JS `%` keeps the sign of the dividend — so a naive lookup
  // falls off the front of the table and reads `undefined`.
  it('is defined for negative beat indices', () => {
    expect(barAccent(-1)).toBe(barAccent(3));
    expect(barAccent(-4)).toBe(barAccent(0));
  });
});

describe('the frame buffer', () => {
  it('carries exactly the bands the uniform block declares', () => {
    const frame = createReactivityFrame();

    expect(frame.bands).toHaveLength(BAND_COUNT);
    expect(Array.from(frame.bands).every((value) => value === 0)).toBe(true);
  });
});
