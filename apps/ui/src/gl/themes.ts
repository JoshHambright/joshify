/**
 * Theme bundles: palette + scene + chain + chrome, as one named unit (P5-31).
 *
 * D-017 chose the Microsoft Plus! model over the Winamp-skin model, and this
 * file is what that means in practice. A skin is a pile of images; a Plus!
 * theme was a *set* — the wallpaper, the cursors, the sounds and the colours
 * changed together, and picking one changed the whole machine. So a Joshify
 * theme is not "a visualiser preset with a nicer name": it is the look, the
 * chrome tokens (D-073) and, where the era demands it, a pinned palette.
 *
 * **The palette axis is the one that needed a decision.** Almost every theme
 * should leave the palette alone: the album's colour arriving on the panel is
 * the product, and pinning it throws that away. But some idioms have no room
 * for an arbitrary accent — a theme built on eight stops per channel cannot
 * absorb whatever hue a sleeve happens to be. Those pin, and pinning is the
 * exception a theme has to justify in a comment.
 *
 * A pinned palette is held to the *same* four pairings the extractor's output
 * is (`themeContrastProblems` in core). A hand-written palette has nothing
 * clamping it, and "this theme is beautiful and unreadable" is a bug that ships
 * unless something checks.
 *
 * **Built, not declared.** `buildThemes` resolves the look id against the real
 * presets and drops a theme that does not resolve, with a problem string —
 * the same idiom as `buildLooks`. A theme naming a look somebody renamed must
 * not take the picker down with it, and must not vanish silently either.
 */
import { DEFAULT_THEME, themeContrastProblems, type ThemeTokens } from '@joshify/core';
import { readChrome, type ChromeOverrides } from '../lib/chrome.js';
import { buildLooks } from './looks.js';
import type { Preset } from './passes.js';

export interface ThemeSpec {
  readonly id: string;
  readonly name: string;
  /** A look id from `looks.ts`: the scene, its params, and the chain. */
  readonly look: string;
  /** Tokens from the allow-list. Anything else is dropped and reported. */
  readonly chrome?: ChromeOverrides | undefined;
  /** Absent means the album's own five, which is the answer for most themes. */
  readonly palette?: ThemeTokens | undefined;
}

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly preset: Preset;
  readonly chrome: ChromeOverrides;
  /** Null means "follow the album" — not "no palette". */
  readonly palette: ThemeTokens | null;
}

/**
 * The shipped roster.
 *
 * Short on purpose. A theme earns its place by being a different *machine*,
 * not a different preset — two entries that differ only in their chain belong
 * in `looks.ts` as two looks under one theme.
 */
export const THEMES: readonly ThemeSpec[] = [
  {
    // The default, and the one the panel spends its life in: the album's
    // colour on near-black, and a look that stays out of the way while
    // somebody is actually pressing things.
    id: 'night',
    name: 'Night',
    look: 'ghost',
  },
  {
    // P5-33. The pinned palette is the point rather than a shortcut: eight
    // stops per channel cannot absorb an arbitrary sleeve hue, and a dithered
    // quantise of a colour the theme did not choose is mud. So the album stops
    // driving the colour here — the one place in the product where it does —
    // and `posterize` remaps the art through *these* five instead.
    //
    // The chrome follows the same era: a hard corner, no glass, and the mono
    // face the panel already loads for times and counts.
    id: 'vga',
    name: 'VGA',
    look: 'vga',
    palette: {
      surface: '#0c0c3a',
      foreground: '#e6e6f2',
      accent: '#ffd24a',
      onAccent: '#0c0c3a',
      controlTint: '#7d7dc4',
    },
    chrome: {
      '--jf-plate-radius': '0px',
      // Safe to drop: the legibility proof takes the worst-case flat backdrop,
      // and blur only averages toward it. Removing blur cannot make the plate
      // sit on anything worse than the case already solved for.
      '--jf-plate-blur': '0px',
      '--jf-plate-edge': 'rgb(255 255 255 / 0.35)',
      '--jf-face-display': "'Share Tech Mono', ui-monospace, monospace",
      '--jf-face-label': "'Share Tech Mono', ui-monospace, monospace",
      '--jf-track-label': '0.06em',
    },
  },
  {
    // P5-38. The tonal opposite of the tunnel, and the reason the calm mode is
    // a product gap rather than a nice-to-have (D-018): a panel on a wall is
    // running while nobody is asking it for anything.
    //
    // It pins nothing. The reef scene makes the album *the light* — the cover
    // is what the surface transmits — so a fixed palette would put the lamp
    // out. This is what the common case looks like: a theme is a look and a
    // little chrome, and the record still supplies the colour.
    id: 'reef',
    name: 'Reef',
    look: 'reef',
    chrome: {
      // Softer corner and a heavier blur than the default: the chrome should
      // read as something submerged, and neither token is load-bearing for
      // the contrast proof (D-073).
      '--jf-plate-radius': '34px',
      '--jf-plate-blur': '34px',
      '--jf-plate-edge': 'rgb(255 255 255 / 0.06)',
      // Nothing snaps in this theme, including a button under a finger.
      '--jf-press': '160ms',
    },
  },
  {
    // P5-34, under a name of its own. The tracker carried a working title
    // borrowed from the Microsoft product this is an homage to; D-015 does not
    // allow a theme named after a trademark, so it is named for the thing it
    // actually does to the chrome.
    //
    // Pins nothing, like `reef` and for the same reason: the scene uses the
    // cover as both the field behind the solids and the crop on every facet,
    // so the record is already supplying the colour.
    id: 'bevel',
    name: 'Bevel',
    look: 'solids',
    chrome: {
      // 1995 had no glass. A near-square corner, no blur, and a hard bright
      // top edge — which is the entire visual grammar of a raised control.
      '--jf-plate-radius': '4px',
      '--jf-plate-blur': '0px',
      '--jf-plate-edge': 'rgb(255 255 255 / 0.5)',
      // A bevel snaps. The absence of a transition is the period detail.
      '--jf-press': '0ms',
      '--jf-track-label': '0.04em',
    },
  },
];

export interface BuiltThemes {
  readonly themes: readonly Theme[];
  readonly problems: readonly string[];
}

export const buildThemes = (
  presets: readonly Preset[] = buildLooks().presets,
  specs: readonly ThemeSpec[] = THEMES,
): BuiltThemes => {
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  const themes: Theme[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    if (seen.has(spec.id)) {
      problems.push(`${spec.id}: declared twice`);
      continue;
    }
    seen.add(spec.id);

    const preset = byId.get(spec.look);
    if (preset === undefined) {
      problems.push(`${spec.id}: no look named ${spec.look}`);
      continue;
    }

    const { chrome, rejected } = readChrome(spec.chrome ?? {});
    for (const property of rejected) {
      problems.push(`${spec.id}: ${property} is not a chrome token a theme may set`);
    }

    // A palette that fails is dropped rather than shown: an unreadable panel
    // is worse than a theme that is missing from the picker, and unlike a
    // missing chrome token it cannot be partially honoured.
    const palette = spec.palette ?? null;
    if (palette !== null) {
      const failures = themeContrastProblems(palette);
      if (failures.length > 0) {
        problems.push(...failures.map((failure) => `${spec.id}: ${failure}`));
        continue;
      }
    }

    themes.push({ id: spec.id, name: spec.name, preset, chrome, palette });
  }

  return { themes, problems };
};

/**
 * The palette a theme wants applied, given what the album offered.
 *
 * Exists so the caller never writes `theme.palette ?? albumTheme` by hand and
 * gets the fallback backwards once — which is a panel that ignores the album
 * on every theme, and looks like the extractor broke.
 */
export const paletteFor = (
  theme: Theme,
  album: ThemeTokens = DEFAULT_THEME,
): ThemeTokens => theme.palette ?? album;

/** The ids, in picker order. Exported so a test can hold the order still. */
export const THEME_IDS: readonly string[] = THEMES.map((theme) => theme.id);
