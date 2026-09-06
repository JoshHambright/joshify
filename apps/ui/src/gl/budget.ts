/**
 * The grain slider (P5-13) and the auto-degrader (P5-14).
 *
 * Two tasks, one module, because they are one number: the render scale is
 * simultaneously the art direction and the biggest performance lever we have.
 * Half resolution is a 4x cut in fragment work *and* the lo-fi upscale we
 * actually want — which is also, near enough, the PS1's 240p output
 * (PS1_MODE.md). So the user picks a scale, and the degrader is only ever
 * allowed to walk *down* from what they picked.
 *
 * ## The policy, with its numbers
 *
 * - **Frame budget** — `1000 / 60` = 16.7ms. A frame counts as missed past
 *   **1.25x** that (20.8ms). Not 1.0x: a healthy 60fps browser routinely
 *   delivers a frame a millisecond late through compositor jitter alone, and
 *   counting those would degrade a screen that is fine.
 * - **Window** — **45 frames** (~0.75s), tumbling rather than sliding: a
 *   decision consumes its evidence and the next one starts from nothing. Long
 *   enough that one hitch — artwork decoding on a track change, a GC — cannot
 *   trip it; short enough to react inside a second.
 * - **Degrade** at more than **20%** missed in the window; **recover** below
 *   **2%**. The asymmetry is the point: coming back down must be much harder
 *   than going up, or the engine hunts.
 * - **The window is cleared on every change.** Decisions are always made about
 *   the configuration currently on screen. Without this one bad second walks
 *   the whole ladder to the bottom before the first change has been measured.
 * - **Recovery waits 180 frames (~3s) after the last change.** Measured in
 *   frames, not wall clock, so a backgrounded tab cannot fake the wait out.
 *   Degradation has no such dwell beyond refilling the window: a stuttering
 *   screen should be fixed now, a hopeful upgrade can wait.
 *
 * ## The ladder
 *
 * One integer, walked one step at a time. Scale drops first — it is the
 * cheapest visual concession and by far the largest saving — and only when the
 * scale is at its floor do passes start coming off the end of the chain. The
 * scene is never dropped: a frame with no scene is a black screen, which is
 * not a degraded visualiser but a broken one (D-014 put the scene first for
 * exactly this reason).
 */
import type { Size } from './uniforms.js';

export interface QualityLevel {
  readonly scale: number;
  readonly maxPasses: number;
}

/**
 * 0.5 is the default (D-011). The rungs below it are where the degrader goes;
 * 1.0 and 0.75 exist because a Pi 5 can genuinely hold full resolution on a
 * short chain (D-008) and the slider should be able to say so.
 */
export const SCALE_LADDER: readonly number[] = [1, 0.75, 0.5, 0.35, 0.25];

export const DEFAULT_SCALE = 0.5;

export const TARGET_FPS = 60;
export const MISS_FACTOR = 1.25;
export const WINDOW_FRAMES = 45;
export const DEGRADE_MISS_RATIO = 0.2;
export const RECOVER_MISS_RATIO = 0.02;
export const RECOVER_DWELL_FRAMES = 180;

/** The pass budget from VISUALIZER.md, and so the longest ladder tail. */
export const MAX_DEGRADABLE_PASSES = 6;

export interface DegraderOptions {
  readonly ceilingScale?: number | undefined;
  readonly ceilingPasses?: number | undefined;
  readonly targetFps?: number | undefined;
  readonly windowFrames?: number | undefined;
  readonly degradeRatio?: number | undefined;
  readonly recoverRatio?: number | undefined;
  readonly recoverDwellFrames?: number | undefined;
}

/**
 * The pixels a scale actually means.
 *
 * Rounded and floored at 1: a zero-sized framebuffer is a GL error rather than
 * a small picture, and the panel is 720x1280 so an odd product is normal.
 */
export const renderSizeFor = (output: Size, scale: number): Size => {
  const safe = Math.min(1, Math.max(0.01, Number.isFinite(scale) ? scale : 1));
  return {
    width: Math.max(1, Math.round(output.width * safe)),
    height: Math.max(1, Math.round(output.height * safe)),
  };
};

/** The rungs at or below what the user asked for, their choice first. */
export const scaleLadderFrom = (ceiling: number): readonly number[] => {
  const safe = Math.min(
    1,
    Math.max(0.01, Number.isFinite(ceiling) ? ceiling : DEFAULT_SCALE),
  );
  const below = SCALE_LADDER.filter((rung) => rung < safe);
  return [safe, ...below];
};

export const maxStepFor = (ceilingScale: number, ceilingPasses: number): number =>
  scaleLadderFrom(ceilingScale).length + Math.max(0, ceilingPasses) - 1;

/**
 * Where a given step on the ladder lands. Pure, so the whole policy can be
 * read off in a test without simulating a single frame.
 */
export const levelAt = (
  step: number,
  ceilingScale: number,
  ceilingPasses: number,
): QualityLevel => {
  const scales = scaleLadderFrom(ceilingScale);
  const passes = Math.max(0, ceilingPasses);
  const clamped = Math.min(Math.max(0, step), maxStepFor(ceilingScale, passes));
  const floor = scales[scales.length - 1] ?? DEFAULT_SCALE;
  if (clamped < scales.length) {
    return { scale: scales[clamped] ?? floor, maxPasses: passes };
  }
  return { scale: floor, maxPasses: Math.max(0, passes - (clamped - scales.length + 1)) };
};

export const isMissedFrame = (frameMs: number, targetFps: number): boolean =>
  frameMs > (1000 / targetFps) * MISS_FACTOR;

export interface Degrader {
  /** The level to render at right now. */
  readonly quality: QualityLevel;
  /** How far down the ladder we are; 0 is what the user asked for. */
  readonly step: number;
  /** Feed the interval since the previous frame. Returns the new level. */
  observe(frameMs: number): QualityLevel;
  /** The grain slider moved. */
  setCeiling(scale: number): void;
  /**
   * The preset changed: this is how many passes there now are to drop.
   *
   * Without it the ladder would keep counting down from six on a two-pass
   * preset, spending four windows — three seconds — taking steps that remove
   * nothing while the screen carries on stuttering.
   */
  setChain(passes: number): void;
  /** Forget the history and go back to what the user asked for. */
  reset(): void;
}

export const createDegrader = (options: DegraderOptions = {}): Degrader => {
  const targetFps = options.targetFps ?? TARGET_FPS;
  const windowFrames = options.windowFrames ?? WINDOW_FRAMES;
  const degradeRatio = options.degradeRatio ?? DEGRADE_MISS_RATIO;
  const recoverRatio = options.recoverRatio ?? RECOVER_MISS_RATIO;
  const dwell = options.recoverDwellFrames ?? RECOVER_DWELL_FRAMES;
  const startingPasses = Math.max(0, options.ceilingPasses ?? MAX_DEGRADABLE_PASSES);

  let ceilingScale = options.ceilingScale ?? DEFAULT_SCALE;
  let ceilingPasses = startingPasses;
  let step = 0;
  let misses = 0;
  let seen = 0;
  let framesSinceChange = 0;

  const forget = (): void => {
    misses = 0;
    seen = 0;
  };

  const changeTo = (next: number): void => {
    step = next;
    framesSinceChange = 0;
    forget();
  };

  return {
    get quality() {
      return levelAt(step, ceilingScale, ceilingPasses);
    },
    get step() {
      return step;
    },
    observe: (frameMs) => {
      // A sample we cannot trust — a lost clock, a paused rAF — is dropped
      // rather than guessed at. It is one frame of evidence, not an emergency.
      if (Number.isFinite(frameMs) && frameMs > 0) {
        seen += 1;
        framesSinceChange += 1;
        if (isMissedFrame(frameMs, targetFps)) misses += 1;
      }
      if (seen >= windowFrames) {
        const ratio = misses / seen;
        const bottom = maxStepFor(ceilingScale, ceilingPasses);
        if (ratio > degradeRatio && step < bottom) changeTo(step + 1);
        else if (ratio < recoverRatio && step > 0 && framesSinceChange >= dwell) {
          changeTo(step - 1);
        } else forget();
      }
      return levelAt(step, ceilingScale, ceilingPasses);
    },
    setCeiling: (scale) => {
      ceilingScale = scale;
      // Back to the top of the new ladder, not the same rung on it. The step
      // we were on was measured against a frame cost the user has just changed
      // by hand — and someone dragging grain down is usually trying to fix the
      // stutter themselves, so they deserve the benefit of the doubt. If the
      // machine still cannot hold it, the next window says so.
      changeTo(0);
    },
    setChain: (passes) => {
      ceilingPasses = Math.max(0, passes);
      // The step is kept rather than zeroed: a Pi that was struggling a
      // moment ago is still the same Pi, and jumping back to full scale on a
      // preset change would only stutter its way back down again.
      changeTo(Math.min(step, maxStepFor(ceilingScale, ceilingPasses)));
    },
    reset: () => {
      changeTo(0);
    },
  };
};
