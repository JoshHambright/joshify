/**
 * Colour maths for the derived theme (P3-04).
 *
 * A colour pulled out of album art is a *suggestion*, never a usable token. The
 * art was designed to be looked at, not to be written on: pale yellow lettering
 * on a cream sleeve is a legitimate design and an unreadable UI. So every
 * derived colour goes through here before it reaches a CSS custom property, and
 * the module's whole job is to answer "is this legible, and if not, what is the
 * nearest colour that is".
 *
 * ## Why WCAG, and which numbers
 *
 * Eyeballing does not survive 10,000 albums. WCAG's relative luminance and
 * contrast ratio are specified precisely enough to test, so they are what we
 * measure against, with two thresholds:
 *
 * - **{@link TEXT_CONTRAST_MIN} (4.5:1)** — WCAG 2.2 §1.4.3 AA for body text.
 *   Everything that can carry text takes this, *including the accent*: the
 *   accent ends up on the artist line and the progress readout, and a token
 *   that is safe as a fill but not as text is a trap for whoever styles the
 *   next component.
 * - **{@link UI_CONTRAST_MIN} (3:1)** — WCAG 2.2 §1.4.11 for non-text UI:
 *   slider tracks, icon strokes, borders. Holding chrome to 4.5 would flatten
 *   every album into the same near-white outline and throw away the point of
 *   theming from the art at all.
 *
 * AAA (7:1) was considered and rejected: it is not reachable against every
 * background (a mid-grey surface caps out at ~4.6:1 even with pure white or
 * pure black), so adopting it would mean shipping a threshold the code cannot
 * always meet — the one thing a guarantee must never do. 4.5 is always
 * reachable, which is what makes "no exceptions" a true statement.
 *
 * Viewing distance argues the same way: the device is read at ~2m (PRODUCT.md
 * §5.3), where WCAG's large-text allowance of 3:1 would technically apply to
 * the title. We hold text to 4.5 anyway — the extra headroom costs nothing on
 * a dark surface and covers the small type the large-text rule does not.
 */

import {
  BLACK,
  clamp01,
  TEXT_CONTRAST_MIN,
  clampChannel,
  contrastRatio,
  WHITE,
  type Hsl,
  type Rgb,
} from '@joshify/core';

/**
 * Re-exported so callers keep one import for "colour", even though the
 * primitives now live in core where the UI can reach them too (D-068).
 */
export {
  BLACK,
  contrastRatio,
  formatHex,
  meetsContrast,
  mix,
  parseHex,
  relativeLuminance,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
  WHITE,
  type Hsl,
  type Rgb,
} from '@joshify/core';

/** 8-bit sRGB, the form both hex tokens and image pixels arrive in. */
export const rgbToHsl = (colour: Rgb): Hsl => {
  const r = clampChannel(colour.r) / 255;
  const g = clampChannel(colour.g) / 255;
  const b = clampChannel(colour.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;

  // Grey has no hue to recover, and the saturation divisor is zero here.
  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let sextant: number;
  if (max === r) sextant = ((g - b) / delta) % 6;
  else if (max === g) sextant = (b - r) / delta + 2;
  else sextant = (r - g) / delta + 4;

  const h = sextant * 60;
  return { h: h < 0 ? h + 360 : h, s, l };
};

const hueToChannel = (p: number, q: number, offset: number): number => {
  let t = offset;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

export const hslToRgb = (hsl: Hsl): Rgb => {
  const l = clamp01(hsl.l);
  const s = clamp01(hsl.s);
  if (s === 0) {
    const grey = clampChannel(l * 255);
    return { r: grey, g: grey, b: grey };
  }

  const hue = (((hsl.h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: clampChannel(hueToChannel(p, q, hue + 1 / 3) * 255),
    g: clampChannel(hueToChannel(p, q, hue) * 255),
    b: clampChannel(hueToChannel(p, q, hue - 1 / 3) * 255),
  };
};

/**
 * Linear blend in sRGB, not in a perceptual space.
 *
 * Perceptually it is the wrong average — the midpoint of two saturated colours
 * comes out muddy. That does not matter for the only thing it is used for:
 * pulling one colour a short way toward another to derive a muted chrome tint,
 * where the endpoints are what the eye reads and the path between them is never
 * shown. Anything doing a long blend should reach for a better space.
 */
export const bestNeutralOn = (background: Rgb): Rgb =>
  contrastRatio(WHITE, background) >= contrastRatio(BLACK, background) ? WHITE : BLACK;

export interface ContrastOptions {
  /** Defaults to {@link TEXT_CONTRAST_MIN}. */
  readonly minRatio?: number | undefined;
}

interface Candidate {
  readonly colour: Rgb;
  /** How far the lightness moved, 0..1. Smaller is a truer accent. */
  readonly distance: number;
  readonly ratio: number;
}

/**
 * Contrast is not monotonic in lightness — it dips to 1:1 as a colour passes
 * *through* the background's luminance and climbs again on the far side — but
 * it is monotonic once you fix a direction and start from a failing colour. So
 * each direction is searched separately, and within a direction the qualifying
 * lightnesses form a suffix, which a binary search can find exactly.
 *
 * The search runs over quantised steps and measures the *rounded 8-bit* colour
 * at each one, so the ratio that gets asserted is the ratio of the colour that
 * actually ships. Searching in float and rounding afterwards can land a hair
 * under the threshold, which is precisely the failure this module exists to
 * prevent.
 */
const SEARCH_STEPS = 256;

const searchTowards = (
  start: Hsl,
  against: Rgb,
  minRatio: number,
  targetLightness: number,
): Candidate => {
  const travel = targetLightness - start.l;
  const at = (step: number): Rgb =>
    hslToRgb({ h: start.h, s: start.s, l: start.l + travel * (step / SEARCH_STEPS) });

  const describe = (step: number): Candidate => {
    const colour = at(step);
    return {
      colour,
      distance: Math.abs(travel) * (step / SEARCH_STEPS),
      ratio: contrastRatio(colour, against),
    };
  };

  const end = describe(SEARCH_STEPS);
  // Saturation collapses at both ends of the lightness axis, so the endpoint is
  // always pure white or pure black. If even that fails, no colour on this ray
  // can pass and the endpoint is the best this direction has to offer.
  if (end.ratio < minRatio) return end;

  let failing = 0;
  let passing = SEARCH_STEPS;
  while (passing - failing > 1) {
    const middle = Math.floor((failing + passing) / 2);
    if (contrastRatio(at(middle), against) >= minRatio) passing = middle;
    else failing = middle;
  }
  return describe(passing);
};

/**
 * The nearest colour to `colour` that clears `minRatio` against `against`,
 * keeping hue and saturation and moving only lightness.
 *
 * Hue is what makes the theme feel like the album, so it is the one thing never
 * traded away: a washed-out blue is still recognisably that record's blue, a
 * hue-shifted one is somebody else's. Both directions are tried and the smaller
 * move wins, so a dark album gets a lightened accent and a light one a darkened
 * accent without needing a mode switch.
 *
 * Returns the input untouched when it already passes.
 */
export const ensureContrast = (
  colour: Rgb,
  against: Rgb,
  options: ContrastOptions = {},
): Rgb => {
  const minRatio = options.minRatio ?? TEXT_CONTRAST_MIN;
  if (contrastRatio(colour, against) >= minRatio) return colour;

  const hsl = rgbToHsl(colour);
  const darker = searchTowards(hsl, against, minRatio, 0);
  const lighter = searchTowards(hsl, against, minRatio, 1);

  const darkerPasses = darker.ratio >= minRatio;
  const lighterPasses = lighter.ratio >= minRatio;
  if (darkerPasses !== lighterPasses)
    return darkerPasses ? darker.colour : lighter.colour;
  // Both passing: take the smaller displacement. Neither passing (only possible
  // above ~4.58:1, where some backgrounds are unreachable): take the best
  // available rather than returning a colour known to be worse than both.
  if (darkerPasses)
    return darker.distance <= lighter.distance ? darker.colour : lighter.colour;
  return darker.ratio >= lighter.ratio ? darker.colour : lighter.colour;
};
