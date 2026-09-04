import { describe, expect, it } from 'vitest';
import { createTestClock, systemClock } from './clock.js';

describe('createTestClock', () => {
  it('starts at the requested readings', () => {
    const clock = createTestClock({ now: 1_000, monotonic: 50 });
    expect(clock.now()).toBe(1_000);
    expect(clock.monotonic()).toBe(50);
  });

  it('advances both readings by exactly the requested amount', () => {
    const clock = createTestClock({ now: 1_000, monotonic: 50 });
    clock.advance(250);
    clock.advance(750);
    expect(clock.now()).toBe(2_000);
    expect(clock.monotonic()).toBe(1_050);
  });

  it('reads the same value until advanced', () => {
    const clock = createTestClock();
    const first = clock.monotonic();
    expect(clock.monotonic()).toBe(first);
    expect(clock.monotonic()).toBe(first);
  });

  // The whole reason the two readings are separate: an NTP correction (or a
  // Pi with no RTC getting the network for the first time) moves wall-clock
  // time by an arbitrary amount, and elapsed-time measurements must not see
  // it. Progress interpolation reads monotonic only, so the bar holds still.
  it('leaves the monotonic reading alone when the wall clock jumps', () => {
    const clock = createTestClock({ now: 1_000, monotonic: 50 });
    const before = clock.monotonic();

    clock.setWallClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.monotonic()).toBe(before);

    // ...and backwards, which is the direction that would rewind a progress bar.
    clock.setWallClock(0);
    expect(clock.monotonic()).toBe(before);
  });

  it('never lets the monotonic reading decrease', () => {
    const clock = createTestClock();
    const steps = [0, 1, 1_000, 0.5, 60_000];
    let previous = clock.monotonic();

    for (const step of steps) {
      clock.advance(step);
      const current = clock.monotonic();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('refuses to run backwards, which a real monotonic clock cannot do', () => {
    const clock = createTestClock();
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
  });

  it('gives independent clocks to independent tests', () => {
    const a = createTestClock({ now: 0, monotonic: 0 });
    const b = createTestClock({ now: 0, monotonic: 0 });
    a.advance(5_000);
    expect(b.now()).toBe(0);
    expect(b.monotonic()).toBe(0);
  });
});

describe('systemClock', () => {
  it('reports wall-clock time as epoch milliseconds', () => {
    const before = Date.now();
    const reading = systemClock.now();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  it('never returns a smaller monotonic reading than the one before it', () => {
    let previous = systemClock.monotonic();
    for (let i = 0; i < 1_000; i += 1) {
      const current = systemClock.monotonic();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  // Elapsed time comes from the monotonic reading, so it must actually be a
  // duration from some origin rather than an epoch timestamp in disguise.
  it('does not report the monotonic reading as an epoch timestamp', () => {
    expect(systemClock.monotonic()).toBeLessThan(Date.now());
  });
});
