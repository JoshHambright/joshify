/**
 * The legibility floor (P5-16).
 *
 * VISUALIZER.md asks for a hard guarantee: *at any intensity, the track title
 * stays readable and the transport stays hittable*, "enforced in tests, not by
 * eye". The obvious reading of that is to render frames and sample pixels,
 * which needs a GPU, is slow, and only ever proves the presets someone thought
 * to try.
 *
 * The stronger reading is that the guarantee is a property of the *plate*, not
 * of any effect. Text never sits on the visualiser — it sits on a translucent
 * surface over it (D-040). So if the plate is opaque enough that **every**
 * possible backdrop composites to something the ink still contrasts against,
 * then no effect can break legibility, including effects nobody has written
 * yet. That is checkable arithmetic over the whole input range rather than a
 * sample of it.
 *
 * What this cannot cover is anything drawn *over* the plate. Overlays composite
 * on the finished frame (D-062), so a spectrum bar across the title would be a
 * real violation this file would not see. The rule that follows is simply that
 * overlays stay out of the plate's rectangle, and that is a layout property.
 */
import {
  contrastRatio,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
  type Rgb,
} from '@joshify/core';

/** A colour with an alpha, as the plate tokens are written. */
export interface Rgba extends Rgb {
  /** 0..1. */
  readonly alpha: number;
}

/**
 * Source-over compositing, which is what the browser does when a translucent
 * surface sits on something.
 *
 * Done in 8-bit sRGB rather than linear light on purpose: this must match what
 * the compositor actually produces, and CSS `background-color` alpha blending
 * is defined on the non-linear values. Blending in linear space would give a
 * more *correct* colour and the wrong *answer*.
 */
export const composite = (over: Rgba, under: Rgb): Rgb => ({
  r: over.r * over.alpha + under.r * (1 - over.alpha),
  g: over.g * over.alpha + under.g * (1 - over.alpha),
  b: over.b * over.alpha + under.b * (1 - over.alpha),
});

export interface LegibilityCheck {
  /** The plate, as it is declared in `tokens.css`. */
  readonly plate: Rgba;
  /**
   * A scrim between the artwork and the plate.
   *
   * The plate alone cannot carry the guarantee at a glass-like opacity — this
   * check is what proved that (D-068). A scrim bounds how bright the surface
   * beneath the plate can get without making the plate itself more opaque,
   * which is what keeps the artwork visible through it.
   */
  readonly scrim?: Rgba | undefined;
  readonly ink: Rgb;
  /** 4.5:1 for text, 3:1 for chrome. */
  readonly minRatio?: number | undefined;
  /** How finely to walk the backdrop range. */
  readonly steps?: number | undefined;
}

export interface LegibilityResult {
  readonly passes: boolean;
  /** The worst ratio found, and the backdrop that produced it. */
  readonly worstRatio: number;
  readonly worstBackdrop: Rgb;
  /**
   * The alpha the plate would need for this ink to clear `minRatio` against
   * every backdrop, or null when it already does. Actionable rather than a
   * bare failure — a floor that only says "no" makes somebody guess.
   */
  readonly requiredAlpha: number | null;
}

/**
 * Walk the whole backdrop range and report the worst case.
 *
 * The extremes are not enough on their own. Contrast is not monotonic in
 * backdrop luminance — the ratio falls as the composited surface approaches
 * the ink's own luminance and rises again past it — so the worst case can sit
 * in the middle. Sampling the greys along the diagonal finds it; the corners
 * alone would miss it.
 */
export const checkLegibility = (check: LegibilityCheck): LegibilityResult => {
  const minRatio = check.minRatio ?? TEXT_CONTRAST_MIN;
  const steps = check.steps ?? 256;

  let worstRatio = Number.POSITIVE_INFINITY;
  let worstBackdrop: Rgb = { r: 0, g: 0, b: 0 };

  for (let step = 0; step < steps; step += 1) {
    const level = (step / (steps - 1)) * 255;
    const backdrop: Rgb = { r: level, g: level, b: level };
    const beneath =
      check.scrim === undefined ? backdrop : composite(check.scrim, backdrop);
    const ratio = contrastRatio(check.ink, composite(check.plate, beneath));
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstBackdrop = backdrop;
    }
  }

  return {
    passes: worstRatio >= minRatio,
    worstRatio,
    worstBackdrop,
    requiredAlpha: worstRatio >= minRatio ? null : solveAlpha(check, minRatio, steps),
  };
};

/**
 * The smallest plate alpha whose *worst case over every backdrop* clears
 * `minRatio`.
 *
 * The obvious version solves against the backdrop that was worst at the
 * current alpha — and gets the wrong answer, because raising the alpha moves
 * where the worst case is. Bisection has to re-scan the whole range at each
 * candidate. (The first draft of this function did not, and the test that
 * checks "the alpha it suggests actually works" is what caught it.)
 *
 * Bisection rather than algebra: the relationship runs through the sRGB
 * transfer function and the contrast formula's `+0.05`, and the closed form is
 * both unpleasant and easy to get subtly wrong.
 */
const solveAlpha = (
  check: LegibilityCheck,
  minRatio: number,
  steps: number,
): number | null => {
  const worstAt = (alpha: number): number => {
    let worst = Number.POSITIVE_INFINITY;
    for (let step = 0; step < steps; step += 1) {
      const level = (step / (steps - 1)) * 255;
      const backdrop: Rgb = { r: level, g: level, b: level };
      const beneath =
        check.scrim === undefined ? backdrop : composite(check.scrim, backdrop);
      worst = Math.min(
        worst,
        contrastRatio(check.ink, composite({ ...check.plate, alpha }, beneath)),
      );
    }
    return worst;
  };

  if (worstAt(1) < minRatio) return null; // even an opaque plate does not help
  let low = check.plate.alpha;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const mid = (low + high) / 2;
    if (worstAt(mid) >= minRatio) high = mid;
    else low = mid;
  }
  // Rounded *up*, so the suggestion is one the caller can use verbatim rather
  // than one that lands a hair under the floor.
  return Math.ceil(high * 1000) / 1000;
};

/** The chrome floor: sliders, glyph strokes, borders. 3:1 rather than 4.5. */
export const checkChromeLegibility = (
  check: Omit<LegibilityCheck, 'minRatio'>,
): LegibilityResult => checkLegibility({ ...check, minRatio: UI_CONTRAST_MIN });

/** Present, so a failure names a colour rather than a number. */
export const describeLegibility = (result: LegibilityResult): string => {
  const { r, g, b } = result.worstBackdrop;
  const grey = Math.round(r);
  const at = `backdrop rgb(${String(grey)} ${String(Math.round(g))} ${String(Math.round(b))})`;
  if (result.passes) return `worst ${result.worstRatio.toFixed(2)}:1 at ${at}`;
  const fix =
    result.requiredAlpha === null
      ? 'no plate alpha fixes this — the ink is wrong'
      : `plate alpha would need to be ${String(result.requiredAlpha)}`;
  return `worst ${result.worstRatio.toFixed(2)}:1 at ${at}; ${fix}`;
};
