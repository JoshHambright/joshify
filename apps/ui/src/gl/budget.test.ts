import { describe, expect, it } from 'vitest';
import {
  createDegrader,
  DEFAULT_SCALE,
  isMissedFrame,
  levelAt,
  maxStepFor,
  renderSizeFor,
  scaleLadderFrom,
  SCALE_LADDER,
  type Degrader,
} from './budget.js';

const PANEL = { width: 720, height: 1280 };

/** 60fps is 16.7ms; anything under the 1.25x margin is a frame we kept. */
const GOOD_MS = 16;
const MISSED_MS = 33;

const feed = (degrader: Degrader, frames: number, frameMs: number): void => {
  for (let index = 0; index < frames; index += 1) degrader.observe(frameMs);
};

describe('the grain slider', () => {
  // The panel is 720x1280 (D-039), so half of it is exactly the 360x640 the
  // chain renders at by default (D-011).
  it('turns a scale into the pixels the chain actually renders', () => {
    expect(renderSizeFor(PANEL, 0.5)).toEqual({ width: 360, height: 640 });
    expect(renderSizeFor(PANEL, 1)).toEqual(PANEL);
    expect(renderSizeFor(PANEL, 0.25)).toEqual({ width: 180, height: 320 });
  });

  it('rounds rather than truncating, so an odd panel keeps its aspect', () => {
    expect(renderSizeFor({ width: 721, height: 101 }, 0.5)).toEqual({
      width: 361,
      height: 51,
    });
  });

  /**
   * A zero-width framebuffer is a GL error, not a small picture — and a scale
   * arrives from a slider, so one day it will arrive as 0.
   */
  it('never produces a zero-sized target', () => {
    expect(renderSizeFor({ width: 8, height: 8 }, 0)).toEqual({ width: 1, height: 1 });
    expect(renderSizeFor(PANEL, Number.NaN)).toEqual(PANEL);
    expect(renderSizeFor(PANEL, 4)).toEqual(PANEL);
  });
});

describe('the ladder', () => {
  it('starts at what the user asked for and only ever goes down', () => {
    expect(scaleLadderFrom(0.5)).toEqual([0.5, 0.35, 0.25]);
    expect(scaleLadderFrom(1)).toEqual(SCALE_LADDER);
    // A slider position between rungs still leads; it is the user's choice.
    expect(scaleLadderFrom(0.6)).toEqual([0.6, 0.5, 0.35, 0.25]);
    expect(scaleLadderFrom(Number.NaN)).toEqual([DEFAULT_SCALE, 0.35, 0.25]);
  });

  it('has nowhere to go below the last rung', () => {
    expect(scaleLadderFrom(0.25)).toEqual([0.25]);
    expect(maxStepFor(0.25, 2)).toBe(2);
  });

  /**
   * Scale first, then passes. Halving the scale is a 4x saving for a softer
   * picture; dropping a pass removes an effect the preset was chosen for, so
   * it is the later, worse trade.
   */
  it('spends the whole scale ladder before it drops a single pass', () => {
    const level = (step: number) => levelAt(step, 0.5, 2);

    expect(level(0)).toEqual({ scale: 0.5, maxPasses: 2 });
    expect(level(1)).toEqual({ scale: 0.35, maxPasses: 2 });
    expect(level(2)).toEqual({ scale: 0.25, maxPasses: 2 });
    expect(level(3)).toEqual({ scale: 0.25, maxPasses: 1 });
    expect(level(4)).toEqual({ scale: 0.25, maxPasses: 0 });
  });

  // The bottom of the ladder is an empty chain over a scene, never a blank
  // screen: the scene is not on the ladder at all (D-014).
  it('stops at the bottom instead of going negative', () => {
    expect(levelAt(9, 0.5, 2)).toEqual({ scale: 0.25, maxPasses: 0 });
    expect(levelAt(-4, 0.5, 2)).toEqual({ scale: 0.5, maxPasses: 2 });
  });

  it('treats a frame as missed only past the jitter margin', () => {
    expect(isMissedFrame(16.6, 60)).toBe(false);
    // 20.8ms is the 1.25x line; a compositor routinely lands here on a healthy
    // 60fps frame, and degrading for that would punish a screen that is fine.
    expect(isMissedFrame(20, 60)).toBe(false);
    expect(isMissedFrame(21, 60)).toBe(true);
    expect(isMissedFrame(21, 30)).toBe(false);
  });
});

describe('degrading when frames go missing', () => {
  it('says nothing until it has a full window to say it about', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 44, MISSED_MS);

    expect(degrader.step).toBe(0);
    expect(degrader.quality).toEqual({ scale: DEFAULT_SCALE, maxPasses: 2 });
  });

  it('takes one step per window, not one per bad frame', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 45, MISSED_MS);
    expect(degrader.step).toBe(1);

    feed(degrader, 45, MISSED_MS);
    expect(degrader.step).toBe(2);
  });

  /**
   * The window is the hysteresis that matters most: a track change decodes
   * artwork and drops a handful of frames on a machine that is otherwise
   * comfortable, and that must not cost anyone their resolution.
   */
  it('rides out a hitch that is under a fifth of the window', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 9, MISSED_MS);
    feed(degrader, 36, GOOD_MS);

    expect(degrader.step).toBe(0);
  });

  it('acts once the misses are more than a fifth of the window', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 10, MISSED_MS);
    feed(degrader, 35, GOOD_MS);

    expect(degrader.step).toBe(1);
    expect(degrader.quality.scale).toBe(0.35);
  });

  /**
   * The bug this guards is the one that makes a degrader worse than nothing:
   * judging the *new* configuration by the *old* one's frame times, walking
   * the ladder to the floor before the first change has been measured.
   */
  it('measures each configuration from scratch after it changes one', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 45, MISSED_MS);
    expect(degrader.step).toBe(1);

    // The half-window that follows is bad, but it is only half a window.
    feed(degrader, 22, MISSED_MS);
    expect(degrader.step).toBe(1);
  });

  it('runs out of ladder rather than degrading forever', () => {
    const degrader = createDegrader({ ceilingScale: 0.5, ceilingPasses: 1 });

    feed(degrader, 45 * 20, MISSED_MS);

    expect(degrader.quality).toEqual({ scale: 0.25, maxPasses: 0 });
    expect(degrader.step).toBe(maxStepFor(0.5, 1));
  });

  // A lost clock or a resumed tab is one frame of bad evidence, not an
  // emergency, and a NaN comparison would quietly read as "kept the frame".
  it('ignores a sample it cannot trust instead of guessing at it', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });

    feed(degrader, 45, Number.NaN);
    feed(degrader, 45, 0);

    expect(degrader.step).toBe(0);
  });
});

describe('coming back up', () => {
  const struggling = (): Degrader => {
    const degrader = createDegrader({ ceilingPasses: 2 });
    feed(degrader, 45, MISSED_MS);
    return degrader;
  };

  /**
   * Recovery is deliberately slow and degradation is not. A premature
   * recovery is a visible stutter and then a visible resolution change; a
   * degradation nobody needed is a slightly softer picture.
   */
  it('waits out the dwell even when every frame since has been good', () => {
    const degrader = struggling();

    feed(degrader, 135, GOOD_MS);
    expect(degrader.step).toBe(1);

    feed(degrader, 45, GOOD_MS);
    expect(degrader.step).toBe(0);
  });

  it('refuses to recover on a window with any miss in it at all', () => {
    const degrader = struggling();

    // The dwell is served, so this window was the one that would have
    // recovered — and a single dropped frame in it is enough to refuse.
    feed(degrader, 179, GOOD_MS);
    degrader.observe(MISSED_MS);
    expect(degrader.step).toBe(1);

    feed(degrader, 44, GOOD_MS);
    expect(degrader.step).toBe(1);

    degrader.observe(GOOD_MS);
    expect(degrader.step).toBe(0);
  });

  it('gives back one step at a time, so a recovery can be undone cheaply', () => {
    const degrader = createDegrader({ ceilingPasses: 2 });
    feed(degrader, 45 * 2, MISSED_MS);
    expect(degrader.step).toBe(2);

    feed(degrader, 180, GOOD_MS);
    expect(degrader.step).toBe(1);
  });
});

describe('the user still owns the dial', () => {
  it('never recovers past the scale the grain slider asked for', () => {
    const degrader = createDegrader({ ceilingScale: 0.25, ceilingPasses: 2 });

    feed(degrader, 180 * 4, GOOD_MS);

    expect(degrader.quality.scale).toBe(0.25);
  });

  /**
   * Moving the slider is the user changing the frame cost by hand, which makes
   * everything the degrader had measured worthless — and someone dragging
   * grain down is usually trying to fix the stutter themselves. Holding four
   * steps of degradation on top of their new choice would strip both passes
   * off a frame that just got 4x cheaper.
   */
  it('starts again at the top of the new ladder when the slider moves', () => {
    const degrader = createDegrader({ ceilingScale: 1, ceilingPasses: 2 });
    feed(degrader, 45 * 4, MISSED_MS);
    expect(degrader.quality.scale).toBe(0.25);

    degrader.setCeiling(0.25);

    expect(degrader.step).toBe(0);
    expect(degrader.quality).toEqual({ scale: 0.25, maxPasses: 2 });
  });

  /**
   * Without this the ladder keeps counting down from six on a two-pass preset,
   * spending three seconds taking steps that remove nothing.
   */
  it('shortens the tail to the passes the new preset actually has', () => {
    const degrader = createDegrader({ ceilingScale: 0.25, ceilingPasses: 6 });
    feed(degrader, 45 * 4, MISSED_MS);
    expect(degrader.quality.maxPasses).toBe(2);

    degrader.setChain(1);

    expect(degrader.step).toBe(maxStepFor(0.25, 1));
    expect(degrader.quality).toEqual({ scale: 0.25, maxPasses: 0 });
  });

  it('goes back to the top when it is told the cost changed entirely', () => {
    const degrader = struggle();

    degrader.reset();

    expect(degrader.step).toBe(0);
    expect(degrader.quality.scale).toBe(DEFAULT_SCALE);
  });
});

const struggle = (): Degrader => {
  const degrader = createDegrader({ ceilingPasses: 2 });
  feed(degrader, 45 * 3, MISSED_MS);
  return degrader;
};
