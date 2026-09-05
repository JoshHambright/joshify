/**
 * Applying the album's five tokens. The UI computes nothing (D-003).
 *
 * Everything here is a write of a hex string the server already proved
 * contrast-safe (P3-04). There is no colour maths on this side on purpose:
 * a second implementation of the contrast rules on the browser is a second
 * place for them to be subtly wrong, and the browser is the half that cannot
 * be tested against 121 hostile pairings.
 *
 * The target element is injected rather than assumed to be `document`, which
 * is what makes this testable and what will let a theme be previewed inside a
 * subtree later (D-017 chrome themes).
 */
import { DEFAULT_THEME, themeCssVariables, type ThemeTokens } from '@joshify/core';

/** The subset of `HTMLElement` this touches. Narrow enough to fake. */
export interface StyleTarget {
  readonly style: {
    setProperty: (property: string, value: string) => void;
    removeProperty: (property: string) => void;
  };
}

/**
 * Whether two token sets are the same.
 *
 * Worth checking: a poll produces a fresh object every few seconds, and
 * writing five custom properties re-runs style resolution for the whole
 * document. Most of those writes would set the value it already has.
 */
export const sameTheme = (a: ThemeTokens, b: ThemeTokens): boolean =>
  a.surface === b.surface &&
  a.foreground === b.foreground &&
  a.accent === b.accent &&
  a.onAccent === b.onAccent &&
  a.controlTint === b.controlTint;

/**
 * A hex colour as the server sends them: `#rgb` or `#rrggbb`.
 *
 * Validated not because the server is untrusted but because a custom property
 * accepts *any* string — a malformed one is not an error, it is a silently
 * unstyled panel, which is far harder to diagnose than a rejected value.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isThemeTokens = (value: unknown): value is ThemeTokens => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (['surface', 'foreground', 'accent', 'onAccent', 'controlTint'] as const).every(
    (key) => typeof record[key] === 'string' && HEX.test(record[key]),
  );
};

/** A theme from the wire, or the neutral default if it is not one. */
export const readTheme = (value: unknown): ThemeTokens =>
  isThemeTokens(value) ? value : DEFAULT_THEME;

export interface ThemeApplier {
  /** Writes the tokens if they differ from what was last written. */
  readonly apply: (tokens: ThemeTokens) => void;
  /** What is currently on the element. */
  readonly current: () => ThemeTokens;
}

export const createThemeApplier = (
  target: StyleTarget,
  initial: ThemeTokens = DEFAULT_THEME,
): ThemeApplier => {
  let applied: ThemeTokens | null = null;

  const write = (tokens: ThemeTokens): void => {
    for (const [property, value] of Object.entries(themeCssVariables(tokens))) {
      target.style.setProperty(property, value);
    }
    applied = tokens;
  };

  write(initial);

  return {
    apply: (tokens) => {
      if (applied !== null && sameTheme(applied, tokens)) return;
      write(tokens);
    },
    current: () => applied ?? initial,
  };
};
