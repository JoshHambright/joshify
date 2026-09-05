import { describe, expect, it, vi } from 'vitest';
import {
  createQueryDebouncer,
  INITIAL_KEYBOARD,
  KEY_SPAN_PER_ROW,
  layoutFor,
  MAX_QUERY_LENGTH,
  pressKey,
  type KeyboardState,
  type KeyCap,
  type ScheduleDelay,
} from './keyboard.js';

const state = (over: Partial<KeyboardState> = {}): KeyboardState => ({
  ...INITIAL_KEYBOARD,
  ...over,
});

/** The cap the user would have tapped, found the way a finger finds it. */
const capNamed = (from: KeyboardState, name: string): KeyCap => {
  const found = layoutFor(from)
    .flat()
    .find((key) => key.name === name);
  if (found === undefined) throw new Error(`no key named ${name}`);
  return found;
};

/** Type a whole string through the board, so shift behaviour is exercised. */
const type = (from: KeyboardState, text: string): KeyboardState =>
  Array.from(text).reduce(
    (current, char) => pressKey(current, capNamed(current, char)),
    from,
  );

describe('the layout', () => {
  it('is four rows, ten keys across the top', () => {
    const rows = layoutFor(INITIAL_KEYBOARD);

    expect(rows).toHaveLength(4);
    expect(rows[0]?.map((key) => key.label).join('')).toBe('qwertyuiop');
  });

  /*
   * The arithmetic that makes the keys touch-sized: a single key is
   * (720 - 28 padding - 72 gaps) / 10 = 62px, and a key of span s is
   * s * 70 - 8. A row of spans summing to 10 therefore fills the panel exactly,
   * and a row summing to more than 10 would overflow it — which on a fixed
   * panel is broken, not inconvenient (D-039).
   */
  it.each<[KeyboardState, string]>([
    [state(), 'letters'],
    [state({ layer: 'symbols' }), 'symbols'],
  ])('never lays out a %s row wider than the panel', (from) => {
    for (const row of layoutFor(from)) {
      const spans = row.reduce((total, key) => total + key.span, 0);
      expect(spans).toBeLessThanOrEqual(KEY_SPAN_PER_ROW);
    }
  });

  it('gives every key a name, and a value only where it types something', () => {
    for (const key of layoutFor(INITIAL_KEYBOARD).flat()) {
      expect(key.name).not.toBe('');
      expect(key.span).toBeGreaterThanOrEqual(1);
      if (key.kind === 'char') expect(key.value).toBe(key.label);
      else expect(key.value).toBeUndefined();
    }
  });

  // The cap shows what it will type. Anything else and the screen and the query
  // disagree about what a key does.
  it.each<['off' | 'once' | 'lock', string]>([
    ['off', 'q'],
    ['once', 'Q'],
    ['lock', 'Q'],
  ])('draws caps in the case shift is in (%s)', (shift, expected) => {
    expect(layoutFor(state({ shift }))[0]?.[0]?.label).toBe(expected);
  });

  it('swaps the board for digits, and puts the way back on the last row', () => {
    const rows = layoutFor(state({ layer: 'symbols' }));

    expect(rows[0]?.map((key) => key.label).join('')).toBe('1234567890');
    expect(rows[3]?.[0]?.label).toBe('ABC');
    // There is nothing on the symbol board with a case, so shift is not drawn.
    expect(rows.flat().some((key) => key.kind === 'shift')).toBe(false);
  });
});

describe('typing', () => {
  it('appends what the cap showed', () => {
    expect(type(INITIAL_KEYBOARD, 'beatles').text).toBe('beatles');
  });

  it('capitalises one letter after a single shift, then lets go', () => {
    const shifted = pressKey(INITIAL_KEYBOARD, capNamed(INITIAL_KEYBOARD, 'Shift'));
    const typed = type(shifted, 'Ab');

    expect(typed.text).toBe('Ab');
    expect(typed.shift).toBe('off');
  });

  it('holds the case through a lock, and lets three taps release it', () => {
    let current = INITIAL_KEYBOARD;
    current = pressKey(current, capNamed(current, 'Shift'));
    current = pressKey(current, capNamed(current, 'Shift'));
    expect(current.shift).toBe('lock');

    const typed = type(current, 'ABC');
    expect(typed.text).toBe('ABC');
    expect(typed.shift).toBe('lock');

    expect(pressKey(typed, capNamed(typed, 'Shift')).shift).toBe('off');
  });

  it('stops at the length the readout can show', () => {
    const full = type(INITIAL_KEYBOARD, 'a'.repeat(MAX_QUERY_LENGTH));
    const over = pressKey(full, capNamed(full, 'b'));

    expect(full.text).toHaveLength(MAX_QUERY_LENGTH);
    expect(over).toBe(full);
  });
});

describe('backspace', () => {
  it('drops the last character', () => {
    const typed = type(INITIAL_KEYBOARD, 'bea');
    expect(pressKey(typed, capNamed(typed, 'Backspace')).text).toBe('be');
  });

  // A finger on the way to another key should change nothing at all — not the
  // text, not the shift state, not even the object.
  it('changes nothing on an empty field', () => {
    const empty = INITIAL_KEYBOARD;
    expect(pressKey(empty, capNamed(empty, 'Backspace'))).toBe(empty);
  });

  // A UTF-16 slice would leave half a surrogate pair in the query: a character
  // nobody can see, delete or search for.
  it('drops a whole astral character rather than half of one', () => {
    const withEmoji = state({ text: 'bea🎸' });
    expect(pressKey(withEmoji, capNamed(withEmoji, 'Backspace')).text).toBe('bea');
  });
});

describe('the other keys', () => {
  it('types a space between words', () => {
    const typed = type(INITIAL_KEYBOARD, 'the');
    expect(pressKey(typed, capNamed(typed, 'Space')).text).toBe('the ');
  });

  // Both are keystrokes that cannot change the answer: Spotify trims and
  // tokenises the query, so a leading or doubled space finds exactly the same
  // thing and costs a request to prove it.
  it.each([
    ['', 'a leading space'],
    ['the ', 'a doubled space'],
  ])('swallows %s', (text) => {
    const from = state({ text });
    expect(pressKey(from, capNamed(from, 'Space'))).toBe(from);
  });

  it('clears the field and puts shift down', () => {
    const from = state({ text: 'beatles', shift: 'lock' });
    expect(pressKey(from, capNamed(from, 'Clear'))).toEqual(state({ text: '' }));
  });

  it('keeps the text when the board changes, and drops the shift', () => {
    const from = state({ text: 'blink', shift: 'lock' });
    const swapped = pressKey(from, capNamed(from, 'Numbers and symbols'));

    expect(swapped).toEqual(state({ text: 'blink', layer: 'symbols' }));
    expect(pressKey(swapped, capNamed(swapped, 'Letters')).layer).toBe('letters');
  });

  it('types the digits on the symbol board', () => {
    const symbols = state({ layer: 'symbols' });
    expect(type(symbols, '182').text).toBe('182');
  });
});

/** A schedule the test drives by hand, so nothing here waits on a real timer. */
const manualSchedule = () => {
  let pending: (() => void) | null = null;
  const schedule: ScheduleDelay = (run) => {
    pending = run;
    return () => {
      pending = null;
    };
  };
  return {
    schedule,
    isPending: () => pending !== null,
    fire: () => {
      const run = pending;
      pending = null;
      run?.();
    },
  };
};

describe('the query debouncer', () => {
  it('sends nothing until the typing goes quiet', () => {
    const timer = manualSchedule();
    const emit = vi.fn<(query: string) => void>();
    const debouncer = createQueryDebouncer({ emit, schedule: timer.schedule });

    debouncer.set('b');
    debouncer.set('be');
    debouncer.set('bea');
    expect(emit).not.toHaveBeenCalled();

    timer.fire();
    expect(emit.mock.calls).toEqual([['bea']]);
  });

  // The keystroke that cancels the send is the whole point: typing "beatles" is
  // one request, not seven, against a rate limit shared with the poll loop.
  it('cancels the pending send when another key lands', () => {
    const timer = manualSchedule();
    const emit = vi.fn<(query: string) => void>();
    const debouncer = createQueryDebouncer({ emit, schedule: timer.schedule });

    debouncer.set('bea');
    debouncer.set('beat');
    timer.fire();

    expect(emit.mock.calls).toEqual([['beat']]);
  });

  it('trims what it sends, since the trailing space is not part of the query', () => {
    const timer = manualSchedule();
    const emit = vi.fn<(query: string) => void>();
    createQueryDebouncer({ emit, schedule: timer.schedule }).set('the ');
    timer.fire();

    expect(emit.mock.calls).toEqual([['the']]);
  });

  // Waiting a quarter of a second to put the library back is the one delay the
  // user would read as the screen being stuck: nothing is being typed to
  // explain it.
  it('answers a cleared field immediately, and drops what was pending', () => {
    const timer = manualSchedule();
    const emit = vi.fn<(query: string) => void>();
    const debouncer = createQueryDebouncer({ emit, schedule: timer.schedule });

    debouncer.set('bea');
    debouncer.set('');

    expect(emit.mock.calls).toEqual([['']]);
    expect(timer.isPending()).toBe(false);
  });

  it('abandons a pending send when the screen closes', () => {
    const timer = manualSchedule();
    const emit = vi.fn<(query: string) => void>();
    const debouncer = createQueryDebouncer({ emit, schedule: timer.schedule });

    debouncer.set('bea');
    debouncer.cancel();
    timer.fire();

    expect(emit).not.toHaveBeenCalled();
    // Cancelling twice is what an unmount after a clear does, and it is a no-op.
    expect(() => {
      debouncer.cancel();
    }).not.toThrow();
  });

  // The one test that touches a real timer, so the default schedule is not
  // taken on trust.
  it('uses a real timer when it is not given one', async () => {
    const emitted: string[] = [];
    createQueryDebouncer({
      emit: (query) => emitted.push(query),
      debounceMs: 0,
    }).set('bea');

    expect(emitted).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(emitted).toEqual(['bea']);
  });

  it('refuses a negative delay rather than passing it to a timer', () => {
    const delays: number[] = [];
    const schedule: ScheduleDelay = (_run, delayMs) => {
      delays.push(delayMs);
      return () => undefined;
    };
    createQueryDebouncer({ emit: () => undefined, debounceMs: -100, schedule }).set('b');

    expect(delays).toEqual([0]);
  });
});
