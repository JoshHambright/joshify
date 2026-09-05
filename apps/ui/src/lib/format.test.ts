import { describe, expect, it } from 'vitest';
import { formatRemaining, formatTime, progressFraction } from './format.js';

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [9_000, '0:09'],
    [64_000, '1:04'],
    [211_000, '3:31'],
    [3_600_000, '1:00:00'],
    [7_384_000, '2:03:04'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatTime(ms)).toBe(expected);
  });

  // Absence is a real state (D-022) and gets a placeholder, not a zero — a
  // podcast with no duration must not read as having just started.
  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('renders %s as a blank', (ms) => {
    expect(formatTime(ms)).toBe('--:--');
  });

  // A progress value past the duration is a clock disagreement between the
  // device and Spotify, not a reason to render a negative time.
  it('never goes negative', () => {
    expect(formatTime(-5_000)).toBe('0:00');
  });
});

describe('formatRemaining', () => {
  it('counts down from the duration', () => {
    expect(formatRemaining(64_000, 211_000)).toBe('-2:27');
  });

  it('clamps at zero rather than counting past the end', () => {
    expect(formatRemaining(230_000, 211_000)).toBe('-0:00');
  });

  it('blanks when either half is unknown', () => {
    expect(formatRemaining(null, 211_000)).toBe('--:--');
    expect(formatRemaining(64_000, null)).toBe('--:--');
  });
});

describe('progressFraction', () => {
  it('is the ratio, clamped to 0..1', () => {
    expect(progressFraction(0, 200)).toBe(0);
    expect(progressFraction(50, 200)).toBe(0.25);
    expect(progressFraction(400, 200)).toBe(1);
    expect(progressFraction(-10, 200)).toBe(0);
  });

  // NaN in a CSS width is not an error — it is a silently unstyled bar.
  it('is 0 rather than NaN when there is no duration to divide by', () => {
    expect(progressFraction(50, 0)).toBe(0);
    expect(progressFraction(50, null)).toBe(0);
    expect(progressFraction(null, 200)).toBe(0);
  });
});
