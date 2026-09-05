/**
 * Driven entirely by hand: every instant is a number this file chooses, so a
 * drag that lasts "four seconds" costs no timers and no frames. That is the
 * reason the drag logic lives here rather than inside the component — the
 * interesting cases are all about *when* things happened.
 */
import { describe, expect, it } from 'vitest';
import { IDLE_PLAYBACK, type PlaybackState, type PlayingItem } from '@joshify/core';
import { createProgressModel, fractionAtX, seekTargetMs } from './progress.js';

const track: PlayingItem = {
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  durationMs: 200_000,
  images: [],
  isLocal: false,
};

const playing = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  ...IDLE_PLAYBACK,
  isPlaying: true,
  progressMs: 60_000,
  item: track,
  ...over,
});

describe('fractionAtX', () => {
  it('is the pointer position along the bar', () => {
    expect(fractionAtX(150, { left: 50, width: 400 })).toBe(0.25);
  });

  // A finger that slides off the end of the bar is still dragging it, and the
  // ends of a track are exactly where people aim.
  it('clamps a pointer dragged past either end', () => {
    expect(fractionAtX(10, { left: 50, width: 400 })).toBe(0);
    expect(fractionAtX(900, { left: 50, width: 400 })).toBe(1);
  });

  // An element that has not been laid out yet reaches the screen for one
  // frame, and NaN here would be sent to Spotify as a seek position.
  it('is 0 rather than NaN for an unlaid-out bar', () => {
    expect(fractionAtX(150, { left: 0, width: 0 })).toBe(0);
  });
});

describe('seekTargetMs', () => {
  it('is whole milliseconds, because that is what the API takes', () => {
    expect(seekTargetMs(1 / 3, 100_000)).toBe(33_333);
  });

  it('clamps to the item rather than trusting the caller', () => {
    expect(seekTargetMs(1.4, 100_000)).toBe(100_000);
    expect(seekTargetMs(-0.2, 100_000)).toBe(0);
    expect(seekTargetMs(0.5, -1)).toBe(0);
  });
});

describe('the bar between polls', () => {
  it('advances with the monotonic clock, with no poll in between', () => {
    const model = createProgressModel(playing(), 1_000);

    expect(model.readAt(3_500).positionMs).toBe(62_500);
    expect(model.readAt(3_500).fraction).toBeCloseTo(0.3125);
    expect(model.readAt(3_500).isScrubbing).toBe(false);
  });

  it('is frozen while paused, however long ago the pause was seen', () => {
    const model = createProgressModel(playing({ isPlaying: false }), 1_000);

    expect(model.readAt(60_000).positionMs).toBe(60_000);
  });

  it('reads zero with nothing playing rather than dividing by no duration', () => {
    const model = createProgressModel(IDLE_PLAYBACK, 1_000);

    expect(model.readAt(9_000)).toMatchObject({
      positionMs: 0,
      durationMs: 0,
      fraction: 0,
    });
  });

  // D-024. Every poll is stale by a round trip, so the common case is a
  // reported position slightly behind the drawn one; snapping to it twitches
  // the bar backwards on every single poll.
  it('does not rewind for a poll that is merely stale', () => {
    const model = createProgressModel(playing(), 1_000);
    model.observe(playing({ progressMs: 62_000 }), 4_000);

    expect(model.readAt(4_000).positionMs).toBe(63_000);
  });

  it('follows a seek made from another device, which is not staleness', () => {
    const model = createProgressModel(playing(), 1_000);
    model.observe(playing({ progressMs: 10_000 }), 4_000);

    expect(model.readAt(4_000).positionMs).toBe(10_000);
  });
});

describe('a finger on the bar', () => {
  it('follows the finger and ignores the clock entirely', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(0.5);
    // Ten seconds of playback pass mid-drag. The thumb must not move.
    expect(model.readAt(11_000).positionMs).toBe(100_000);
    expect(model.readAt(11_000).isScrubbing).toBe(true);

    model.moveScrub(0.75);
    expect(model.readAt(11_000).positionMs).toBe(150_000);
  });

  it('holds the chosen position after release rather than snapping back', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(0.5);
    expect(model.endScrub(11_000)).toBe(100_000);
    expect(model.isScrubbing).toBe(false);
    // The seek is in flight; the bar runs on from where the user put it.
    expect(model.readAt(13_000).positionMs).toBe(102_000);
  });

  it('clamps a drag past either end of the bar', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(-0.4);
    expect(model.readAt(1_000).positionMs).toBe(0);
    model.moveScrub(1.6);
    expect(model.readAt(1_000).positionMs).toBe(200_000);
  });

  it('is inert with nothing playing, since there is no position to choose', () => {
    const model = createProgressModel(IDLE_PLAYBACK, 1_000);

    model.beginScrub(0.5);
    expect(model.isScrubbing).toBe(false);
    expect(model.endScrub(2_000)).toBeNull();
  });

  it('reports no seek for a release that no drag preceded', () => {
    const model = createProgressModel(playing(), 1_000);

    expect(model.endScrub(2_000)).toBeNull();
    // Untouched: the clock still owns the bar.
    expect(model.readAt(3_000).positionMs).toBe(62_000);
  });

  it('ignores a move when no drag is in progress', () => {
    const model = createProgressModel(playing(), 1_000);

    model.moveScrub(0.9);
    expect(model.readAt(3_000).positionMs).toBe(62_000);
  });

  // A cancelled pointer — the window losing focus, a palm on the panel — is
  // an abandoned gesture, not a quiet seek to wherever the finger stopped.
  it('abandons a cancelled drag without seeking', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(0.9);
    model.cancelScrub();
    expect(model.isScrubbing).toBe(false);
    expect(model.readAt(3_000).positionMs).toBe(62_000);
  });

  // The fraction was chosen against the old item's duration. Honouring it
  // would seek a track the user never touched.
  it('drops the drag when the track changes underneath it', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(0.9);
    model.observe(playing({ item: { ...track, id: 'track-2' }, progressMs: 0 }), 3_000);

    expect(model.isScrubbing).toBe(false);
    expect(model.endScrub(3_000)).toBeNull();
    expect(model.readAt(3_000).positionMs).toBe(0);
  });

  it('keeps a drag alive across an ordinary poll of the same track', () => {
    const model = createProgressModel(playing(), 1_000);

    model.beginScrub(0.25);
    model.observe(playing({ progressMs: 63_000 }), 4_000);

    expect(model.isScrubbing).toBe(true);
    expect(model.readAt(4_000).positionMs).toBe(50_000);
  });
});
