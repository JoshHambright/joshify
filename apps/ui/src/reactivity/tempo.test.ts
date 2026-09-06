import { describe, expect, it } from 'vitest';
import { createProceduralProvider } from './procedural.js';
import { BAND_COUNT, barAccent, type Reactivity } from './provider.js';
import { MAX_TAP_BPM, MIN_TAP_BPM } from './tap-tempo.js';
import {
  ANCHOR_TOLERANCE_MS,
  beatPeriodMs,
  beatsAt,
  createTempoProvider,
  isUsableBpm,
  positionAt,
  type TempoAnchor,
} from './tempo.js';

/** 120 BPM, so a beat is a round 500ms and the arithmetic stays readable. */
const anchor = (over: Partial<TempoAnchor> = {}): TempoAnchor => ({
  bpm: 120,
  positionMs: 0,
  atMs: 1_000,
  playing: true,
  ...over,
});

const snapshot = (frame: Reactivity) => ({
  beat: frame.beat,
  energy: frame.energy,
  phase: frame.phase,
  bands: Array.from(frame.bands),
});

describe('reading a tempo grid', () => {
  it('is a beat period per minute', () => {
    expect(beatPeriodMs(120)).toBe(500);
    expect(beatPeriodMs(60)).toBe(1_000);
  });

  // The anchor describes a line, not a starting gun: a tap fitted across the
  // last few seconds legitimately asks about instants before the last poll.
  it('extrapolates the position in both directions from the anchor', () => {
    expect(positionAt(anchor({ positionMs: 30_000 }), 3_000)).toBe(32_000);
    expect(positionAt(anchor({ positionMs: 30_000 }), 0)).toBe(29_000);
  });

  // A paused track has no beats, so its position must not creep.
  it('freezes the position while playback is paused', () => {
    const paused = anchor({ positionMs: 30_000, playing: false });

    expect(positionAt(paused, 99_000)).toBe(30_000);
  });

  it('counts beats from the offset, whole numbers on the beat', () => {
    expect(beatsAt(anchor(), 0, 1_000)).toBe(0);
    expect(beatsAt(anchor(), 0, 3_000)).toBe(4);
    expect(beatsAt(anchor(), 250, 3_000)).toBe(3.5);
  });

  it('accepts musical tempos and refuses the rest', () => {
    expect(isUsableBpm(120)).toBe(true);
    expect(isUsableBpm(MIN_TAP_BPM)).toBe(true);
    expect(isUsableBpm(MAX_TAP_BPM)).toBe(true);
    expect(isUsableBpm(0)).toBe(false);
    expect(isUsableBpm(MAX_TAP_BPM + 1)).toBe(false);
    expect(isUsableBpm(Number.NaN)).toBe(false);
  });
});

describe('falling back when there is no tempo', () => {
  /**
   * The graceful degradation D-010 exists for. A BPM lookup that misses is a
   * quieter visualiser, not a stopped one, and every preset is authored
   * against this signal anyway.
   */
  it('is Tier 0, frame for frame, until a tempo arrives', () => {
    const tempo = createTempoProvider();
    const tier0 = createProceduralProvider();

    expect(tempo.tier).toBe(0);
    expect(tempo.bpm).toBeNull();
    expect(snapshot(tempo.sample(7_000))).toEqual(snapshot(tier0.sample(7_000)));
  });

  it('promotes itself to Tier 1 the moment one does', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());

    expect(provider.tier).toBe(1);
    expect(provider.bpm).toBe(120);
  });

  /**
   * A lookup returning 0, 900 or a NaN must not become a stopped pulse or a
   * strobe. An unusable tempo is not information: it neither starts a grid nor
   * destroys one that is already running.
   */
  it('ignores an unusable tempo rather than acting on it', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor({ bpm: 0 }));

    expect(provider.tier).toBe(0);

    provider.setAnchor(anchor());
    provider.setAnchor(anchor({ bpm: 900 }));

    expect(provider.bpm).toBe(120);
  });
});

describe('locking the pulse to a known tempo', () => {
  const build = () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());
    return provider;
  };

  it('peaks on every beat of the grid and is dark between them', () => {
    const provider = build();
    for (let beat = 0; beat < 40; beat += 1) {
      const at = 1_000 + beat * 500;

      expect(provider.sample(at).beat).toBe(1);
      expect(provider.sample(at + 300).beat).toBe(0);
    }
  });

  /**
   * The phase is computed, never accumulated, so an hour of playback lands on
   * exactly the same grid as the first bar. A visualiser that slips by a beat
   * over a long album is the failure this design exists to make impossible.
   */
  it('is still exactly on the beat an hour later', () => {
    const provider = build();
    const anHourIn = 1_000 + 60 * 60 * 1_000;

    expect(provider.sample(anHourIn).beat).toBe(1);
    expect(provider.sample(anHourIn + 300).beat).toBe(0);
  });

  it('keeps every value inside the contract across thousands of samples', () => {
    const provider = build();
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 20_000; i += 1) {
      const frame = provider.sample(1_000 + i * 7.5);
      for (const value of [frame.beat, frame.energy, frame.phase, ...frame.bands]) {
        lowest = Math.min(lowest, value);
        highest = Math.max(highest, value);
      }
    }

    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(1);
    expect(provider.sample(0).bands).toHaveLength(BAND_COUNT);
  });

  /**
   * Anchoring in track position rather than wall time is what makes a seek
   * behave: the grid belongs to the recording, so jumping to 0:33 lands on the
   * beat grid at 0:33 instead of wherever the clock had got to.
   */
  it('moves the grid with the music across a real seek', () => {
    const provider = build();
    provider.setAnchor(anchor({ positionMs: 33_000, atMs: 4_000 }));

    expect(provider.sample(4_000).beat).toBe(1);
    expect(provider.sample(4_300).beat).toBe(0);
  });

  /**
   * ...but every poll is stale by a round trip, so successive anchors describe
   * the same line with noise on it. At 120 BPM, ±120ms of noise is a quarter
   * of a beat, and taken literally the pulse would trip once per poll. Small
   * corrections move the grid with them so no beat instant moves at all
   * (the same rule D-024 applies to the progress bar).
   */
  it('absorbs poll jitter instead of staggering once per poll', () => {
    const provider = build();
    const before = provider.sample(9_000).beat;

    for (const [index, jitter] of [120, -95, 60, -140].entries()) {
      const atMs = 4_000 + index * 1_000;
      provider.setAnchor(anchor({ atMs, positionMs: atMs - 1_000 + jitter }));
    }

    expect(provider.sample(9_000).beat).toBe(before);
    expect(provider.sample(9_000).beat).toBe(1);
  });

  it('takes a correction larger than the tolerance at face value', () => {
    const provider = build();
    const drifted = ANCHOR_TOLERANCE_MS + 500;
    provider.setAnchor(anchor({ atMs: 4_000, positionMs: 3_000 + drifted }));

    // The grid is back in step with the track's own position, not with the
    // pulse we had been drawing.
    expect(provider.sample(4_000).phase).toBeCloseTo(0, 9);
  });

  /**
   * A paused track produces no beats. Freezing the envelope wherever it
   * happened to be would leave the screen lit and stuck; going to zero while
   * the bands keep drifting makes it idle instead.
   */
  it('stops pulsing when playback pauses, without going dark', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor({ playing: false, positionMs: 30_000 }));
    const frame = provider.sample(5_000);

    expect(frame.beat).toBe(0);
    expect(frame.energy).toBeGreaterThan(0);
    expect(Math.min(...frame.bands)).toBeGreaterThan(0);
  });
});

describe('what a tempo alone does not tell us', () => {
  /**
   * With a tempo and nothing else, every beat is equally likely to be the
   * downbeat. Claiming a bar we were not told about is the same error as
   * claiming a phase we were not told about — and worse, because a wrong
   * accent is legible: the eye locks to it and then keeps being wrong.
   */
  it('weights every beat the same until someone taps', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());

    expect(provider.barAligned).toBe(false);
    for (let beat = 0; beat < 8; beat += 1) {
      expect(provider.sample(1_000 + beat * 500).beat).toBe(1);
    }
  });

  it('accents the bar once a tap has said where it starts', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());
    provider.tap(1_123);

    expect(provider.barAligned).toBe(true);
    expect(provider.sample(1_123).beat).toBe(1);
    expect(provider.sample(1_623).beat).toBeCloseTo(barAccent(1), 9);
    expect(provider.sample(3_123).beat).toBe(1);
  });
});

describe('tapping the phase in', () => {
  it('moves the pulse to where the finger landed, from one tap', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());

    // 123ms into a 500ms beat: on the decay, nowhere near a peak.
    expect(provider.sample(1_123).beat).toBeLessThan(0.5);

    expect(provider.tap(1_123)).toBe(120);
    expect(provider.sample(1_123).beat).toBe(1);
    expect(provider.sample(1_623).beat).toBeGreaterThan(0.5);
  });

  it('keeps the tempo it was given when a tap only fixes the phase', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor({ bpm: 96 }));
    provider.tap(2_000);

    expect(provider.bpm).toBe(96);
  });

  /**
   * Tapping a tempo from nothing: no lookup, no server, no track position. The
   * grid is hung on the monotonic clock the taps were measured with, which is
   * arbitrary but self-consistent — and it means Tier 1 is reachable on a
   * track the BPM database has never heard of.
   */
  it('establishes a tempo from four taps with no lookup at all', () => {
    const provider = createTempoProvider();

    expect(provider.tap(1_000)).toBeNull();
    expect(provider.tap(1_500)).toBeNull();
    expect(provider.tap(2_000)).toBeNull();
    expect(provider.tap(2_500)).toBeCloseTo(120, 6);

    expect(provider.tier).toBe(1);
    expect(provider.sample(2_500).beat).toBe(1);
    expect(provider.sample(3_000).beat).toBeGreaterThan(0.5);
  });

  /**
   * The tapped grid was hung on the clock; a real anchor puts it in track
   * position. The music has not changed, only the coordinates, so the beat
   * instants must survive the move — otherwise the lookup arriving would undo
   * the tap the user had just made.
   */
  it('carries a tapped grid across into track position when a lookup lands', () => {
    const provider = createTempoProvider();
    for (const at of [1_000, 1_500, 2_000, 2_500]) provider.tap(at);

    provider.setAnchor(anchor({ bpm: 120, positionMs: 90_000, atMs: 4_000 }));

    // The tapped downbeat was 1000ms; 4000ms is beat seven of that grid, so
    // both the beat instants *and* the position within the bar survived.
    expect(provider.tier).toBe(1);
    expect(provider.sample(4_000).beat).toBe(barAccent(3));
    expect(provider.sample(4_500).beat).toBe(1);
    expect(provider.sample(4_300).beat).toBe(0);
  });

  // A fumbled tap inside an otherwise steady sequence must not become the
  // tempo. The end-to-end version of the tap-tempo unit test.
  it('does not let one mistimed tap set the tempo', () => {
    const provider = createTempoProvider();
    for (const at of [0, 500, 1_000, 2_000, 2_500, 3_000]) provider.tap(at);

    expect(provider.bpm).toBeCloseTo(120, 6);
  });
});

describe('nudging a pulse that is merely early', () => {
  const aligned = () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());
    provider.tap(1_000);
    return provider;
  };

  it('shifts the grid by a sixteenth without touching the tempo', () => {
    const provider = aligned();
    provider.nudge(1);

    expect(provider.bpm).toBe(120);
    expect(provider.sample(1_000).beat).toBeLessThan(1);
    expect(provider.sample(1_000 + 500 / 16).beat).toBe(1);
  });

  it('goes back the other way', () => {
    const provider = aligned();
    provider.nudge(3);
    provider.nudge(-3);

    expect(provider.sample(1_000).beat).toBe(1);
  });

  it('does nothing when there is no grid to nudge', () => {
    const provider = createTempoProvider();
    provider.nudge(1);

    expect(provider.tier).toBe(0);
  });
});

describe('changing track', () => {
  /**
   * A phase locked to the previous track is worse than no phase at all: it is
   * a confident wrong answer, and the visualiser would spend the whole of the
   * new song insisting on it. Tempo, phase and taps all belonged to the last
   * recording, and none of them transfers.
   */
  it('forgets the tempo, the phase and the taps, and drops to Tier 0', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());
    provider.tap(1_123);

    provider.trackChanged();

    expect(provider.tier).toBe(0);
    expect(provider.bpm).toBeNull();
    expect(provider.barAligned).toBe(false);
    expect(snapshot(provider.sample(7_000))).toEqual(
      snapshot(createProceduralProvider().sample(7_000)),
    );
  });

  it('starts the next track on its own grid rather than the last one', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());
    provider.tap(1_123);
    provider.trackChanged();
    provider.setAnchor(anchor({ atMs: 20_000 }));

    // Offset back to zero: beats fall on the new track's position grid.
    expect(provider.sample(20_000).beat).toBe(1);
    expect(provider.sample(20_123).beat).toBeLessThan(1);
  });
});

describe('the provider contract', () => {
  it('reuses one frame rather than allocating per call', () => {
    const provider = createTempoProvider();
    provider.setAnchor(anchor());

    expect(provider.sample(2_000)).toBe(provider.sample(3_000));
  });

  it('clamps a reading from before its origin instead of running backwards', () => {
    const provider = createTempoProvider({ originMs: 5_000 });
    // Paused, so the beat grid is frozen and the only thing left moving is the
    // elapsed-time field the clamp applies to.
    provider.setAnchor(anchor({ atMs: 0, playing: false }));

    expect(snapshot(provider.sample(-1_000))).toEqual(snapshot(provider.sample(0)));
  });

  it('accepts an injected fallback, which is how a test scripts Tier 0', () => {
    const scripted = createProceduralProvider({ originMs: 100_000 });
    const provider = createTempoProvider({ fallback: scripted });

    expect(snapshot(provider.sample(100_500))).toEqual(
      snapshot(scripted.sample(100_500)),
    );
  });
});
