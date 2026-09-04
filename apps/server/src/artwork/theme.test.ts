import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
  type Rgb,
} from './contrast.js';
import {
  DEFAULT_THEME,
  extractTheme,
  themeCssVariables,
  type PixelData,
} from './theme.js';

const imageOf = (colours: readonly Rgb[], alpha = 255): PixelData => {
  const data = new Uint8Array(colours.length * 4);
  colours.forEach((colour, index) => {
    data[index * 4] = colour.r;
    data[index * 4 + 1] = colour.g;
    data[index * 4 + 2] = colour.b;
    data[index * 4 + 3] = alpha;
  });
  return { width: colours.length, height: 1, data };
};

const repeat = (colour: Rgb, times: number): Rgb[] =>
  Array.from({ length: times }, () => colour);

const hexToRgb = (hex: string): Rgb => {
  const parsed = parseHex(hex);
  if (parsed === null) throw new Error(`bad test colour: ${hex}`);
  return parsed;
};

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const MID_GREY: Rgb = { r: 128, g: 128, b: 128 };
const YELLOW: Rgb = { r: 255, g: 255, b: 0 };
const BLUE: Rgb = { r: 0, g: 0, b: 255 };

/** Every token, checked against the surface it is actually drawn on. */
const expectLegible = (pixels: PixelData, label: string): void => {
  const tokens = extractTheme(pixels);
  const surface = hexToRgb(tokens.surface);
  const accent = hexToRgb(tokens.accent);

  expect(
    contrastRatio(hexToRgb(tokens.foreground), surface),
    `foreground on ${label}`,
  ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
  expect(contrastRatio(accent, surface), `accent on ${label}`).toBeGreaterThanOrEqual(
    TEXT_CONTRAST_MIN,
  );
  expect(
    contrastRatio(hexToRgb(tokens.onAccent), accent),
    `onAccent on ${label}`,
  ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
  expect(
    contrastRatio(hexToRgb(tokens.controlTint), surface),
    `controlTint on ${label}`,
  ).toBeGreaterThanOrEqual(UI_CONTRAST_MIN);
};

describe('extractTheme', () => {
  it('picks the vivid logo over the dull background that surrounds it', () => {
    // The failure mode every naive "dominant colour" extractor has: a sleeve
    // that is 90% grey card with a small hot-pink logo themes the whole device
    // grey, and looks exactly like extraction never ran.
    const pixels = imageOf([
      ...repeat({ r: 60, g: 60, b: 58 }, 90),
      ...repeat({ r: 255, g: 45, b: 85 }, 10),
    ]);

    const accent = rgbToHsl(hexToRgb(extractTheme(pixels).accent));

    expect(accent.h).toBeGreaterThan(320);
    expect(accent.s).toBeGreaterThan(0.5);
  });

  it('ignores a near-white expanse rather than theming the device white', () => {
    // Minimal sleeves are mostly paper. The colour worth having is the ink.
    const pixels = imageOf([
      ...repeat({ r: 250, g: 250, b: 248 }, 95),
      ...repeat({ r: 20, g: 90, b: 200 }, 5),
    ]);

    const accent = rgbToHsl(hexToRgb(extractTheme(pixels).accent));

    expect(accent.h).toBeGreaterThan(190);
    expect(accent.h).toBeLessThan(250);
  });

  it('keeps the album hue in the surface while forcing it dark', () => {
    // The chrome sits on the scrimmed backdrop, and a device on a shelf must
    // not become a lamp because someone played a white sleeve.
    const warm = extractTheme(imageOf(repeat({ r: 220, g: 120, b: 40 }, 32)));
    const surface = hexToRgb(warm.surface);

    expect(relativeLuminance(surface)).toBeLessThan(0.05);
    expect(rgbToHsl(surface).h).toBeGreaterThan(15);
    expect(rgbToHsl(surface).h).toBeLessThan(40);
  });

  it('lifts a dark cover to a readable accent instead of returning its own black', () => {
    // A dark navy sleeve's most salient colour is a navy that is invisible on
    // the navy surface derived from the same image.
    const tokens = extractTheme(imageOf(repeat({ r: 10, g: 15, b: 42 }, 32)));
    const accent = hexToRgb(tokens.accent);
    const surface = hexToRgb(tokens.surface);

    expect(relativeLuminance(accent)).toBeGreaterThan(relativeLuminance(surface));
    expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    // Still recognisably blue: correction moves lightness, never hue.
    expect(rgbToHsl(accent).h).toBeGreaterThan(200);
    expect(rgbToHsl(accent).h).toBeLessThan(260);
  });

  it('degrades a greyscale cover to a grey accent, not to a hallucinated hue', () => {
    // A black-and-white photograph has no accent to find. Inventing one from
    // whichever pixel is fractionally least neutral is worse than admitting it.
    const tokens = extractTheme(
      imageOf([
        ...repeat({ r: 30, g: 30, b: 30 }, 40),
        ...repeat({ r: 150, g: 150, b: 150 }, 60),
      ]),
    );

    expect(rgbToHsl(hexToRgb(tokens.accent)).s).toBeLessThan(0.1);
    expectLegible(
      imageOf([
        ...repeat({ r: 30, g: 30, b: 30 }, 40),
        ...repeat({ r: 150, g: 150, b: 150 }, 60),
      ]),
      'greyscale',
    );
  });

  it('stays legible on every hostile cover', () => {
    // The same hostile set the contrast module is held to, but reached through
    // real extraction: a theme is only as good as its worst album.
    expectLegible(imageOf(repeat(WHITE, 16)), 'pure white');
    expectLegible(imageOf(repeat(BLACK, 16)), 'pure black');
    expectLegible(imageOf(repeat(MID_GREY, 16)), 'mid grey');
    expectLegible(imageOf(repeat(YELLOW, 16)), 'saturated yellow');
    expectLegible(imageOf(repeat(BLUE, 16)), 'saturated blue');
    expectLegible(
      imageOf([...repeat(WHITE, 8), ...repeat(YELLOW, 8)]),
      'yellow on white',
    );
    expectLegible(imageOf([...repeat(BLACK, 8), ...repeat(BLUE, 8)]), 'blue on black');
  });

  it('falls back to the neutral theme when every pixel is transparent', () => {
    // Some generated playlist art and podcast covers arrive as fully
    // transparent PNGs; averaging their zeroed RGB gives black on black.
    expect(extractTheme(imageOf(repeat(YELLOW, 16), 0))).toEqual(DEFAULT_THEME);
    expect(extractTheme({ width: 0, height: 0, data: new Uint8Array(0) })).toEqual(
      DEFAULT_THEME,
    );
  });

  it('reads a truncated bitmap short instead of walking off the end', () => {
    // A decoder that hands back fewer bytes than width*height claims should
    // produce a duller theme, not an exception in the middle of a track change.
    const pixels: PixelData = {
      width: 64,
      height: 64,
      data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]),
    };

    expect(rgbToHsl(hexToRgb(extractTheme(pixels).accent)).h).toBeLessThan(20);
  });

  it('is deterministic, so a replayed track cannot flicker to a new theme', () => {
    const pixels = imageOf([
      ...repeat({ r: 200, g: 30, b: 60 }, 20),
      ...repeat({ r: 40, g: 40, b: 90 }, 20),
    ]);

    expect(extractTheme(pixels)).toEqual(extractTheme(pixels));
  });

  it('emits every token as a custom property the UI can apply blind', () => {
    const variables = themeCssVariables(DEFAULT_THEME);

    expect(variables).toEqual({
      '--joshify-surface': DEFAULT_THEME.surface,
      '--joshify-foreground': DEFAULT_THEME.foreground,
      '--joshify-accent': DEFAULT_THEME.accent,
      '--joshify-on-accent': DEFAULT_THEME.onAccent,
      '--joshify-control-tint': DEFAULT_THEME.controlTint,
    });
  });

  it('ships a default theme that is itself legible', () => {
    const surface = hexToRgb(DEFAULT_THEME.surface);
    const accent = hexToRgb(DEFAULT_THEME.accent);

    expect(
      contrastRatio(hexToRgb(DEFAULT_THEME.foreground), surface),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    expect(
      contrastRatio(hexToRgb(DEFAULT_THEME.onAccent), accent),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    expect(
      contrastRatio(hexToRgb(DEFAULT_THEME.controlTint), surface),
    ).toBeGreaterThanOrEqual(UI_CONTRAST_MIN);
  });
});
