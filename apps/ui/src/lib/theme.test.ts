import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, type ThemeTokens } from '@joshify/core';
import {
  createThemeApplier,
  isThemeTokens,
  readTheme,
  sameTheme,
  type StyleTarget,
} from './theme.js';

const fakeTarget = () => {
  const properties = new Map<string, string>();
  const writes: string[] = [];
  const target: StyleTarget = {
    style: {
      setProperty: (property, value) => {
        properties.set(property, value);
        writes.push(property);
      },
      removeProperty: (property) => {
        properties.delete(property);
      },
    },
  };
  return { target, properties, writes };
};

const album: ThemeTokens = {
  surface: '#0d1418',
  foreground: '#eef4f6',
  accent: '#ff5c8a',
  onAccent: '#1a0910',
  controlTint: '#7d94a0',
};

describe('applying a theme', () => {
  it('writes the five custom properties the UI binds to', () => {
    const { target, properties } = fakeTarget();
    createThemeApplier(target, album);

    expect(properties.get('--joshify-accent')).toBe('#ff5c8a');
    expect(properties.get('--joshify-surface')).toBe('#0d1418');
    expect(properties.get('--joshify-on-accent')).toBe('#1a0910');
    expect(properties.size).toBe(5);
  });

  it('starts from the neutral default when given nothing', () => {
    const { target, properties } = fakeTarget();
    createThemeApplier(target);

    expect(properties.get('--joshify-accent')).toBe(DEFAULT_THEME.accent);
  });

  // Every poll builds a fresh object. Writing five properties re-resolves
  // styles for the whole document, and most of those writes change nothing.
  it('does not rewrite properties for an equal but distinct object', () => {
    const { target, writes } = fakeTarget();
    const applier = createThemeApplier(target, album);
    const before = writes.length;

    applier.apply({ ...album });

    expect(writes).toHaveLength(before);
  });

  it('rewrites when any single token changes', () => {
    const { target, properties, writes } = fakeTarget();
    const applier = createThemeApplier(target, album);
    const before = writes.length;

    applier.apply({ ...album, accent: '#22cc88' });

    expect(writes.length).toBeGreaterThan(before);
    expect(properties.get('--joshify-accent')).toBe('#22cc88');
    expect(applier.current().accent).toBe('#22cc88');
  });

  it('compares every token, not just the accent', () => {
    expect(sameTheme(album, { ...album })).toBe(true);
    expect(sameTheme(album, { ...album, surface: '#000000' })).toBe(false);
    expect(sameTheme(album, { ...album, foreground: '#ffffff' })).toBe(false);
    expect(sameTheme(album, { ...album, onAccent: '#ffffff' })).toBe(false);
    expect(sameTheme(album, { ...album, controlTint: '#ffffff' })).toBe(false);
  });
});

// A custom property accepts any string, so a malformed value is not an error —
// it is a silently unstyled panel, which is much harder to diagnose.
describe('reading a theme off the wire', () => {
  it('accepts three- and six-digit hex in either case', () => {
    expect(isThemeTokens({ ...album, accent: '#FFF' })).toBe(true);
    expect(isThemeTokens({ ...album, accent: '#AbCdEf' })).toBe(true);
  });

  it.each([
    ['a named colour', { ...album, accent: 'rebeccapurple' }],
    ['a CSS function', { ...album, accent: 'rgb(1,2,3)' }],
    ['an injected declaration', { ...album, accent: 'red; --jf-ink: red' }],
    ['four digits', { ...album, accent: '#abcd' }],
    ['a missing token', { surface: '#000000' }],
    ['a non-string token', { ...album, accent: 0x00ff00 }],
    ['not an object', 'accent'],
    ['null', null],
  ])('falls back to the default for %s', (_label, value) => {
    expect(isThemeTokens(value)).toBe(false);
    expect(readTheme(value)).toEqual(DEFAULT_THEME);
  });

  it('passes a well-formed theme straight through', () => {
    expect(readTheme(album)).toEqual(album);
  });
});
