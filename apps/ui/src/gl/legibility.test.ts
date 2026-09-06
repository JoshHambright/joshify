/**
 * The floor, checked against the tokens the panel actually ships.
 *
 * If someone lowers the plate's alpha to make the artwork read better, this
 * test is what tells them the title stopped being readable — and by how much,
 * and what alpha would fix it.
 */
import { describe, expect, it } from 'vitest';
import { TEXT_CONTRAST_MIN, UI_CONTRAST_MIN, type Rgb } from '@joshify/core';
import {
  checkChromeLegibility,
  checkLegibility,
  composite,
  describeLegibility,
  type Rgba,
} from './legibility.js';

/** `--jf-plate: rgb(14 13 20 / 0.62)` — kept in step with tokens.css. */
const PLATE: Rgba = { r: 14, g: 13, b: 20, alpha: 0.62 };
/** `--jf-plate-scrim: rgb(0 0 0 / 0.35)` */
const SCRIM: Rgba = { r: 0, g: 0, b: 0, alpha: 0.35 };
/** `--jf-ink: #f4f2f7` */
const INK: Rgb = { r: 244, g: 242, b: 247 };
/** `--jf-ink-dim: #b9b5c6` */
const INK_DIM: Rgb = { r: 185, g: 181, b: 198 };
/** `--jf-ink-faint: #9692a7` */
const INK_FAINT: Rgb = { r: 150, g: 146, b: 167 };

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

describe('compositing', () => {
  it('is source-over, in the space the compositor works in', () => {
    const half: Rgba = { r: 0, g: 0, b: 0, alpha: 0.5 };
    expect(composite(half, WHITE)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });

  it('is a no-op at zero alpha and a replacement at one', () => {
    expect(composite({ ...PLATE, alpha: 0 }, WHITE)).toEqual(WHITE);
    expect(composite({ ...PLATE, alpha: 1 }, WHITE)).toEqual({
      r: PLATE.r,
      g: PLATE.g,
      b: PLATE.b,
    });
  });
});

/**
 * The guarantee. Not "these presets are fine" — *no* backdrop is a problem,
 * which covers effects nobody has written yet.
 */
describe('the legibility floor', () => {
  it('holds the title readable over any backdrop the visualiser can produce', () => {
    const result = checkLegibility({ plate: PLATE, scrim: SCRIM, ink: INK });

    expect(result.passes, describeLegibility(result)).toBe(true);
    expect(result.worstRatio).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
  });

  it('holds for the dimmer ink the subtitle uses', () => {
    const result = checkLegibility({ plate: PLATE, scrim: SCRIM, ink: INK_DIM });

    expect(result.passes, describeLegibility(result)).toBe(true);
  });

  // `--jf-ink-faint` is for inactive glyphs, not text, so it answers to the
  // chrome floor rather than the text one.
  it('holds the faint ink to the 3:1 chrome floor', () => {
    const result = checkChromeLegibility({ plate: PLATE, scrim: SCRIM, ink: INK_FAINT });

    expect(result.passes, describeLegibility(result)).toBe(true);
    expect(result.worstRatio).toBeGreaterThanOrEqual(UI_CONTRAST_MIN);
  });

  // The extremes are not enough on their own: contrast falls as the composited
  // surface approaches the ink's luminance and rises again past it, so the
  // worst case can sit in the middle of the range.
  it('finds a worst case the corners would miss', () => {
    // An ink deliberately close to what a mid-grey backdrop composites to.
    const midInk: Rgb = { r: 96, g: 95, b: 100 };
    const result = checkLegibility({ plate: PLATE, ink: midInk });

    const atBlack = checkLegibility({ plate: PLATE, ink: midInk, steps: 2 });
    expect(result.worstRatio).toBeLessThan(atBlack.worstRatio);
    expect(result.worstBackdrop.r).toBeGreaterThan(0);
    expect(result.worstBackdrop.r).toBeLessThan(255);
  });
});

/** A floor that only says "no" makes somebody guess. */
describe('when it fails', () => {
  const THIN: Rgba = { ...PLATE, alpha: 0.1 };

  it('says how opaque the plate would have to be', () => {
    const result = checkLegibility({ plate: THIN, ink: INK_FAINT });

    expect(result.passes).toBe(false);
    expect(result.requiredAlpha).not.toBeNull();
    expect(result.requiredAlpha).toBeGreaterThan(THIN.alpha);
  });

  it('the alpha it suggests actually works', () => {
    const result = checkLegibility({ plate: THIN, ink: INK_FAINT });
    const alpha = result.requiredAlpha;
    if (alpha === null) throw new Error('expected an alpha to be suggested');

    const fixed = checkLegibility({ plate: { ...THIN, alpha }, ink: INK_FAINT });

    expect(fixed.passes, describeLegibility(fixed)).toBe(true);
  });

  // Some inks are simply wrong for the plate, and no opacity rescues them.
  it('says so when no alpha can fix it', () => {
    const result = checkLegibility({ plate: PLATE, ink: { r: 20, g: 19, b: 26 } });

    expect(result.passes).toBe(false);
    expect(result.requiredAlpha).toBeNull();
    expect(describeLegibility(result)).toContain('the ink is wrong');
  });

  it('names the backdrop that broke it', () => {
    const result = checkLegibility({ plate: THIN, ink: INK_FAINT });

    expect(describeLegibility(result)).toMatch(/backdrop rgb\(\d+ \d+ \d+\)/);
  });
});

describe('the plate we actually ship', () => {
  // The number that matters, recorded so a change to it is a deliberate act
  // rather than a side effect of adjusting a look.
  it('has headroom over the floor, not just clearance', () => {
    const result = checkLegibility({ plate: PLATE, scrim: SCRIM, ink: INK });

    expect(result.worstRatio).toBeGreaterThan(TEXT_CONTRAST_MIN + 1);
  });

  // The finding that produced the scrim, kept as a test so it cannot come
  // back: at 0.62 the plate alone does not carry the guarantee.
  it('would fail without the scrim, which is why the scrim exists', () => {
    const result = checkLegibility({ plate: PLATE, ink: INK_DIM });

    expect(result.passes).toBe(false);
    expect(result.worstRatio).toBeLessThan(TEXT_CONTRAST_MIN);
  });

  it('would fail if the plate were made much more transparent', () => {
    const result = checkLegibility({ plate: { ...PLATE, alpha: 0.2 }, ink: INK_DIM });

    // Not an accident of the current numbers — it is the tradeoff being
    // explicit. More artwork through the plate costs legibility.
    expect(result.passes).toBe(false);
  });
});
