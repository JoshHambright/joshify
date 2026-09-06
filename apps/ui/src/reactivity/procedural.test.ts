import { describe, expect, it } from 'vitest';
import { BAND_COUNT, BEAT_DECAY_MS, BEAT_HOLD_MS, type Reactivity } from './provider.js';
import {
  BAND_FLOOR,
  BAND_STRIDE,
  ENERGY_FLOOR,
  PROCEDURAL_BPM,
  TEMPO_DRIFT,
  createProceduralProvider,
  proceduralBeatsAt,
  proceduralEnergy,
  valueNoise,
} from './procedural.js';

const BEAT_PERIOD_MS = 60_000 / PROCEDURAL_BPM;

/** Copy a frame out, since the provider reuses the one it returns. */
const snapshot = (frame: Reactivity) => ({
  beat: frame.beat,
  energy: frame.energy,
  phase: frame.phase,
  bands: Array.from(frame.bands),
});

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const stdDev = (values: readonly number[]): number => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

describe('the noise field', () => {
  it('stays inside the contract range across a long walk', () => {
    for (let i = 0; i < 20_000; i += 1) {
      const value = valueNoise(i * 0.137 - 500, 12_345);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic, so a run is reproducible and a test can assert it', () => {
    expect(valueNoise(4.25, 7)).toBe(valueNoise(4.25, 7));
    expect(valueNoise(4.25, 7)).not.toBe(valueNoise(4.25, 8));
  });

  // Continuity is the entire difference between drift and static. A random
  // value per frame moves constantly and lands on nothing; this has to move
  // smoothly enough that the eye reads it as one thing changing.
  it('is continuous — a small step in time is a small step in value', () => {
    let worst = 0;
    for (let x = 0; x < 200; x += 0.01) {
      worst = Math.max(worst, Math.abs(valueNoise(x + 0.01, 3) - valueNoise(x, 3)));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('actually varies, rather than settling on a value', () => {
    const walk = Array.from({ length: 4_000 }, (_, i) => valueNoise(i * 0.31, 99));

    expect(stdDev(walk)).toBeGreaterThan(0.1);
  });

  // The property `fillBands` relies on to make neighbouring bars correlated:
  // a band-stride apart is a small step, seven bands apart is not. Without it
  // sixteen independent noise fields read as static.
  it('leaves neighbouring bands correlated and distant ones independent', () => {
    const near: number[] = [];
    const far: number[] = [];
    for (let x = 0; x < 500; x += 0.13) {
      near.push(Math.abs(valueNoise(x + BAND_STRIDE, 5) - valueNoise(x, 5)));
      far.push(Math.abs(valueNoise(x + BAND_STRIDE * 7, 5) - valueNoise(x, 5)));
    }
    expect(mean(near)).toBeLessThan(mean(far));
  });
});

describe('the drifting beat grid', () => {
  it('starts at zero and never runs backwards', () => {
    expect(proceduralBeatsAt(0)).toBe(0);

    let previous = -1;
    for (let t = 0; t < 3_600; t += 0.05) {
      const beats = proceduralBeatsAt(t);
      expect(beats).toBeGreaterThan(previous);
      previous = beats;
    }
  });

  it('averages the stated tempo over the long run', () => {
    // A whole hour, so any per-cycle bias in the drift would show up.
    const beats = proceduralBeatsAt(3_600);
    const expected = (PROCEDURAL_BPM / 60) * 3_600;

    expect(beats / expected).toBeCloseTo(1, 2);
  });

  /**
   * The point of the closed-form integral. Recomputing `t * bpm(t) / 60` each
   * frame retroactively moves every past beat, so the pulse jitters forwards
   * and backwards instead of speeding up. Here the instantaneous rate varies
   * by the stated amount and no beat instant ever moves.
   */
  it('varies the instantaneous tempo by the stated drift and no more', () => {
    const rates: number[] = [];
    for (let t = 0; t < 120; t += 0.1) {
      rates.push((proceduralBeatsAt(t + 0.001) - proceduralBeatsAt(t)) / 0.001);
    }
    const base = PROCEDURAL_BPM / 60;
    const fastest = Math.max(...rates) / base;
    const slowest = Math.min(...rates) / base;

    expect(fastest).toBeCloseTo(1 + TEMPO_DRIFT, 2);
    expect(slowest).toBeCloseTo(1 - TEMPO_DRIFT, 2);
  });

  // Eight hours of a device left on a shelf. Nothing accumulates, so there is
  // nothing to drift: the beat count is still exactly the closed form.
  it('does not drift over an all-day run, because nothing accumulates', () => {
    const eightHoursS = 8 * 3_600;
    const direct = proceduralBeatsAt(eightHoursS);
    const provider = createProceduralProvider();
    const late = provider.sample(eightHoursS * 1000);

    expect(late.phase).toBeCloseTo(direct - Math.floor(direct), 9);
  });
});

describe('the energy envelope', () => {
  it('never falls to silence and never pins at full', () => {
    const values: number[] = [];
    for (let t = 0; t < 600; t += 0.05) {
      values.push(proceduralEnergy(proceduralBeatsAt(t), t, 0));
    }
    expect(Math.min(...values)).toBeGreaterThanOrEqual(ENERGY_FLOOR);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
  });

  // A constant energy is a screensaver and a jumpy one is a fault. This asserts
  // it breathes: enough movement to be felt, spread over seconds not frames.
  it('breathes across seconds rather than sitting still', () => {
    const values: number[] = [];
    for (let t = 0; t < 600; t += 0.1) {
      values.push(proceduralEnergy(proceduralBeatsAt(t), t, 0));
    }
    expect(stdDev(values)).toBeGreaterThan(0.08);

    let worstStep = 0;
    for (let i = 1; i < values.length; i += 1) {
      worstStep = Math.max(worstStep, Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)));
    }
    expect(worstStep).toBeLessThan(0.02);
  });

  it('rises with the beat it is given', () => {
    expect(proceduralEnergy(0, 0, 1)).toBeGreaterThan(proceduralEnergy(0, 0, 0));
  });
});

describe('sampling the procedural provider', () => {
  it('reports itself as the always-available floor', () => {
    expect(createProceduralProvider().tier).toBe(0);
  });

  it('keeps every value inside the contract across thousands of samples', () => {
    const provider = createProceduralProvider();
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let lowestBand = Number.POSITIVE_INFINITY;
    // Two and a half minutes at 60fps, sampled at an irrational-ish step so
    // the walk never falls into step with the beat grid.
    for (let i = 0; i < 20_000; i += 1) {
      const frame = provider.sample(i * 7.5);
      for (const value of [frame.beat, frame.energy, frame.phase]) {
        lowest = Math.min(lowest, value);
        highest = Math.max(highest, value);
      }
      for (const band of frame.bands) {
        lowestBand = Math.min(lowestBand, band);
        highest = Math.max(highest, band);
      }
    }

    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(1);
    expect(lowestBand).toBeGreaterThanOrEqual(BAND_FLOOR - 1e-6);
  });

  /**
   * The contract's central promise (D-042/D-043): no internal timer, no
   * accumulator, so the same instant always yields the same frame and the
   * headless engine test can drive instants in any order it likes.
   */
  it('is a pure function of the instant, in any order', () => {
    const provider = createProceduralProvider();
    const forwards = [1_000, 2_500, 9_100].map((at) => snapshot(provider.sample(at)));
    const backwards = [9_100, 2_500, 1_000].map((at) => snapshot(provider.sample(at)));

    expect(backwards.reverse()).toEqual(forwards);
  });

  // Documented aliasing: the frame is owned by the provider and reused, because
  // sixty fresh objects and Float32Arrays a second is garbage a Pi does not
  // need to make while it is also running a shader chain.
  it('reuses one frame rather than allocating per call', () => {
    const provider = createProceduralProvider();

    expect(provider.sample(0)).toBe(provider.sample(1_000));
  });

  it('measures elapsed time from the origin it was given', () => {
    const shifted = createProceduralProvider({ originMs: 5_000 });

    expect(snapshot(shifted.sample(5_000))).toEqual(
      snapshot(createProceduralProvider().sample(0)),
    );
  });

  // Monotonic time cannot rewind (D-023), so a reading before the origin is a
  // caller bug. Clamped rather than trusted: a negative elapsed would drive the
  // beat index negative and the noise into a region nothing else visits.
  it('clamps a reading from before its origin instead of running backwards', () => {
    const provider = createProceduralProvider({ originMs: 1_000 });

    expect(snapshot(provider.sample(0))).toEqual(snapshot(provider.sample(1_000)));
  });
});

describe('the shape of the procedural pulse', () => {
  /** Instants where the beat phase wrapped, sampled at 1ms. */
  const beatOnsets = (fromMs: number, toMs: number): number[] => {
    const provider = createProceduralProvider();
    const onsets: number[] = [];
    let previous = provider.sample(fromMs).phase;
    for (let t = fromMs + 1; t < toMs; t += 1) {
      const phase = provider.sample(t).phase;
      if (phase < previous) onsets.push(t);
      previous = phase;
    }
    return onsets;
  };

  it('pulses at roughly the tempo it claims', () => {
    const onsets = beatOnsets(0, 60_000);
    const gaps: number[] = [];
    for (let i = 1; i < onsets.length; i += 1) {
      gaps.push((onsets[i] ?? 0) - (onsets[i - 1] ?? 0));
    }

    // Not exact, and it must not be: the window is not a whole number of drift
    // cycles, so the mean spacing over any given minute sits a little either
    // side of the nominal period. That is the point of the drift.
    expect(mean(gaps)).toBeGreaterThan(BEAT_PERIOD_MS * 0.94);
    expect(mean(gaps)).toBeLessThan(BEAT_PERIOD_MS * 1.06);
  });

  /**
   * The screensaver test. A pulse at an exactly fixed rate is found by the eye
   * within a couple of seconds, after which there is no more information
   * coming. The drift has to be present in the actual beat spacing, not just
   * in the formula.
   */
  it('does not land on a metronomic grid', () => {
    const onsets = beatOnsets(0, 60_000);
    const gaps: number[] = [];
    for (let i = 1; i < onsets.length; i += 1) {
      gaps.push((onsets[i] ?? 0) - (onsets[i - 1] ?? 0));
    }

    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(30);
    // ...but it is still recognisably a tempo, not a random sequence.
    expect(stdDev(gaps) / mean(gaps)).toBeLessThan(TEMPO_DRIFT);
  });

  /**
   * The metronome test. Four identical beats read as counting; a bar has a
   * shape. Every fourth peak should be the loud one.
   */
  it('accents the downbeat, so four beats read as a bar', () => {
    const provider = createProceduralProvider();
    const onsets = beatOnsets(0, 20_000);
    const peaks = onsets.map((onset) => provider.sample(onset).beat);
    const strong = peaks.filter((peak) => peak > 0.95);

    expect(new Set(peaks.map((peak) => peak.toFixed(2))).size).toBeGreaterThanOrEqual(3);
    // One beat in four is the downbeat, give or take the ends of the window.
    expect(strong.length / peaks.length).toBeCloseTo(0.25, 1);
  });

  it('goes fully dark between beats, which is what makes them separate events', () => {
    const provider = createProceduralProvider();
    const quiet = provider.sample(BEAT_HOLD_MS + BEAT_DECAY_MS + 5).beat;

    expect(quiet).toBe(0);
  });
});

describe('the synthesised spectrum', () => {
  const spectrumOver = (samples: number): number[][] => {
    const provider = createProceduralProvider();
    return Array.from({ length: samples }, (_, i) =>
      Array.from(provider.sample(i * 11).bands),
    );
  };

  // Real music loses energy with frequency. A flat spectrum reads as a test
  // pattern; the falling shape is what says "audio" before anything moves.
  it('tilts towards the bass, the way a real spectrum does', () => {
    const frames = spectrumOver(2_000);
    const bass = mean(frames.map((bands) => mean(bands.slice(0, 4))));
    const treble = mean(frames.map((bands) => mean(bands.slice(-4))));

    expect(bass).toBeGreaterThan(treble * 1.5);
  });

  /**
   * If the low bars do not jump with the pulse, the bars and the flash look
   * like two different songs playing at once. A kick lives almost entirely
   * below 120Hz, so the effect must be concentrated at the bottom.
   */
  it('drives the bass bars from the beat and leaves the treble alone', () => {
    const provider = createProceduralProvider();
    const onBeat = Array.from(provider.sample(0).bands);
    // Far enough past the beat that the envelope has fully decayed.
    const offBeat = Array.from(provider.sample(BEAT_HOLD_MS + BEAT_DECAY_MS + 20).bands);
    const bassJump = (onBeat[0] ?? 0) - (offBeat[0] ?? 0);
    const trebleJump = (onBeat[BAND_COUNT - 1] ?? 0) - (offBeat[BAND_COUNT - 1] ?? 0);

    expect(bassJump).toBeGreaterThan(0.1);
    expect(Math.abs(trebleJump)).toBeLessThan(bassJump / 2);
  });

  // Empty bars look like a dead process, which is the one thing a visualiser
  // must never look like.
  it('never leaves a bar sitting at nothing', () => {
    for (const bands of spectrumOver(2_000)) {
      expect(Math.min(...bands)).toBeGreaterThanOrEqual(BAND_FLOOR - 1e-6);
    }
  });

  it('moves every bar, rather than animating a few and freezing the rest', () => {
    const frames = spectrumOver(1_000);
    for (let band = 0; band < BAND_COUNT; band += 1) {
      expect(stdDev(frames.map((bands) => bands[band] ?? 0))).toBeGreaterThan(0.01);
    }
  });
});
