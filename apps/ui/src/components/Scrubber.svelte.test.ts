/**
 * @vitest-environment jsdom
 */
/**
 * Both the clock and the frame loop are injected, so "four seconds of playback
 * and thirty frames" is three lines and no waiting. That is the only way to
 * assert the two things that matter here — that the bar moves without asking
 * the network anything, and that it stops moving the instant a finger owns it.
 *
 * jsdom has no layout, so the bar's rect is stubbed. Without it every pointer
 * lands at fraction 0 and every drag test passes for the wrong reason.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { IDLE_PLAYBACK, type PlaybackState, type PlayingItem } from '@joshify/core';
import Scrubber from './Scrubber.svelte';
import type { Command, CommandClient, CommandTarget } from '../lib/commands.js';
import type { FrameLoop } from '../lib/progress.js';

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
  progressMs: 64_000,
  item: track,
  ...over,
});

const fakeClient = () => {
  const sent: { command: Command; target: CommandTarget | undefined }[] = [];
  const client: CommandClient = {
    send: (command, target) => {
      sent.push({ command, target });
      return Promise.resolve(null);
    },
  };
  return { client, sent, commands: () => sent.map((entry) => entry.command) };
};

const handClock = (start = 1_000) => {
  let value = start;
  return {
    monotonic: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

/** A frame loop the test pumps by hand, and can ask whether it is running. */
const handFrames = () => {
  const ticks = new Set<() => void>();
  let started = 0;
  const frames: FrameLoop = (tick) => {
    ticks.add(tick);
    started += 1;
    return () => ticks.delete(tick);
  };
  return {
    frames,
    running: () => ticks.size,
    started: () => started,
    paint: () => {
      for (const run of ticks) run();
    },
  };
};

/** 400px wide, starting 40px in — so clientX 240 is exactly halfway. */
const stubRect = (): HTMLElement => {
  const bar = screen.getByRole('slider');
  bar.getBoundingClientRect = () => ({ left: 40, width: 400 }) as DOMRect;
  return bar;
};

afterEach(cleanup);

describe('the bar between polls', () => {
  it('shows elapsed and remaining, which is what the panel reads', () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: handFrames().frames,
    });

    expect(screen.getByText('1:04')).toBeDefined();
    expect(screen.getByText('-2:16')).toBeDefined();
  });

  // P3-11: smooth at refresh rate with zero extra API calls. Every frame is a
  // local extrapolation; nothing here may ask the network where playback is.
  it('advances frame by frame without sending anything', async () => {
    const fake = fakeClient();
    const clock = handClock();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: clock.monotonic,
      frames: loop.frames,
    });

    clock.advance(3_000);
    loop.paint();
    await tick();

    expect(screen.getByText('1:07')).toBeDefined();
    expect(fake.commands()).toEqual([]);
  });

  // A still bar has nothing to redraw, and this panel runs on a board that has
  // better things to do with a frame.
  it('runs no frame loop while playback is paused', () => {
    const fake = fakeClient();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing({ isPlaying: false }),
      client: fake.client,
      frames: loop.frames,
    });

    expect(loop.running()).toBe(0);
  });

  // D-024, seen from the outside: a poll is always stale by a round trip, so
  // the bar holding its interpolated position is the normal case.
  it('never rewinds for a poll that merely lagged', async () => {
    const fake = fakeClient();
    const clock = handClock();
    const loop = handFrames();
    const { rerender } = render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: clock.monotonic,
      frames: loop.frames,
    });

    clock.advance(3_000);
    loop.paint();
    await tick();
    // The poll reports 66s: true a round trip ago, behind what we are drawing.
    await rerender({
      playback: playing({ progressMs: 66_000 }),
      client: fake.client,
      monotonic: clock.monotonic,
      frames: loop.frames,
    });

    expect(screen.getByText('1:07')).toBeDefined();
  });

  it('blanks the times rather than reading 0:00 when nothing is playing', () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: IDLE_PLAYBACK,
      client: fake.client,
      frames: handFrames().frames,
    });

    expect(screen.getAllByText('--:--')).toHaveLength(2);
  });
});

describe('a finger on the bar', () => {
  it('follows the finger and stops interpolating while it is down', async () => {
    const fake = fakeClient();
    const clock = handClock();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: clock.monotonic,
      frames: loop.frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    expect(screen.getByText('1:40')).toBeDefined();
    expect(loop.running()).toBe(0);

    // Ten seconds of playback pass mid-drag; the thumb must not creep.
    clock.advance(10_000);
    loop.paint();
    await tick();
    expect(screen.getByText('1:40')).toBeDefined();

    await fireEvent.pointerMove(window, { clientX: 340 });
    expect(screen.getByText('2:30')).toBeDefined();
  });

  it('seeks to where the finger let go, and holds that position after', async () => {
    const fake = fakeClient();
    const clock = handClock();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: clock.monotonic,
      frames: loop.frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    await fireEvent.pointerMove(window, { clientX: 140 });
    await fireEvent.pointerUp(window, { clientX: 140 });

    expect(fake.commands()).toEqual([{ kind: 'seek', positionMs: 50_000 }]);
    // The seek is in flight and the bar runs on from the chosen position
    // rather than snapping back to where the track was (D-028).
    clock.advance(2_000);
    loop.paint();
    await tick();
    expect(screen.getByText('0:52')).toBeDefined();
  });

  it('seeks where the bar was tapped, with no drag in between', async () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: handFrames().frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 140 });
    await fireEvent.pointerUp(window, { clientX: 140 });

    expect(fake.commands()).toEqual([{ kind: 'seek', positionMs: 50_000 }]);
  });

  it('aims the seek at the device it was given', async () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      commandTarget: { deviceId: 'dev-1' },
      monotonic: () => 1_000,
      frames: handFrames().frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 140 });
    await fireEvent.pointerUp(window, { clientX: 140 });

    expect(fake.sent[0]?.target).toEqual({ deviceId: 'dev-1' });
  });

  // An abandoned gesture is not a quiet seek to wherever the finger stopped.
  it('sends nothing when the pointer is cancelled mid-drag', async () => {
    const fake = fakeClient();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: loop.frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 340 });
    await fireEvent.pointerCancel(window);
    await tick();

    expect(fake.commands()).toEqual([]);
    expect(screen.getByText('1:04')).toBeDefined();
    // The clock owns the bar again, so the loop is back.
    expect(loop.running()).toBe(1);
  });

  it('resumes interpolating once the finger is off', async () => {
    const fake = fakeClient();
    const loop = handFrames();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: loop.frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    await fireEvent.pointerUp(window, { clientX: 240 });
    await tick();

    expect(loop.running()).toBe(1);
  });

  it('ignores a touch without Premium, since the seek would be refused', async () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: playing(),
      client: fake.client,
      disabled: true,
      frames: handFrames().frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    await fireEvent.pointerUp(window, { clientX: 240 });

    expect(fake.commands()).toEqual([]);
    expect(screen.getByText('1:04')).toBeDefined();
  });

  it('ignores a touch when there is nothing playing to seek', async () => {
    const fake = fakeClient();
    render(Scrubber, {
      playback: IDLE_PLAYBACK,
      client: fake.client,
      frames: handFrames().frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    await fireEvent.pointerUp(window, { clientX: 240 });

    expect(fake.commands()).toEqual([]);
  });

  // The fraction was chosen against the old track's duration. Releasing after
  // the track changed would seek an item the user never touched.
  it('drops a drag the track changed underneath', async () => {
    const fake = fakeClient();
    const loop = handFrames();
    const props = {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: loop.frames,
    };
    const { rerender } = render(Scrubber, props);
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 340 });
    await rerender({
      ...props,
      playback: playing({ item: { ...track, id: 'track-2' }, progressMs: 0 }),
    });
    await fireEvent.pointerUp(window, { clientX: 340 });

    expect(fake.commands()).toEqual([]);
    expect(screen.getByText('0:00')).toBeDefined();
  });

  // A component torn down mid-drag would otherwise leave three window
  // listeners holding a dead model.
  it('lets go of its window listeners when it unmounts mid-drag', async () => {
    const fake = fakeClient();
    const { unmount } = render(Scrubber, {
      playback: playing(),
      client: fake.client,
      monotonic: () => 1_000,
      frames: handFrames().frames,
    });
    const bar = stubRect();

    await fireEvent.pointerDown(bar, { clientX: 240 });
    unmount();
    await fireEvent.pointerUp(window, { clientX: 240 });

    expect(fake.commands()).toEqual([]);
  });
});
