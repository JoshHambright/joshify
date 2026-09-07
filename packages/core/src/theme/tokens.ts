/**
 * The theme contract: the five tokens, their default, and the CSS custom
 * property names the UI binds to.
 *
 * This lives in core rather than beside the extractor because both ends need
 * it. The server derives the tokens from pixels; the browser writes them onto
 * the document root and computes nothing. Splitting the *contract* out from the
 * *derivation* is what lets the UI hold the type without dragging an image
 * decoder into the bundle.
 */
import {
  contrastRatio,
  parseHex,
  TEXT_CONTRAST_MIN,
  UI_CONTRAST_MIN,
} from '../colour/contrast.js';

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

/**
 * The four pairings a theme has to survive, and the floor each one sits on.
 *
 * The extractor *produces* tokens that meet these (it clamps until they do),
 * so on the derived path this is a restatement. It exists because there is a
 * second path: a theme bundle may pin a fixed palette instead of the album's
 * (D-017), and a hand-written palette has nothing clamping it. Both paths are
 * then held to the same rule from the same place, which is the only way the
 * guarantee stays one guarantee.
 */
const PAIRINGS = [
  ['foreground', 'surface', TEXT_CONTRAST_MIN, 'body text on the backdrop'],
  ['accent', 'surface', TEXT_CONTRAST_MIN, 'the album colour used as text'],
  ['onAccent', 'accent', TEXT_CONTRAST_MIN, 'a label on a filled button'],
  ['controlTint', 'surface', UI_CONTRAST_MIN, 'slider tracks and icon strokes'],
] as const satisfies readonly (readonly [
  keyof ThemeTokens,
  keyof ThemeTokens,
  number,
  string,
])[];

/**
 * Every pairing that falls short, said in full — which colours, what ratio,
 * what was needed, and what the pairing is *for*.
 *
 * A list rather than a boolean: "this theme is illegible" sends someone back
 * to a five-token object with no idea which two of them fight.
 */
export const themeContrastProblems = (tokens: ThemeTokens): readonly string[] => {
  const problems: string[] = [];

  for (const [front, back, floor, purpose] of PAIRINGS) {
    const a = parseHex(tokens[front]);
    const b = parseHex(tokens[back]);
    if (a === null || b === null) {
      problems.push(`${a === null ? front : back} is not a hex colour`);
      continue;
    }
    const ratio = contrastRatio(a, b);
    if (ratio < floor) {
      problems.push(
        `${front} on ${back} is ${ratio.toFixed(2)}:1, below ${floor.toFixed(1)}:1 — ${purpose}`,
      );
    }
  }

  return problems;
};
