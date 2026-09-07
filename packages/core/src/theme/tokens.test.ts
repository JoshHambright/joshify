import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, themeContrastProblems, themeCssVariables } from './tokens.js';

describe('the CSS custom properties', () => {
  it('names all five, so nothing on the browser side knows the roster by heart', () => {
    expect(Object.keys(themeCssVariables(DEFAULT_THEME))).toEqual([
      '--joshify-surface',
      '--joshify-foreground',
      '--joshify-accent',
      '--joshify-on-accent',
      '--joshify-control-tint',
    ]);
  });

  it('passes the values through untouched — the UI computes nothing (D-003)', () => {
    expect(themeCssVariables(DEFAULT_THEME)['--joshify-accent']).toBe(
      DEFAULT_THEME.accent,
    );
  });
});

describe('holding a hand-written palette to the same rule as a derived one', () => {
  it('passes the default, which is the palette every panel starts on', () => {
    expect(themeContrastProblems(DEFAULT_THEME)).toEqual([]);
  });

  it('names the pairing, the ratio and the floor, not just "illegible"', () => {
    // White on it clears the button floor, so only one pairing is at fault.
    const problems = themeContrastProblems({
      ...DEFAULT_THEME,
      accent: '#1b1d22',
      onAccent: '#ffffff',
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('accent on surface');
    expect(problems[0]).toContain('below 4.5:1');
  });

  it('holds non-text chrome to 3:1, not to 4.5:1', () => {
    // Fails the text floor comfortably, clears the chrome floor it is held to.
    const tint = '#5b6472';

    expect(themeContrastProblems({ ...DEFAULT_THEME, controlTint: tint })).toEqual([]);
    expect(
      themeContrastProblems({ ...DEFAULT_THEME, accent: tint, onAccent: '#ffffff' }),
    ).toHaveLength(1);
  });

  it('checks a label against the button it sits on, not against the backdrop', () => {
    const problems = themeContrastProblems({
      ...DEFAULT_THEME,
      accent: '#f2f3f5',
      onAccent: '#f2f3f5',
    });

    expect(problems).toEqual([
      expect.stringContaining('onAccent on accent') as unknown as string,
    ]);
  });

  it('reports every pairing that fails, not the first', () => {
    expect(
      themeContrastProblems({
        surface: '#ffffff',
        foreground: '#fafafa',
        accent: '#f5f5f5',
        onAccent: '#f4f4f4',
        controlTint: '#fbfbfb',
      }),
    ).toHaveLength(4);
  });

  it('calls a malformed colour a problem rather than reading it as black', () => {
    expect(
      themeContrastProblems({ ...DEFAULT_THEME, surface: 'rebeccapurple' }),
    ).not.toEqual([]);
  });
});
