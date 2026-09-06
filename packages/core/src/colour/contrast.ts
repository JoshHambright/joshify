/**
 * Colour arithmetic both ends of the wire need.
 *
 * The *derivation* of a theme stays on the server — it needs pixels, an image
 * decoder and a salience heuristic, none of which belong in a browser bundle.
 * But the browser now needs to *check* what the server produced: the visualiser
 * runs behind the control plate, and P5-16's legibility floor is the assertion
 * that no effect, at any intensity, can push the composited surface out of
 * contrast with the text on it.
 *
 * So the primitives move here and the derivation does not — the same line
 * D-044 drew for the protocol and the theme tokens.
 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Hue in degrees, saturation and lightness in 0..1. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/** WCAG 2.2 §1.4.3 AA, body text. */
export const TEXT_CONTRAST_MIN = 4.5;

/** WCAG 2.2 §1.4.11, non-text UI components. */
export const UI_CONTRAST_MIN = 3;

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Shared with the derivation on the server, which still needs both. */
export const clampChannel = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
};

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** `null` rather than a throw: hex strings reach this from config files. */
export const parseHex = (hex: string): Rgb | null => {
  const text = hex.trim().replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(text)) return null;

  // The 3-digit form doubles each digit (#f0a === #ff00aa), which is not the
  // same as padding with zeroes — a naive parse turns #fff into near-black.
  const full = text.length === 3 ? text.replace(/[0-9a-f]/g, '$&$&') : text;
  if (full.length !== 6) return null;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
};

export const formatHex = (colour: Rgb): string => {
  const hex = (value: number): string =>
    clampChannel(value).toString(16).padStart(2, '0');
  return `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`;
};

/** WCAG 2.2 relative luminance: sRGB channels linearised, then Rec.709 weights. */
const channelLuminance = (value: number): number => {
  const channel = clampChannel(value) / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (colour: Rgb): number =>
  0.2126 * channelLuminance(colour.r) +
  0.7152 * channelLuminance(colour.g) +
  0.0722 * channelLuminance(colour.b);

/** WCAG 2.2 contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

export const meetsContrast = (a: Rgb, b: Rgb, minRatio: number): boolean =>
  contrastRatio(a, b) >= minRatio;

export const mix = (from: Rgb, to: Rgb, amount: number): Rgb => {
  const t = clamp01(amount);
  return {
    r: clampChannel(from.r + (to.r - from.r) * t),
    g: clampChannel(from.g + (to.g - from.g) * t),
    b: clampChannel(from.b + (to.b - from.b) * t),
  };
};

/**
 * Pure white or pure black, whichever contrasts more with `background`.
 *
 * Because the two are at opposite ends of the luminance range, the better of
 * them clears 4.5:1 against *any* background — the worst case is a background
 * of luminance ~0.179, where both land at ~4.58:1. That property is what lets
 * {@link ensureContrast} promise a result rather than a best effort.
 */
