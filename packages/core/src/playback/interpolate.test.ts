import { describe, expect, it } from 'vitest';
import { createTestClock } from '../clock.js';
import {
  createProgressTracker,
  DEFAULT_REWIND_TOLERANCE_MS,
  type ProgressTrackerOptions,
} from './interpolate.js';
import { IDLE_PLAYBACK, type PlaybackState, type PlayingItem } from './state.js';

const DURATION_MS = 200_000;
const T0 = 10_000;

const track = (overrides: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Song',
  subtitle: 'Artist',
  durationMs: DURATION_MS,
  images: [],
  isLocal: false,
  ...overrides,
});

const playing = (progressMs: number, item: PlayingItem = track()): PlaybackState => ({
  isPlaying: true,
  item,
  device: null,
  progressMs,
  shuffle: false,
  repeat: 'off',
});

const trackerAt = (
  progressMs: number,
  options: ProgressTrackerOptions = {},
): ReturnType<typeof createProgressTracker> =>
  createProgressTracker(playing(progressMs), T0, options);

describe('createProgressTracker', () => {
  it('advances by the elapsed monotonic time', () => {
    const tracker = trackerAt(30_000);
    expect(tracker.progressAt(T0)).toBe(30_000);
    expect(tracker.progressAt(T0 + 16)).toBe(30_016);
    expect(tracker.progressAt(T0 + 2_500)).toBe(32_500);
  });

  it('exposes the duration and playing flag of the tracked item', () => {
    const tracker = trackerAt(30_000);
    expect(tracker.durationMs).toBe(DURATION_MS);
    expect(tracker.isPlaying).toBe(true);
  });

  it('reports the position as a fraction of the duration', () => {
    expect(trackerAt(50_000).fractionAt(T0)).toBeCloseTo(0.25);
  });

  // D-023: the Pi 5 has no RTC and steps its wall clock by years the first
  // time it reaches a network. Elapsed time read from that clock would throw
  // the bar to the end of the track at that moment.
  it('ignores a wall-clock jump of years', () => {
    const clock = createTestClock();
    const tracker = createProgressTracker(playing(30_000), clock.monotonic());

    clock.setWallClock(clock.now() + 3 * 365 * 24 * 60 * 60 * 1_000);
    clock.advance(1_000);

    expect(tracker.progressAt(clock.monotonic())).toBe(31_000);
  });

  describe('paused playback', () => {
    it('does not advance', () => {
      const tracker = createProgressTracker(
        { ...playing(30_000), isPlaying: false },
        T0,
      );
      expect(tracker.progressAt(T0 + 60_000)).toBe(30_000);
      expect(tracker.isPlaying).toBe(false);
    });

    it('resumes from where it was paused, not from where the clock got to', () => {
      const tracker = trackerAt(30_000);
      tracker.observe({ ...playing(31_000), isPlaying: false }, T0 + 1_000);
      // An hour on the pause screen must not have advanced anything.
      tracker.observe(playing(31_000), T0 + 3_600_000);
      expect(tracker.progressAt(T0 + 3_601_000)).toBe(32_000);
    });
  });

  describe('nothing playing', () => {
    it('yields zero rather than throwing', () => {
      const tracker = createProgressTracker(IDLE_PLAYBACK, T0);
      expect(tracker.progressAt(T0 + 10_000)).toBe(0);
      expect(tracker.fractionAt(T0 + 10_000)).toBe(0);
      expect(tracker.durationMs).toBe(0);
    });

    it('drops to zero when playback stops mid-track', () => {
      const tracker = trackerAt(30_000);
      tracker.observe(IDLE_PLAYBACK, T0 + 1_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(0);
      expect(tracker.fractionAt(T0 + 2_000)).toBe(0);
    });
  });

  // A track that ends between polls would otherwise keep counting; the bar
  // would run off the end and the remaining time would read negative.
  it('never exceeds the duration', () => {
    const tracker = trackerAt(DURATION_MS - 1_000);
    expect(tracker.progressAt(T0 + 1_000)).toBe(DURATION_MS);
    expect(tracker.progressAt(T0 + 60_000)).toBe(DURATION_MS);
    expect(tracker.fractionAt(T0 + 60_000)).toBe(1);
  });

  it('clamps a reported position that is already past the duration', () => {
    const tracker = createProgressTracker(playing(DURATION_MS + 5_000), T0);
    expect(tracker.progressAt(T0)).toBe(DURATION_MS);
  });

  // Frame callbacks can be handed a reading taken slightly earlier than the
  // one the last poll was anchored to. Reporting less than the anchor would
  // rewind the bar for a frame.
  it('never reports less than the anchor for an earlier reading', () => {
    const tracker = trackerAt(30_000);
    expect(tracker.progressAt(T0 - 500)).toBe(30_000);
  });

  describe('observe', () => {
    // The normal case, and the reason this is not a plain assignment: a poll
    // is sampled on the device and then spends a round trip in flight, so it
    // reports a position a few hundred ms behind the one being drawn. Snapping
    // to it twitches the bar backwards on every single poll.
    it('holds position when the poll lands slightly behind', () => {
      const tracker = trackerAt(30_000);
      const before = tracker.progressAt(T0 + 2_000); // 32_000

      tracker.observe(playing(31_700), T0 + 2_000);

      expect(tracker.progressAt(T0 + 2_000)).toBe(before);
      expect(tracker.progressAt(T0 + 3_000)).toBe(33_000);
    });

    it('follows a real seek backwards past the tolerance', () => {
      const tracker = trackerAt(120_000);
      tracker.observe(playing(10_000), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(10_000);
    });

    it('respects a custom rewind tolerance', () => {
      const tracker = trackerAt(30_000, { rewindToleranceMs: 100 });
      // 300ms behind: held by the default tolerance, followed by this one.
      tracker.observe(playing(31_700), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(31_700);
      expect(DEFAULT_REWIND_TOLERANCE_MS).toBeGreaterThan(300);
    });

    it('adopts a position ahead of the interpolated one immediately', () => {
      const tracker = trackerAt(30_000);
      tracker.observe(playing(90_000), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(90_000);
    });

    // Someone hitting next on their phone: the new track starts at 0, which is
    // two minutes behind where we were drawing. Holding that would be a bar
    // stuck near the end of a track that just started.
    it('resets outright for a different item', () => {
      const tracker = trackerAt(120_000);
      tracker.observe(playing(0, track({ id: 'track-2' })), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(0);
      expect(tracker.progressAt(T0 + 3_000)).toBe(1_000);
    });

    it('tracks the duration of the new item', () => {
      const tracker = trackerAt(120_000);
      tracker.observe(playing(0, track({ id: 'track-2', durationMs: 5_000 })), T0);
      expect(tracker.durationMs).toBe(5_000);
      expect(tracker.progressAt(T0 + 9_000)).toBe(5_000);
    });

    // Repeat-one: the same item restarts, so identity alone cannot decide it.
    it('follows the same item restarting from the top', () => {
      const tracker = trackerAt(DURATION_MS - 1_000);
      tracker.observe(playing(200), T0 + 1_000);
      expect(tracker.progressAt(T0 + 1_000)).toBe(200);
    });

    it('identifies an item by uri when it has no id', () => {
      const noId = track({ id: null });
      const tracker = createProgressTracker(playing(30_000, noId), T0);
      tracker.observe(playing(31_700, noId), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(32_000);
    });

    // Local files carry neither id nor uri, so a naive identity check treats
    // every poll as a new track and resets the bar to the reported position.
    it('identifies a local file by title and duration', () => {
      const local = track({ id: null, uri: null, isLocal: true });
      const tracker = createProgressTracker(playing(30_000, local), T0);
      tracker.observe(playing(31_700, local), T0 + 2_000);
      expect(tracker.progressAt(T0 + 2_000)).toBe(32_000);
    });
  });

  // The property that matters more than any individual case: whatever the
  // polls say, the number handed to the renderer never decreases unless the
  // truth genuinely moved backwards.
  it('never runs backwards across a run of frames and lagging polls', () => {
    const clock = createTestClock();
    const tracker = createProgressTracker(playing(30_000), clock.monotonic());
    let previous = tracker.progressAt(clock.monotonic());
    let reported = 30_000;

    for (let frame = 0; frame < 600; frame += 1) {
      clock.advance(16);
      // A poll every 3s, always a few hundred ms stale, with the lag varying
      // the way a real network does.
      if (frame % 188 === 0) {
        reported = tracker.progressAt(clock.monotonic()) - 200 - (frame % 5) * 90;
        tracker.observe(playing(reported), clock.monotonic());
      }
      const current = tracker.progressAt(clock.monotonic());
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(DURATION_MS);
      previous = current;
    }
  });
});
