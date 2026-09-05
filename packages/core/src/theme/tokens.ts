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
