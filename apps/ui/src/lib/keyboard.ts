/**
 * Typing, on a device with nothing to type on.
 *
 * The panel is 720px wide, has no physical keyboard and no cursor, so every
 * question a desktop text field answers by default has to be answered here:
 * how wide a key is, what shift means when there is no keyboard to hold down,
 * what backspace does at the start of the line, and when a keystroke becomes a
 * request.
 *
 * **The layout arithmetic is the constraint, not a detail.** Ten keys have to
 * fit across 720px and every one of them has to be a touch target. With 14px of
 * padding either side and an 8px gap between keys, a single-span key is
 * `(720 - 2*14 - 9*8) / 10 = 62px` — comfortably over the 48px minimum in
 * SCREENS.md, and the reason the layout tops out at ten columns. Wide keys are
 * expressed in *spans* of that unit, so a key of span `s` is
 * `s * 62 + (s - 1) * 8 = s * 70 - 8` px. That gives one invariant worth
 * knowing: **a row whose spans sum to 10 fills the panel exactly**, whatever
 * mix of key widths it uses.
 *
 * All of this is here rather than in the component because it is pure — the
 * whole state machine is `(state, key) => state` — and because a keyboard that
 * strands the user in caps or eats the wrong character is exactly the kind of
 * bug a DOM test finds slowly and a table test finds instantly.
 */

/** Half a key would be under 48px, so spans below 1 do not exist. */
export const KEY_SPAN_PER_ROW = 10;

/**
 * The longest query the readout can show at 23px mono (~14px per character
 * across 664px of usable width). A query the user cannot read back is a query
 * they cannot correct, and Spotify's relevance falls off long before this.
 */
export const MAX_QUERY_LENGTH = 48;

export type KeyKind = 'char' | 'shift' | 'backspace' | 'space' | 'layer' | 'clear';

/** The two boards. Letters is where typing starts; symbols holds the digits. */
export type KeyboardLayer = 'letters' | 'symbols';

/**
 * Shift has three states rather than two because a touch keyboard has no key
 * to hold down. `once` is what a single tap gives — the next letter is capital
 * and then it is over, which is what a name needs; `lock` is the deliberate
 * second tap, for the rare all-caps query. Without `once` the user has to tap
 * shift twice for every capital; without `lock` they cannot type one at all.
 */
export type ShiftState = 'off' | 'once' | 'lock';

export interface KeyCap {
  readonly kind: KeyKind;
  /** What the cap shows. */
  readonly label: string;
  /** Inserted when the key is pressed. Only ever set on a `char`. */
  readonly value?: string | undefined;
  /** Width in key units. `1.5` and `2` are the only wide keys used. */
  readonly span: number;
  /** Announced to assistive tech where the label is a glyph. */
  readonly name: string;
}

export interface KeyboardState {
  readonly text: string;
  readonly shift: ShiftState;
  readonly layer: KeyboardLayer;
}

export const INITIAL_KEYBOARD: KeyboardState = {
  text: '',
  shift: 'off',
  layer: 'letters',
};

const LETTER_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const;

/*
 * Digits first, then the punctuation a music query actually contains: an
 * ampersand, an apostrophe, a slash. There is no third page — anything not on
 * these two boards is not in a track title often enough to be worth a key.
 */
const SYMBOL_ROWS = ['1234567890', '-/:;()$&@~', ".,?!'*#+"] as const;

const charKey = (value: string): KeyCap => ({
  kind: 'char',
  label: value,
  value,
  span: 1,
  name: value,
});

const SHIFT_KEY: KeyCap = { kind: 'shift', label: '⇧', span: 1.5, name: 'Shift' };
const BACKSPACE_KEY: KeyCap = {
  kind: 'backspace',
  label: '⌫',
  span: 1.5,
  name: 'Backspace',
};
const SPACE_KEY: KeyCap = { kind: 'space', label: 'space', span: 7, name: 'Space' };
const CLEAR_KEY: KeyCap = { kind: 'clear', label: 'clear', span: 2, name: 'Clear' };

const layerKey = (layer: KeyboardLayer): KeyCap => ({
  kind: 'layer',
  // The cap names where it goes, not where it is — the universal convention on
  // a phone keyboard, and the one users already read without thinking.
  label: layer === 'letters' ? '123' : 'ABC',
  span: 1,
  name: layer === 'letters' ? 'Numbers and symbols' : 'Letters',
});

const capsOf = (row: string, upper: boolean): readonly KeyCap[] =>
  [...row].map((char) => charKey(upper ? char.toUpperCase() : char));

/**
 * The board as it should be drawn right now.
 *
 * Shift is applied *here*, to the caps themselves, rather than in `pressKey`.
 * The cap the user tapped then carries the exact character it showed, so the
 * screen and the query can never disagree about what a key does.
 */
export const layoutFor = (state: KeyboardState): readonly (readonly KeyCap[])[] => {
  // Shift never reaches the symbol board: there is nothing there with a case,
  // and `pressKey` puts it down on the way over.
  const upper = state.layer === 'letters' && state.shift !== 'off';
  const rows = state.layer === 'letters' ? LETTER_ROWS : SYMBOL_ROWS;
  const [first, second, third] = rows;

  const lastRow: readonly KeyCap[] =
    state.layer === 'letters'
      ? [SHIFT_KEY, ...capsOf(third, upper), BACKSPACE_KEY]
      : [...capsOf(third, false), BACKSPACE_KEY];

  return [
    capsOf(first, upper),
    capsOf(second, upper),
    lastRow,
    [layerKey(state.layer), SPACE_KEY, CLEAR_KEY],
  ];
};

/** `off → once → lock → off`. Three taps returns you to where you started. */
const nextShift = (shift: ShiftState): ShiftState =>
  shift === 'off' ? 'once' : shift === 'once' ? 'lock' : 'off';

/**
 * Drop the last character, not the last code unit.
 *
 * A UTF-16 slice would cut an emoji or a surrogate-paired glyph in half and
 * leave a lone surrogate in the query string — which is not a character the
 * user can see, delete, or search for.
 */
const dropLast = (text: string): string => [...text].slice(0, -1).join('');

export const pressKey = (state: KeyboardState, key: KeyCap): KeyboardState => {
  switch (key.kind) {
    case 'char': {
      const value = key.value ?? '';
      if ([...state.text].length >= MAX_QUERY_LENGTH) return state;
      return {
        ...state,
        text: state.text + value,
        // One-shot shift ends with the letter it capitalised; a lock does not.
        shift: state.shift === 'once' ? 'off' : state.shift,
      };
    }

    case 'shift':
      return { ...state, shift: nextShift(state.shift) };

    case 'backspace':
      // Deliberately not an error, a beep, or a no-op that still clears shift:
      // backspace on an empty field is something a finger does by accident on
      // the way to another key, and it should change nothing at all.
      return state.text === '' ? state : { ...state, text: dropLast(state.text) };

    case 'space':
      // A leading or doubled space costs a request and finds nothing: Spotify
      // trims and tokenises the query, so both are keystrokes that cannot
      // change the answer. Swallowing them keeps the readout honest about what
      // is actually being searched for.
      return state.text === '' || state.text.endsWith(' ')
        ? state
        : { ...state, text: `${state.text} ` };

    case 'layer':
      return {
        ...state,
        layer: state.layer === 'letters' ? 'symbols' : 'letters',
        // Shift means nothing on the symbol board and would be a surprise on
        // the way back, so switching boards puts it down.
        shift: 'off',
      };

    case 'clear':
      // Back to the state the screen opened in, which is also the state that
      // shows the library again.
      return { ...state, text: '', shift: 'off' };
  }
};

/**
 * Run `run` after `delayMs`, returning a function that cancels it.
 *
 * Injected — same shape as the server's search session — so tests never wait
 * and no timer handle type leaks into this module's API.
 */
export type ScheduleDelay = (run: () => void, delayMs: number) => () => void;

const realSchedule: ScheduleDelay = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Matches the server's `DEFAULT_DEBOUNCE_MS`. The panel debounces too, rather
 * than leaving it to the server, because a keystroke that never crosses
 * loopback is cheaper than one that does — and because the readout has to
 * update on every key regardless, so the two concerns are already separate.
 */
export const DEFAULT_DEBOUNCE_MS = 250;

export interface QueryDebouncerOptions {
  readonly emit: (query: string) => void;
  readonly debounceMs?: number | undefined;
  readonly schedule?: ScheduleDelay | undefined;
}

export interface QueryDebouncer {
  /** Call on every keystroke with the whole field, not the character. */
  readonly set: (text: string) => void;
  /** Drop anything pending — the screen closing, or the field being cleared. */
  readonly cancel: () => void;
}

export const createQueryDebouncer = (options: QueryDebouncerOptions): QueryDebouncer => {
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const schedule = options.schedule ?? realSchedule;

  let cancelPending: (() => void) | null = null;

  const cancel = (): void => {
    const stop = cancelPending;
    cancelPending = null;
    stop?.();
  };

  return {
    set: (text) => {
      cancel();
      const query = text.trim();
      // Clearing the field is answered immediately. Waiting a quarter of a
      // second to put the library back is the one delay the user would read as
      // the screen being stuck, because nothing is being typed to explain it.
      if (query === '') {
        options.emit('');
        return;
      }
      cancelPending = schedule(() => {
        cancelPending = null;
        options.emit(query);
      }, debounceMs);
    },
    cancel,
  };
};
