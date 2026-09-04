import { describe, expect, it } from 'vitest';
import {
  BLACK,
  bestNeutralOn,
  contrastRatio,
  ensureContrast,
  formatHex,
  hslToRgb,
  meetsContrast,
  mix,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
  WHITE,
  type Rgb,
} from './contrast.js';

/**
 * The covers that break naive theming, as flat colours.
 *
 * Every one of these is a real sleeve: an all-white minimal cover, a black
 * metal sleeve, a grey ambient record, a saturated yellow pop cover (the
 * classic "pale accent, invisible on anything light"), and a saturated blue
 * whose luminance is so low that dark text on it and light text on it both
 * look plausible and only one is.
 */
const HOSTILE: readonly { readonly name: string; readonly colour: Rgb }[] = [
  { name: 'pure white', colour: { r: 255, g: 255, b: 255 } },
  { name: 'pure black', colour: { r: 0, g: 0, b: 0 } },
  { name: 'mid grey', colour: { r: 128, g: 128, b: 128 } },
  // The exact worst case for achievable contrast: white and black tie here at
  // ~4.58:1, so a threshold above that would be unreachable.
  { name: 'worst-case grey', colour: { r: 119, g: 119, b: 119 } },
  { name: 'saturated yellow', colour: { r: 255, g: 255, b: 0 } },
  { name: 'saturated blue', colour: { r: 0, g: 0, b: 255 } },
  { name: 'saturated red', colour: { r: 255, g: 0, b: 0 } },
  { name: 'saturated cyan', colour: { r: 0, g: 255, b: 255 } },
  { name: 'saturated magenta', colour: { r: 255, g: 0, b: 255 } },
  { name: 'near white', colour: { r: 250, g: 248, b: 240 } },
  { name: 'near black', colour: { r: 8, g: 6, b: 10 } },
];

describe('parseHex', () => {
  it('reads both the 3- and 6-digit forms', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHex('F80')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('rejects anything that is not a colour instead of guessing', () => {
    // Theme overrides will eventually come from a user-edited config file, so
    // "#nope" and "#ff" must read as absent, not as near-black.
    expect(parseHex('#nope')).toBeNull();
    expect(parseHex('#ff')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('formatHex', () => {
  it('zero-pads and clamps out-of-range channels', () => {
    expect(formatHex({ r: 0, g: 8, b: 255 })).toBe('#0008ff');
    expect(formatHex({ r: -20, g: 300, b: Number.NaN })).toBe('#00ff00');
  });
});

describe('relativeLuminance and contrastRatio', () => {
  it('matches the WCAG reference values at the extremes', () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 10);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 6);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
  });

  it('is symmetric, so callers never have to order the arguments', () => {
    const a = { r: 12, g: 90, b: 200 };
    const b = { r: 240, g: 230, b: 12 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 12);
  });

  it('agrees with the published ratio for a known pair', () => {
    // #767676 on white is the canonical "smallest passing grey" from the WCAG
    // techniques: 4.54:1. If the linearisation is wrong this drifts visibly.
    expect(contrastRatio({ r: 118, g: 118, b: 118 }, WHITE)).toBeCloseTo(4.54, 2);
  });

  it('meetsContrast is the same test, stated as a predicate', () => {
    expect(meetsContrast(WHITE, BLACK, TEXT_CONTRAST_MIN)).toBe(true);
    expect(meetsContrast(WHITE, WHITE, UI_CONTRAST_MIN)).toBe(false);
  });
});

describe('rgbToHsl / hslToRgb', () => {
  it('round trips the primaries through both sextant branches', () => {
    for (const colour of [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 0, g: 255, b: 255 },
      { r: 128, g: 64, b: 32 },
      { r: 32, g: 64, b: 128 },
    ]) {
      expect(hslToRgb(rgbToHsl(colour))).toEqual(colour);
    }
  });

  it('keeps greys on the grey axis rather than inventing a hue', () => {
    const grey = rgbToHsl({ r: 128, g: 128, b: 128 });
    expect(grey.s).toBe(0);
    expect(hslToRgb(grey)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('normalises hues outside 0..360 and clamps lightness', () => {
    expect(hslToRgb({ h: 360 + 120, s: 1, l: 0.5 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(hslToRgb({ h: -240, s: 1, l: 0.5 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(hslToRgb({ h: 200, s: 1, l: 2 })).toEqual(WHITE);
    expect(hslToRgb({ h: 200, s: 1, l: -1 })).toEqual(BLACK);
  });

  it('reproduces a magenta, where the last hue branch is the one that runs', () => {
    expect(hslToRgb({ h: 300, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 255 });
  });
});

describe('mix', () => {
  it('interpolates and clamps the blend amount', () => {
    expect(mix(BLACK, WHITE, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
    expect(mix(BLACK, WHITE, -1)).toEqual(BLACK);
    expect(mix(BLACK, WHITE, 5)).toEqual(WHITE);
  });
});

describe('bestNeutralOn', () => {
  it('picks the neutral with more headroom on each side of the range', () => {
    expect(bestNeutralOn(BLACK)).toEqual(WHITE);
    expect(bestNeutralOn(WHITE)).toEqual(BLACK);
    expect(bestNeutralOn({ r: 255, g: 255, b: 0 })).toEqual(BLACK);
  });
});

describe('ensureContrast', () => {
  /**
   * The guarantee. Every hostile colour is used both as a foreground and as
   * the surface it sits on — 121 pairings — and the corrected colour must
   * clear the threshold in every one. This is the test that makes "text stays
   * readable on every album" a fact rather than an intention.
   */
  it('always reaches the text threshold, for every hostile pairing', () => {
    for (const surface of HOSTILE) {
      for (const source of HOSTILE) {
        const fixed = ensureContrast(source.colour, surface.colour);
        const ratio = contrastRatio(fixed, surface.colour);
        expect(
          ratio,
          `${source.name} on ${surface.name} -> ${formatHex(fixed)} at ${String(ratio)}`,
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
      }
    }
  });

  it('always reaches the non-text threshold too', () => {
    for (const surface of HOSTILE) {
      for (const source of HOSTILE) {
        const fixed = ensureContrast(source.colour, surface.colour, {
          minRatio: UI_CONTRAST_MIN,
        });
        expect(
          contrastRatio(fixed, surface.colour),
          `${source.name} on ${surface.name}`,
        ).toBeGreaterThanOrEqual(UI_CONTRAST_MIN);
      }
    }
  });

  it('holds the guarantee across the whole hue circle at full saturation', () => {
    // A hue-by-hue sweep catches an error in one sextant of the HSL conversion
    // that a handful of primaries would walk straight past.
    const surface = { r: 245, g: 245, b: 245 };
    for (let hue = 0; hue < 360; hue += 5) {
      const source = hslToRgb({ h: hue, s: 1, l: 0.6 });
      const fixed = ensureContrast(source, surface);
      expect(contrastRatio(fixed, surface), `hue ${String(hue)}`).toBeGreaterThanOrEqual(
        TEXT_CONTRAST_MIN,
      );
    }
  });

  it('leaves a colour that already passes exactly as it was', () => {
    const accent = { r: 255, g: 200, b: 40 };
    expect(ensureContrast(accent, { r: 10, g: 10, b: 12 })).toEqual(accent);
  });

  it('keeps the hue while moving the lightness', () => {
    // The point of correction is a readable version of *that album's* colour.
    // A yellow that comes back orange is a different record.
    const yellow = { r: 255, g: 240, b: 0 };
    const fixed = ensureContrast(yellow, WHITE);
    expect(rgbToHsl(fixed).h).toBeCloseTo(rgbToHsl(yellow).h, 0);
    expect(relativeLuminance(fixed)).toBeLessThan(relativeLuminance(yellow));
  });

  it('moves in whichever direction is the shorter trip', () => {
    // A grey at ~0.18 luminance is the narrow band where both pure white and
    // pure black clear 4.5:1, so it is the only place the choice of direction
    // is genuinely free — and the module must not have a hardcoded preference.
    const surface = { r: 118, g: 118, b: 118 };
    expect(
      relativeLuminance(ensureContrast({ r: 125, g: 125, b: 125 }, surface)),
    ).toBeLessThan(relativeLuminance(surface));
    expect(
      relativeLuminance(ensureContrast({ r: 200, g: 200, b: 200 }, surface)),
    ).toBeGreaterThan(relativeLuminance(surface));
  });

  it('returns the best it can when the requested ratio is unreachable', () => {
    // 21:1 exists only for pure black on pure white. Asking for it against a
    // mid grey is impossible, and the answer must still be more readable than
    // the input rather than an unchanged, failing colour.
    const surface = { r: 119, g: 119, b: 119 };
    const fixed = ensureContrast({ r: 130, g: 130, b: 130 }, surface, { minRatio: 21 });
    expect(contrastRatio(fixed, surface)).toBeGreaterThan(
      contrastRatio({ r: 130, g: 130, b: 130 }, surface),
    );
    expect(fixed).toEqual(BLACK);
  });

  it('picks the reachable direction when only one exists', () => {
    // Against near-white, lightening can never work: the ray ends at white,
    // which is 1:1 with the surface. The darker branch has to win.
    const fixed = ensureContrast({ r: 250, g: 250, b: 250 }, WHITE, { minRatio: 7 });
    expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(7);
  });
});
