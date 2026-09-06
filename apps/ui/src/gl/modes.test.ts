import { describe, expect, it } from 'vitest';
import { createModeMachine, DEFAULT_IDLE_MS, MODE_INTENSITY } from './modes.js';

const AWAKE = 10_000;

/** A machine that has just been touched, so idling is measured from a known point. */
const machine = (config: Parameters<typeof createModeMachine>[0] = {}) => {
  const m = createModeMachine(config);
  m.touched(AWAKE);
  return m;
};

describe('the resting state', () => {
  it('starts on Now Playing with the chrome visible', () => {
    const state = createModeMachine().state();

    expect(state.mode).toBe('now-playing');
    expect(state.chromeVisible).toBe(true);
  });

  // Ambient keeps the controls; that is the whole difference between it and
  // full. Getting this backwards makes one of the two modes pointless.
  it('keeps the chrome in Ambient and hides it only in Full', () => {
    const m = machine();

    m.setMode('ambient', AWAKE);
    expect(m.state().chromeVisible).toBe(true);

    m.setMode('full', AWAKE);
    expect(m.state().chromeVisible).toBe(false);
  });

  // Not zero: "renders quietly" is a different and more useful state than
  // "nothing renders".
  it('asks for more effect the further from Now Playing it gets', () => {
    expect(MODE_INTENSITY['now-playing']).toBeGreaterThan(0);
    expect(MODE_INTENSITY.ambient).toBeGreaterThan(MODE_INTENSITY['now-playing']);
    expect(MODE_INTENSITY.full).toBe(1);
  });
});

describe('drifting into the visualiser', () => {
  it('waits out the idle time and then takes the screen', () => {
    const m = machine();

    m.tick(AWAKE + DEFAULT_IDLE_MS - 1);
    expect(m.state().mode).toBe('now-playing');

    m.tick(AWAKE + DEFAULT_IDLE_MS);
    expect(m.state().mode).toBe('full');
  });

  it('starts the clock again on every touch', () => {
    const m = machine({ idleMs: 1_000 });

    for (let at = AWAKE; at < AWAKE + 10_000; at += 900) {
      m.tick(at);
      m.touched(at);
    }

    expect(m.state().mode).toBe('now-playing');
  });

  // Cheap enough to call from a frame loop, so it must be safe to call
  // constantly.
  it('is idempotent once it has entered', () => {
    const m = machine({ idleMs: 1_000 });
    m.tick(AWAKE + 2_000);
    m.tick(AWAKE + 3_000);
    m.tick(AWAKE + 900_000);

    expect(m.state().mode).toBe('full');
  });

  it('does not drift when auto-enter is off', () => {
    const m = machine({ autoEnter: false, idleMs: 1_000 });

    m.tick(AWAKE + 60_000);

    expect(m.state().mode).toBe('now-playing');
  });

  it('can be switched off while the timer is already running', () => {
    const m = machine({ idleMs: 1_000 });
    m.setAutoEnter(false);

    m.tick(AWAKE + 60_000);

    expect(m.state().mode).toBe('now-playing');
  });

  it('drifts back to Ambient rather than Now Playing when that is the base', () => {
    const m = machine({ base: 'ambient', idleMs: 1_000 });
    m.tick(AWAKE + 2_000);
    expect(m.state().mode).toBe('full');

    m.touched(AWAKE + 3_000);

    expect(m.state().mode).toBe('ambient');
  });
});

/**
 * The rule that matters most, because getting it wrong is invisible in a test
 * of anything else and infuriating in the hand.
 */
describe('the touch that wakes it', () => {
  it('is swallowed, so nothing underneath is triggered', () => {
    const m = machine({ idleMs: 1_000 });
    m.tick(AWAKE + 2_000);
    expect(m.state().mode).toBe('full');

    // Someone wanted to see what was playing. They did not want to skip a
    // track because the play button happened to be under their finger.
    const first = m.touched(AWAKE + 3_000);

    expect(first.deliver).toBe(false);
    expect(m.state().mode).toBe('now-playing');
  });

  it('delivers every touch after that one', () => {
    const m = machine({ idleMs: 1_000 });
    m.tick(AWAKE + 2_000);
    m.touched(AWAKE + 3_000);

    expect(m.touched(AWAKE + 3_100).deliver).toBe(true);
    expect(m.touched(AWAKE + 3_200).deliver).toBe(true);
  });

  // Someone who opened the visualiser on purpose knows it is there, so the tap
  // that closes it is an ordinary tap.
  it('delivers the touch that leaves a Full mode entered deliberately', () => {
    const m = machine();
    m.setMode('full', AWAKE);

    expect(m.touched(AWAKE + 1_000).deliver).toBe(true);
    expect(m.state().mode).toBe('now-playing');
  });

  it('delivers touches while the chrome is up', () => {
    const m = machine();
    expect(m.touched(AWAKE + 1).deliver).toBe(true);

    m.setMode('ambient', AWAKE);
    expect(m.touched(AWAKE + 2).deliver).toBe(true);
  });
});

describe('changing the resting mode', () => {
  it('takes effect immediately when the chrome is up', () => {
    const m = machine();

    m.setBase('ambient');

    expect(m.state().mode).toBe('ambient');
  });

  // Changing a setting should not yank someone out of the thing they are
  // watching.
  it('waits when the visualiser has the screen', () => {
    const m = machine({ idleMs: 1_000 });
    m.tick(AWAKE + 2_000);

    m.setBase('ambient');

    expect(m.state().mode).toBe('full');
    m.touched(AWAKE + 3_000);
    expect(m.state().mode).toBe('ambient');
  });
});
