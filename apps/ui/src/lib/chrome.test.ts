import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createChromeApplier,
  isChromeValue,
  readChrome,
  THEMEABLE_CHROME,
  type ChromeOverrides,
  type StyleTarget,
} from './chrome.js';

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../styles/tokens.css', import.meta.url)),
  'utf8',
);

interface Write {
  readonly property: string;
  readonly value: string | null;
}

const target = (): { element: StyleTarget; writes: Write[] } => {
  const writes: Write[] = [];
  return {
    writes,
    element: {
      style: {
        setProperty: (property, value) => writes.push({ property, value }),
        removeProperty: (property) => writes.push({ property, value: null }),
      },
    },
  };
};

const apply = (...themes: readonly ChromeOverrides[]): Write[] => {
  const { element, writes } = target();
  const applier = createChromeApplier(element);
  for (const theme of themes) applier.apply(theme);
  return writes;
};

describe('the roster', () => {
  // A token in the roster that no rule reads is a theme that appears to do
  // nothing — the exact failure the allow-list exists to prevent.
  it('names only properties the stylesheet actually defines', () => {
    for (const property of THEMEABLE_CHROME) {
      expect(TOKENS_CSS, property).toContain(`${property}:`);
    }
  });

  /*
   * The guard, and the reason this file is worth reading.
   *
   * The 4.5:1 result in `gl/legibility.test.ts` is a property of *these*
   * values composited in this order. Nothing stops a theme darkening the ink
   * except this list, and the failure is not a red test — it is a wall panel
   * that cannot be read over a white sleeve.
   */
  it('keeps the legibility floor out of reach', () => {
    for (const property of [
      '--jf-ink',
      '--jf-ink-dim',
      '--jf-ink-faint',
      '--jf-plate',
      '--jf-plate-scrim',
      '--jf-plate-solid',
      '--jf-scrim',
    ]) {
      expect(THEMEABLE_CHROME).not.toContain(property);
    }
  });

  it('keeps the touch floor and the type scale out of it too', () => {
    for (const property of THEMEABLE_CHROME) {
      expect(property.startsWith('--jf-touch')).toBe(false);
      expect(property.startsWith('--jf-size')).toBe(false);
    }
  });

  // Reduced motion is expressed by zeroing this at the `:root`; a theme that
  // set it would win over the media query and animate anyway.
  it('does not let a theme reach the crossfade the motion preference zeroes', () => {
    expect(THEMEABLE_CHROME).not.toContain('--jf-theme-fade');
  });
});

describe('reading the chrome a bundle declares', () => {
  it('takes the tokens in roster', () => {
    const { chrome, rejected } = readChrome({ '--jf-plate-radius': '0px' });

    expect(chrome).toEqual({ '--jf-plate-radius': '0px' });
    expect(rejected).toEqual([]);
  });

  it('drops one out of roster and says which, rather than failing the theme', () => {
    const { chrome, rejected } = readChrome({
      '--jf-plate-radius': '0px',
      '--jf-ink': '#333',
    });

    expect(chrome).toEqual({ '--jf-plate-radius': '0px' });
    expect(rejected).toEqual(['--jf-ink']);
  });

  it('rejects a value that could close the declaration it lands in', () => {
    expect(isChromeValue('0px; position: fixed')).toBe(false);
    expect(isChromeValue('}')).toBe(false);
  });

  it('rejects a blank value, which reads as unset but is not', () => {
    expect(isChromeValue('   ')).toBe(false);
  });

  it('accepts a font stack, which is the longest legitimate value', () => {
    expect(
      isChromeValue("'Barlow Condensed', 'Archivo Narrow', system-ui, sans-serif"),
    ).toBe(true);
  });

  it('reads a non-object as no chrome at all', () => {
    expect(readChrome(null).chrome).toEqual({});
    expect(readChrome('theme').chrome).toEqual({});
  });
});

describe('applying it', () => {
  it('writes what the theme asked for', () => {
    expect(apply({ '--jf-plate-radius': '0px', '--jf-plate-blur': '0px' })).toEqual([
      { property: '--jf-plate-radius', value: '0px' },
      { property: '--jf-plate-blur', value: '0px' },
    ]);
  });

  it('writes nothing for a theme that declares no chrome', () => {
    expect(apply({})).toEqual([]);
  });

  it('does not rewrite a token the next theme sets to the same value', () => {
    const writes = apply({ '--jf-plate-radius': '0px' }, { '--jf-plate-radius': '0px' });

    expect(writes).toHaveLength(1);
  });

  /*
   * The one that matters for shuffle-on-track-change (P5-36): an inline custom
   * property outranks the stylesheet, so a theme that says nothing about a
   * token only gets the default if the last theme's value is *removed*.
   */
  it('puts back the default for a token the next theme does not mention', () => {
    const writes = apply({ '--jf-plate-radius': '0px' }, { '--jf-plate-blur': '0px' });

    expect(writes).toEqual([
      { property: '--jf-plate-radius', value: '0px' },
      { property: '--jf-plate-radius', value: null },
      { property: '--jf-plate-blur', value: '0px' },
    ]);
  });

  it('does not remove a token that was never set', () => {
    expect(apply({}, {})).toEqual([]);
  });

  it('reports what is on the element', () => {
    const { element } = target();
    const applier = createChromeApplier(element);
    applier.apply({ '--jf-press': '0ms' });

    expect(applier.current()).toEqual({ '--jf-press': '0ms' });

    applier.apply({});
    expect(applier.current()).toEqual({});
  });
});
