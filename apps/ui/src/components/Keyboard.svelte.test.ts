/**
 * @vitest-environment jsdom
 */
/**
 * The board's *behaviour* is `lib/keyboard.ts` and is asserted in Node. What is
 * left for a mounted DOM is what only a DOM can be wrong about: that every key
 * is a real button with a name a finger and a screen reader can both find, that
 * the cap the user taps is the cap that gets reported, and that shift is
 * visibly on rather than only internally on.
 *
 * Key *size* is deliberately not asserted here — jsdom reports every element as
 * 0×0, so a passing measurement would be a lie. The arithmetic that keeps keys
 * over 48px lives in the layout comment and in the span invariant next to it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import Keyboard from './Keyboard.svelte';
import {
  INITIAL_KEYBOARD,
  type KeyboardState,
  type KeyCap,
  type ShiftState,
} from '../lib/keyboard.js';

const mount = (over: Partial<KeyboardState> = {}) => {
  const pressed: KeyCap[] = [];
  const view = render(Keyboard, {
    state: { ...INITIAL_KEYBOARD, ...over },
    onKey: (key: KeyCap) => {
      pressed.push(key);
    },
  });
  return { ...view, pressed };
};

afterEach(cleanup);

describe('the keyboard', () => {
  it('draws ten letters across the top row', () => {
    const { container } = mount();
    const rows = [...container.querySelectorAll('.row')];

    expect(rows).toHaveLength(4);
    const caps = [...(rows[0]?.querySelectorAll('button') ?? [])];
    expect(caps.map((key) => key.textContent.trim())).toEqual(Array.from('qwertyuiop'));
  });

  it('reports the cap that was tapped, not the character underneath it', async () => {
    const { pressed } = mount({ shift: 'once' });
    await fireEvent.click(screen.getByRole('button', { name: 'B' }));

    expect(pressed).toEqual([
      { kind: 'char', label: 'B', value: 'B', span: 1, name: 'B' },
    ]);
  });

  // The glyph keys are the ones a screen reader cannot read and a finger has to
  // find by shape, so both get a name.
  it('names every key, glyphs included', () => {
    mount();

    expect(screen.getByRole('button', { name: 'Shift' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Backspace' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Space' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Numbers and symbols' })).toBeDefined();
  });

  // Two taps and three taps are different states, and a user who cannot tell
  // them apart has to type a letter to find out which one they are in.
  it.each<[ShiftState]>([['off'], ['once'], ['lock']])('shows shift as %s', (shift) => {
    mount({ shift });
    const key = screen.getByRole('button', { name: 'Shift' });

    expect(key.getAttribute('data-shift')).toBe(shift);
    expect(key.getAttribute('aria-pressed')).toBe(String(shift !== 'off'));
  });

  it('shows the letters in the case they will type', () => {
    mount({ shift: 'lock' });

    expect(screen.getByRole('button', { name: 'Q' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'q' })).toBeNull();
  });

  it('swaps to the digits, with the way back on it', () => {
    mount({ layer: 'symbols' });

    expect(screen.getByRole('button', { name: '1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Letters' })).toBeDefined();
    // Nothing on this board has a case, so shift is not offered at all.
    expect(screen.queryByRole('button', { name: 'Shift' })).toBeNull();
  });
});
