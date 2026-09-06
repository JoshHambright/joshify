/**
 * Where the visualiser sits relative to the panel, and when it moves.
 *
 * Four states from VISUALIZER.md: `now-playing` (art forward, effects subtle
 * or off), `ambient` (light effects behind the plate, controls still visible),
 * `full` (takes the screen), and the transition into `full` after the panel
 * has been left alone.
 *
 * This is a state machine, and it has one job worth getting right: **deciding
 * to go idle is not the same as deciding to come back.** Going idle needs a
 * timer and a quiet room. Coming back needs to be instant and to happen on
 * literally any touch, including the touch that was meant for a control
 * underneath — which is why the first touch out of `full` is swallowed rather
 * than delivered (D-067).
 */

export type VisualiserMode = 'now-playing' | 'ambient' | 'full';

/**
 * Long enough that reading the screen does not dismiss the controls, short
 * enough that a panel left alone becomes the thing it is for. A minute is a
 * long time to stare at a paused player.
 */
export const DEFAULT_IDLE_MS = 45_000;

/** How much of the effect chain each mode asks for, 0..1 into `uIntensity`. */
export const MODE_INTENSITY: Readonly<Record<VisualiserMode, number>> = {
  // Not zero: the drifting backdrop is already there and the effects layer is
  // what will eventually draw it. Zero would mean "nothing renders", which is
  // a different and less useful state than "renders quietly".
  'now-playing': 0.15,
  ambient: 0.45,
  full: 1,
};

export interface ModeState {
  readonly mode: VisualiserMode;
  /** True while the plate and rail should be on screen. */
  readonly chromeVisible: boolean;
  readonly intensity: number;
}

export interface ModeMachineConfig {
  /** Where to sit when the panel is being used. */
  readonly base?: VisualiserMode | undefined;
  readonly idleMs?: number | undefined;
  /** Off entirely — a panel someone is working at should stay put. */
  readonly autoEnter?: boolean | undefined;
}

export interface ModeMachine {
  readonly state: () => ModeState;
  /**
   * A touch happened. Returns whether the caller should let it through to
   * whatever is underneath.
   */
  readonly touched: (atMs: number) => { readonly deliver: boolean };
  /** Call on a frame or a tick. Idempotent, and cheap enough for either. */
  readonly tick: (atMs: number) => void;
  /** Explicit mode change — the `VISUAL` chip, not the idle timer. */
  readonly setMode: (mode: VisualiserMode, atMs: number) => void;
  readonly setBase: (mode: VisualiserMode) => void;
  readonly setAutoEnter: (on: boolean) => void;
}

export const createModeMachine = (config: ModeMachineConfig = {}): ModeMachine => {
  let base: VisualiserMode = config.base ?? 'now-playing';
  let autoEnter = config.autoEnter ?? true;
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;

  let mode: VisualiserMode = base;
  let lastTouchMs = 0;
  /** True only when `full` was entered by the timer rather than by a tap. */
  let enteredByIdle = false;

  const stateNow = (): ModeState => ({
    mode,
    // Chrome is hidden only in `full`. `ambient` explicitly keeps the controls
    // visible — that is the whole difference between the two.
    chromeVisible: mode !== 'full',
    intensity: MODE_INTENSITY[mode],
  });

  return {
    state: stateNow,

    tick: (atMs) => {
      if (!autoEnter || mode === 'full') return;
      // A machine that has never been touched should still drift, so an
      // unset `lastTouchMs` counts from the epoch rather than blocking.
      if (atMs - lastTouchMs < idleMs) return;
      mode = 'full';
      enteredByIdle = true;
    },

    touched: (atMs) => {
      lastTouchMs = atMs;
      if (mode !== 'full') return { deliver: true };

      mode = base;
      // The touch that wakes the panel is swallowed. Delivering it would mean
      // a tap intended to bring the controls back also lands on whichever
      // control happened to be under the finger — skipping a track because
      // someone wanted to see what was playing (D-067).
      const wasIdle = enteredByIdle;
      enteredByIdle = false;
      return { deliver: !wasIdle };
    },

    setMode: (next, atMs) => {
      mode = next;
      lastTouchMs = atMs;
      // Entered deliberately, so leaving it should behave like any other tap.
      enteredByIdle = false;
    },

    setBase: (next) => {
      base = next;
      // Follow the change immediately unless the visualiser has the screen —
      // changing the resting mode should not yank someone out of `full`.
      if (mode !== 'full') mode = next;
    },

    setAutoEnter: (on) => {
      autoEnter = on;
    },
  };
};
