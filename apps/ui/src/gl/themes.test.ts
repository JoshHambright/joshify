import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, themeContrastProblems, type ThemeTokens } from '@joshify/core';
import { buildThemes, paletteFor, THEMES, THEME_IDS, type ThemeSpec } from './themes.js';
import { buildLooks, LOOK_IDS } from './looks.js';
import { isThemeableChrome, type ChromeOverrides } from '../lib/chrome.js';

const { presets } = buildLooks();
const built = buildThemes(presets);

const ALBUM: ThemeTokens = {
  surface: '#12100e',
  foreground: '#f6f1ea',
  accent: '#e0a23c',
  onAccent: '#12100e',
  controlTint: '#9c7a3f',
};

const only = (spec: ThemeSpec) => buildThemes(presets, [spec]);

const themeById = (id: string) => {
  const theme = built.themes.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`no theme built for ${id}`);
  return theme;
};

describe('the shipped themes', () => {
  it('all resolve against the real looks', () => {
    expect(built.problems).toEqual([]);
    expect(built.themes).toHaveLength(THEMES.length);
  });

  it('names them in picker order', () => {
    expect(THEME_IDS).toEqual(['night', 'vga', 'reef', 'bevel']);
  });

  it('names a look that exists, not a preset id that used to', () => {
    for (const theme of THEMES) {
      expect(LOOK_IDS, theme.id).toContain(theme.look);
    }
  });

  it('has unique ids and a human name for each', () => {
    expect(new Set(THEME_IDS).size).toBe(THEMES.length);
    for (const theme of built.themes) {
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.name).not.toBe(theme.id);
    }
  });

  // The album's colour arriving on the panel is the product. A theme that pins
  // is the exception, and it should stay countable on one hand.
  it('leaves the album driving the colour except where an idiom cannot take it', () => {
    expect(
      built.themes.filter((theme) => theme.palette !== null).map((t) => t.id),
    ).toEqual(['vga']);
  });

  it('holds every pinned palette to the rule the extractor is held to', () => {
    for (const theme of built.themes) {
      if (theme.palette !== null)
        expect(themeContrastProblems(theme.palette), theme.id).toEqual([]);
    }
  });

  it('declares only chrome a theme is allowed to reach', () => {
    for (const theme of THEMES) {
      for (const property of Object.keys(theme.chrome ?? {})) {
        expect(isThemeableChrome(property), `${theme.id} ${property}`).toBe(true);
      }
    }
  });
});

describe('building one that is wrong', () => {
  it('drops a theme naming a look that does not exist, and says so', () => {
    const { themes, problems } = only({ id: 'ghosts', name: 'Ghosts', look: 'gohst' });

    expect(themes).toEqual([]);
    expect(problems).toEqual(['ghosts: no look named gohst']);
  });

  /*
   * Dropped rather than shown with the palette ignored: a chrome token can be
   * partially honoured, a palette cannot. Half of an unreadable palette is
   * still unreadable, and the failure is a wall panel nobody can read rather
   * than a red test.
   */
  it('drops a theme whose pinned palette fails the contrast floor', () => {
    const { themes, problems } = only({
      id: 'murk',
      name: 'Murk',
      look: 'ghost',
      palette: { ...DEFAULT_THEME, foreground: '#151619' },
    });

    expect(themes).toEqual([]);
    expect(problems[0]).toContain('murk: foreground on surface');
  });

  it('keeps a theme whose chrome has one bad token, and names the token', () => {
    const { themes, problems } = only({
      id: 'ink',
      name: 'Ink',
      look: 'ghost',
      // Deliberately out of roster: the type forbids it, and the runtime guard
      // is what actually stands between a bundle and the legibility floor.
      chrome: { '--jf-ink': '#333', '--jf-plate-radius': '0px' } as ChromeOverrides,
    });

    expect(themes[0]?.chrome).toEqual({ '--jf-plate-radius': '0px' });
    expect(problems).toEqual(['ink: --jf-ink is not a chrome token a theme may set']);
  });

  it('refuses a second theme under an id already taken', () => {
    const spec: ThemeSpec = { id: 'night', name: 'Night', look: 'ghost' };
    const { themes, problems } = buildThemes(presets, [
      spec,
      { ...spec, name: 'Night II' },
    ]);

    expect(themes).toHaveLength(1);
    expect(problems).toEqual(['night: declared twice']);
  });
});

describe('which palette gets applied', () => {
  it('follows the album for a theme that pins nothing', () => {
    expect(paletteFor(themeById('night'), ALBUM)).toEqual(ALBUM);
  });

  it('ignores the album for a theme that pins, which is the point of pinning', () => {
    const vga = themeById('vga');

    expect(paletteFor(vga, ALBUM)).toEqual(vga.palette);
  });

  it('falls back to the neutral default before any album has arrived', () => {
    expect(paletteFor(themeById('night'))).toEqual(DEFAULT_THEME);
  });
});
