/**
 * Theme extraction (P3-03): album art in, CSS custom properties out.
 *
 * The UI computes nothing (D-003). It receives five hex strings and applies
 * them, so every judgement about what a colour *means* has to be made here,
 * once per track, on the 64px variant (PRODUCT.md §8.1 — 4,096 pixels, so an
 * exhaustive scan is cheaper than being clever).
 *
 * ## What "accent" means here
 *
 * Not the most common colour. The most common colour on a sleeve is nearly
 * always the background — the grey card stock, the black gradient, the cream
 * paper — and a UI themed on it looks like nothing was extracted at all.
 *
 * **The accent is the most chromatically salient colour: the one that best
 * combines being common, being colourful, and sitting near the middle of the
 * lightness range.** Those three pull against each other on purpose:
 *
 * - *Common* enters as a square root, so a colour has to be four times as
 *   prevalent to outweigh one twice as vivid. A logo occupying 3% of a sleeve
 *   is what a person would name as "the colour of that album"; the 70% grey
 *   behind it is not.
 * - *Colourful* is saturation, with a floor rather than a hard gate. The floor
 *   is what makes an entirely greyscale cover degrade to "the most common grey"
 *   instead of to whatever near-neutral pixel happened to be least neutral.
 * - *Mid-lightness* suppresses the two colours that are technically vivid and
 *   practically useless: the near-black that turns into a black accent, and the
 *   near-white that turns into a white one. Both survive contrast correction
 *   and both throw the album away.
 *
 * Colours are pooled into coarse buckets first (16 levels per channel) so that
 * a gradient — which has thousands of distinct pixel values and no dominant
 * one — competes as a single region rather than losing to a flat area.
 *
 * ## Why the surface is always dark
 *
 * The chrome does not sit on the album art; it sits on the blurred, scrimmed
 * backdrop (D-004), whose colour is essentially the artwork's mean. So the
 * surface token is that mean, held to a dark, lightly desaturated band. Two
 * reasons it is clamped rather than passed through: contrast correction needs a
 * *stable* reference or every token flips polarity between a white sleeve and a
 * black one, and the device is a lit object on a shelf — a white sleeve should
 * not turn it into a lamp at 2am.
 */
import {
  bestNeutralOn,
  ensureContrast,
  formatHex,
  hslToRgb,
  mix,
  rgbToHsl,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
  type Hsl,
  type Rgb,
} from './contrast.js';

/** RGBA, 4 bytes per pixel, row-major — the shape `jimp`'s bitmap already has. */
export interface PixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface ThemeTokens {
  /** The scrimmed backdrop the chrome sits on. Always dark, tinted by the art. */
  readonly surface: string;
  /** Body and title text on `surface`. ≥4.5:1. */
  readonly foreground: string;
  /** The album's colour. Safe as text on `surface` (≥4.5:1), not only as fill. */
  readonly accent: string;
  /** Text and icons drawn *on top of* `accent`, e.g. a filled button. ≥4.5:1. */
  readonly onAccent: string;
  /** Non-text chrome: slider tracks, icon strokes, borders. ≥3:1 on `surface`. */
  readonly controlTint: string;
}

/**
 * Used when there is no artwork at all — local files, some podcasts, and the
 * moment before the first fetch lands. Neutral rather than branded: a made-up
 * accent would read as a bug the first time a real one replaced it.
 */
export const DEFAULT_THEME: ThemeTokens = {
  surface: '#101114',
  foreground: '#f2f3f5',
  accent: '#9aa4b2',
  onAccent: '#101114',
  controlTint: '#6c7684',
};

/** Below this a pixel is see-through enough that its colour is not on screen. */
const MIN_ALPHA = 128;

/** 16 levels per channel: coarse enough to pool a gradient, fine enough to
 * keep two similar-but-distinct brand colours apart. */
const BUCKET_SHIFT = 4;

const SURFACE_LIGHTNESS = 0.1;
const SURFACE_MAX_SATURATION = 0.4;
const FOREGROUND_LIGHTNESS = 0.96;
const FOREGROUND_SATURATION = 0.06;
/** How far the control tint is pulled back toward the surface from the accent. */
const CONTROL_TINT_MIX = 0.45;

const SATURATION_FLOOR = 0.12;
const IDEAL_LIGHTNESS = 0.5;
const LIGHTNESS_FLOOR = 0.05;

interface Bucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

const averageOf = (bucket: Bucket): Rgb => ({
  r: bucket.r / bucket.count,
  g: bucket.g / bucket.count,
  b: bucket.b / bucket.count,
});

/**
 * Peaks at mid lightness and falls to a floor at both ends. The floor, rather
 * than zero, is what keeps an all-black or all-white cover scoring *something*
 * so the ranking still has a winner to correct instead of a special case.
 */
const lightnessWeight = (lightness: number): number => {
  const offset = (lightness - IDEAL_LIGHTNESS) / IDEAL_LIGHTNESS;
  return LIGHTNESS_FLOOR + (1 - LIGHTNESS_FLOOR) * Math.max(0, 1 - offset * offset);
};

const saliency = (hsl: Hsl, share: number): number =>
  Math.sqrt(share) *
  (SATURATION_FLOOR + (1 - SATURATION_FLOOR) * hsl.s) *
  lightnessWeight(hsl.l);

interface Scan {
  readonly buckets: readonly Bucket[];
  readonly mean: Rgb;
  readonly opaquePixels: number;
}

const scan = (pixels: PixelData): Scan => {
  const buckets = new Map<number, Bucket>();
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let counted = 0;

  // Trust the buffer's own length, not width*height: a truncated or mis-sized
  // bitmap must read short rather than walk off the end into undefined.
  const total = Math.floor(pixels.data.length / 4);
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const r = pixels.data[offset] ?? 0;
    const g = pixels.data[offset + 1] ?? 0;
    const b = pixels.data[offset + 2] ?? 0;
    const alpha = pixels.data[offset + 3] ?? 0;
    if (alpha < MIN_ALPHA) continue;

    sumR += r;
    sumG += g;
    sumB += b;
    counted += 1;

    const key =
      ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, { r, g, b, count: 1 });
    else {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    }
  }

  return {
    buckets: [...buckets.values()],
    mean:
      counted === 0
        ? { r: 0, g: 0, b: 0 }
        : { r: sumR / counted, g: sumG / counted, b: sumB / counted },
    opaquePixels: counted,
  };
};

/** Seeded with the mean, which is what a cover with no buckets to rank — an
 * empty bitmap — would deserve anyway. */
const pickAccent = (scanned: Scan): Rgb => {
  let best = scanned.mean;
  let bestScore = -1;
  for (const bucket of scanned.buckets) {
    const colour = averageOf(bucket);
    const score = saliency(rgbToHsl(colour), bucket.count / scanned.opaquePixels);
    // Strictly greater keeps the first bucket on a tie, and buckets are visited
    // in insertion order, so the same image always yields the same accent.
    if (score > bestScore) {
      bestScore = score;
      best = colour;
    }
  }
  return best;
};

/** The mean colour, forced into the dark band the chrome is designed against. */
const deriveSurface = (mean: Rgb): Rgb => {
  const hsl = rgbToHsl(mean);
  return hslToRgb({
    h: hsl.h,
    // Uncapped saturation at this lightness produces a muddy, almost brown
    // black on warm sleeves; capping keeps the tint readable as a tint.
    s: Math.min(hsl.s, SURFACE_MAX_SATURATION),
    l: SURFACE_LIGHTNESS,
  });
};

export const extractTheme = (pixels: PixelData): ThemeTokens => {
  const scanned = scan(pixels);
  // A cover that is entirely transparent (or an empty buffer) has no colour to
  // extract, and inventing one from zeroed pixels would theme the device black
  // on black.
  if (scanned.opaquePixels === 0) return DEFAULT_THEME;

  const surface = deriveSurface(scanned.mean);
  const accentHsl = rgbToHsl(pickAccent(scanned));

  const accent = ensureContrast(hslToRgb(accentHsl), surface, {
    minRatio: TEXT_CONTRAST_MIN,
  });

  // The foreground is white with a trace of the album in it — enough that a
  // warm record reads warm, far too little to be mistaken for the accent.
  const foreground = ensureContrast(
    hslToRgb({
      h: accentHsl.h,
      s: accentHsl.s === 0 ? 0 : FOREGROUND_SATURATION,
      l: FOREGROUND_LIGHTNESS,
    }),
    surface,
    { minRatio: TEXT_CONTRAST_MIN },
  );

  return {
    surface: formatHex(surface),
    foreground: formatHex(foreground),
    accent: formatHex(accent),
    onAccent: formatHex(
      ensureContrast(bestNeutralOn(accent), accent, { minRatio: TEXT_CONTRAST_MIN }),
    ),
    controlTint: formatHex(
      ensureContrast(mix(accent, surface, CONTROL_TINT_MIX), surface, {
        minRatio: UI_CONTRAST_MIN,
      }),
    ),
  };
};

/**
 * The tokens under the names the UI binds to.
 *
 * Kept next to the extractor rather than in the UI so that adding a token is
 * one edit: nothing on the browser side should know the roster by heart.
 */
export const themeCssVariables = (tokens: ThemeTokens): Record<string, string> => ({
  '--joshify-surface': tokens.surface,
  '--joshify-foreground': tokens.foreground,
  '--joshify-accent': tokens.accent,
  '--joshify-on-accent': tokens.onAccent,
  '--joshify-control-tint': tokens.controlTint,
});
