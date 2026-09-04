import { describe, expect, it } from 'vitest';
import { DEFAULT_POLL_SCHEDULE, nextPollDelayMs } from './poll-schedule.js';
import {
  IDLE_PLAYBACK,
  type PlaybackDevice,
  type PlaybackState,
  type PlayingItem,
} from './state.js';

const DURATION_MS = 200_000;

const track = (durationMs = DURATION_MS): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Song',
  subtitle: 'Artist',
  durationMs,
  images: [],
  isLocal: false,
});

const device = (overrides: Partial<PlaybackDevice> = {}): PlaybackDevice => ({
  id: 'device-1',
  name: 'Joshify',
  type: 'Speaker',
  isActive: true,
  volumePercent: 50,
  supportsVolume: true,
  ...overrides,
});

const playing = (progressMs: number, durationMs = DURATION_MS): PlaybackState => ({
  isPlaying: true,
  item: track(durationMs),
  device: device(),
  progressMs,
  shuffle: false,
  repeat: 'off',
});

describe('nextPollDelayMs', () => {
  it('polls slowly when nothing is playing anywhere', () => {
    expect(nextPollDelayMs(IDLE_PLAYBACK)).toBe(DEFAULT_POLL_SCHEDULE.idleMs);
  });

  it('polls slowly while paused', () => {
    expect(nextPollDelayMs({ ...playing(30_000), isPlaying: false })).toBe(
      DEFAULT_POLL_SCHEDULE.idleMs,
    );
  });

  // A payload can claim `is_playing` while the device it names has gone
  // inactive — mid-transfer, or a Connect client that died without telling
  // Spotify. Nothing is advancing, so there is nothing to keep up with.
  it('polls slowly when the reported device is not active', () => {
    expect(
      nextPollDelayMs({ ...playing(30_000), device: device({ isActive: false }) }),
    ).toBe(DEFAULT_POLL_SCHEDULE.idleMs);
  });

  it('polls slowly when the payload names no device at all', () => {
    expect(nextPollDelayMs({ ...playing(30_000), device: null })).toBe(
      DEFAULT_POLL_SCHEDULE.idleMs,
    );
  });

  it('polls at the moderate cadence mid-track', () => {
    expect(nextPollDelayMs(playing(30_000))).toBe(DEFAULT_POLL_SCHEDULE.playingMs);
  });

  it('tightens inside the boundary window', () => {
    const remaining = DEFAULT_POLL_SCHEDULE.boundaryWindowMs - 1_000;
    expect(nextPollDelayMs(playing(DURATION_MS - remaining))).toBe(
      DEFAULT_POLL_SCHEDULE.boundaryMs,
    );
  });

  // The track boundary is the one moment the state changes without anyone
  // touching anything, so a poll scheduled past it shows stale cover art for
  // however long it overshot by.
  it('never schedules a poll past the end of the track', () => {
    expect(nextPollDelayMs(playing(DURATION_MS - 600))).toBe(600);
  });

  // Progress routinely runs past the duration between polls: the position is
  // interpolated locally while the boundary is only confirmed by the network.
  it('polls immediately when the position is already past the duration', () => {
    expect(nextPollDelayMs(playing(DURATION_MS + 4_000))).toBe(
      DEFAULT_POLL_SCHEDULE.floorMs,
    );
  });

  it('polls immediately at exactly the boundary', () => {
    expect(nextPollDelayMs(playing(DURATION_MS))).toBe(DEFAULT_POLL_SCHEDULE.floorMs);
  });

  it('reconciles fast right after a command, even while paused', () => {
    expect(nextPollDelayMs({ ...IDLE_PLAYBACK }, { msSinceCommand: 0 })).toBe(
      DEFAULT_POLL_SCHEDULE.afterCommandMs,
    );
  });

  it('keeps the fast cadence for the whole command window', () => {
    const late = DEFAULT_POLL_SCHEDULE.commandWindowMs - 1;
    expect(nextPollDelayMs(playing(30_000), { msSinceCommand: late })).toBe(
      DEFAULT_POLL_SCHEDULE.afterCommandMs,
    );
  });

  it('returns to the normal cadence once the command window has passed', () => {
    expect(
      nextPollDelayMs(playing(30_000), {
        msSinceCommand: DEFAULT_POLL_SCHEDULE.commandWindowMs,
      }),
    ).toBe(DEFAULT_POLL_SCHEDULE.playingMs);
  });

  it('accepts overridden tuning', () => {
    const options = {
      floorMs: 100,
      afterCommandMs: 150,
      commandWindowMs: 5_000,
      idleMs: 30_000,
      playingMs: 8_000,
      boundaryWindowMs: 20_000,
      boundaryMs: 2_000,
    };
    expect(nextPollDelayMs(IDLE_PLAYBACK, {}, options)).toBe(30_000);
    expect(nextPollDelayMs(playing(30_000), {}, options)).toBe(8_000);
    expect(nextPollDelayMs(playing(DURATION_MS - 15_000), {}, options)).toBe(2_000);
    expect(nextPollDelayMs(playing(30_000), { msSinceCommand: 4_000 }, options)).toBe(
      150,
    );
  });

  // The floor is the backstop against a bug elsewhere becoming a request
  // flood: a zeroed interval, a duration parsed as 0, an options object built
  // from empty environment variables. None of them may produce a busy loop.
  describe('the hard floor', () => {
    it('overrides a zeroed cadence', () => {
      expect(nextPollDelayMs(playing(30_000), {}, { playingMs: 0 })).toBe(
        DEFAULT_POLL_SCHEDULE.floorMs,
      );
      expect(nextPollDelayMs(IDLE_PLAYBACK, {}, { idleMs: 0 })).toBe(
        DEFAULT_POLL_SCHEDULE.floorMs,
      );
      expect(
        nextPollDelayMs(playing(30_000), { msSinceCommand: 0 }, { afterCommandMs: 0 }),
      ).toBe(DEFAULT_POLL_SCHEDULE.floorMs);
    });

    it('wins over a boundary that is closer than the floor', () => {
      expect(nextPollDelayMs(playing(DURATION_MS - 10))).toBe(
        DEFAULT_POLL_SCHEDULE.floorMs,
      );
    });

    it('holds across every position in a track', () => {
      for (let progressMs = 0; progressMs <= DURATION_MS + 5_000; progressMs += 137) {
        const delay = nextPollDelayMs(playing(progressMs));
        const remaining = DURATION_MS - progressMs;
        expect(delay).toBeGreaterThanOrEqual(DEFAULT_POLL_SCHEDULE.floorMs);
        expect(delay).toBeLessThanOrEqual(
          Math.max(DEFAULT_POLL_SCHEDULE.floorMs, remaining),
        );
      }
    });
  });
});
