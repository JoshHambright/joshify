/**
 * Which chrome a theme is allowed to reach (P5-32, D-017).
 *
 * A theme bundle is palette + scene + chain + **chrome**: the `PLUS!`-era look
 * wants a bevelled edge, a 16-colour look wants a hard corner and no blur, and
 * neither is expressible if the chrome is a constant. So some of the `--jf-*`
 * half becomes writable at runtime.
 *
 * **Not all of it.** The reason this is an allow-list rather than "themes may
 * set any custom property" is that three groups of tokens carry guarantees
 * that were proved once and must hold for themes nobody has written yet:
 *
 * - **The inks and the plate substrate** carry the legibility floor (D-068).
 *   The 4.5:1 result is a property of `--jf-ink*` composited over
 *   `--jf-plate` over `--jf-plate-scrim` over live artwork, and it was solved
 *   for *those* values. A theme that darkens the ink or thins the scrim does
 *   not fail a test; it produces a panel that is unreadable over a white
 *   sleeve, on a wall, at a glance.
 * - **The touch sizes** are the 48px floor from SCREENS.md.
 * - **The type sizes** are the measurements a 720×1280 panel seen from across
 *   a room was laid out against. A theme changes the *face*; it does not get
 *   to shrink the title.
 *
 * The roster below is therefore deliberately short, and grows only when a
 * theme genuinely needs a token and that token carries no guarantee. Adding
 * one is an edit here plus a line in `THEMEABLE_CHROME`'s test — which is the
 * point: it is a decision, not a spelling.
 */

/**
 * The custom properties a theme may write.
 *
 * Shape and edge, the three faces, the label tracking, and the press timing —
 * everything a period idiom is actually made of, and nothing that a contrast
 * or touch guarantee depends on.
 */
export const THEMEABLE_CHROME = [
  '--jf-plate-radius',
  '--jf-plate-blur',
  '--jf-plate-edge',
  '--jf-face-display',
  '--jf-face-label',
  '--jf-face-data',
  '--jf-track-label',
  '--jf-press',
] as const;

export type ThemeableChrome = (typeof THEMEABLE_CHROME)[number];

/** A theme's chrome, as a bundle declares it. Every key optional. */
export type ChromeOverrides = Partial<Record<ThemeableChrome, string>>;

const REACHABLE: ReadonlySet<string> = new Set<string>(THEMEABLE_CHROME);

export const isThemeableChrome = (property: string): property is ThemeableChrome =>
  REACHABLE.has(property);

/**
 * A value long enough to be a font stack and short enough not to be a mistake,
 * containing nothing that could close the declaration it lands in.
 *
 * Custom properties accept *any* string, so a malformed value is not an error —
 * it is a token that silently does nothing, which is the hardest kind of theme
 * bug to see. Rejecting it names the problem instead. (Same reasoning as the
 * hex check in `theme.ts`.)
 */
const MAX_VALUE = 200;
const FORBIDDEN = /[;{}<>]/;

export const isChromeValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= MAX_VALUE &&
  !FORBIDDEN.test(value);

/**
 * The overrides worth applying, dropping anything out of roster or malformed.
 *
 * Dropping rather than throwing: a theme with one bad token should render with
 * the rest of its look, not fail to load. The dropped keys come back so a
 * caller can say which — silence is what made the bug hard in the first place.
 */
export interface ReadChromeResult {
  readonly chrome: ChromeOverrides;
  readonly rejected: readonly string[];
}

export const readChrome = (value: unknown): ReadChromeResult => {
  if (typeof value !== 'object' || value === null) return { chrome: {}, rejected: [] };

  const chrome: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isThemeableChrome(property) && isChromeValue(raw)) chrome[property] = raw;
    else rejected.push(property);
  }
  return { chrome, rejected };
};

/** The subset of `HTMLElement` this touches — the same seam `theme.ts` uses. */
export interface StyleTarget {
  readonly style: {
    setProperty: (property: string, value: string) => void;
    removeProperty: (property: string) => void;
  };
}

export interface ChromeApplier {
  /** Writes this theme's chrome and clears whatever the last one set. */
  readonly apply: (chrome: ChromeOverrides) => void;
  /** What is currently written on the element. */
  readonly current: () => ChromeOverrides;
}

/**
 * Applies a theme's chrome, and — the part that is easy to leave out —
 * *unapplies* the last theme's.
 *
 * Switching from a theme that set a 0px radius to one that says nothing about
 * radius has to put the corner back. An inline custom property outranks the
 * stylesheet, so "says nothing" only means "the default" if the property is
 * actually removed. Otherwise a shuffle-on-track-change (P5-36) accumulates
 * chrome from every theme it has passed through.
 */
export const createChromeApplier = (target: StyleTarget): ChromeApplier => {
  let applied: ChromeOverrides = {};

  return {
    apply: (chrome) => {
      for (const property of THEMEABLE_CHROME) {
        const next = chrome[property];
        if (next === undefined) {
          if (applied[property] !== undefined) target.style.removeProperty(property);
        } else if (next !== applied[property]) {
          target.style.setProperty(property, next);
        }
      }
      applied = { ...chrome };
    },
    current: () => ({ ...applied }),
  };
};
