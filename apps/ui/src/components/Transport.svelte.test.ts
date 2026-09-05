/**
 * @vitest-environment jsdom
 */
/**
 * What is asserted here is what each key *sends*, because that is the only
 * thing about a transport that can be wrong in a way nobody notices until the
 * speaker does something else. The command client is a fake that records
 * envelopes; no server, no fetch, no waiting.
 *
 * The hierarchy — play a disc, skip a bare glyph, toggles quiet until on
 * (D-040) — is asserted through the variant each key carries, since jsdom has
 * no layout and cannot be asked how big anything is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { IDLE_PLAYBACK, type PlaybackState, type PlayingItem } from '@joshify/core';
import Transport from './Transport.svelte';
import type { Command, CommandClient, CommandTarget } from '../lib/commands.js';

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

const episode: PlayingItem = {
  ...track,
  kind: 'episode',
  id: 'ep-1',
  title: 'Episode 12',
  subtitle: 'A Show',
  durationMs: 3_600_000,
};

const playing = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  ...IDLE_PLAYBACK,
  isPlaying: true,
  progressMs: 60_000,
  item: track,
  ...over,
});

/** Records what was sent instead of sending it. */
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

/** A monotonic clock the test steps by hand (D-023). */
const handClock = (start = 1_000) => {
  let value = start;
  return {
    monotonic: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

afterEach(cleanup);

describe('the transport', () => {
  it('is unequal by construction: a play disc, bare skips, quiet toggles', () => {
    const fake = fakeClient();
    render(Transport, { playback: playing(), client: fake.client });

    const variant = (label: string): string | null =>
      screen.getByLabelText(label).getAttribute('data-variant');

    expect(variant('Pause')).toBe('play');
    expect(variant('Previous track')).toBe('skip');
    expect(variant('Next track')).toBe('skip');
    expect(variant('Shuffle')).toBe('toggle');
    expect(variant('Repeat')).toBe('toggle');
  });

  it('pauses what is playing and plays what is paused', async () => {
    const fake = fakeClient();
    const { rerender } = render(Transport, { playback: playing(), client: fake.client });

    await fireEvent.click(screen.getByLabelText('Pause'));
    await rerender({ playback: playing({ isPlaying: false }), client: fake.client });
    await fireEvent.click(screen.getByLabelText('Play'));

    expect(fake.commands()).toEqual([{ kind: 'pause' }, { kind: 'play' }]);
  });

  it('skips by item for a track', async () => {
    const fake = fakeClient();
    render(Transport, { playback: playing(), client: fake.client });

    await fireEvent.click(screen.getByLabelText('Previous track'));
    await fireEvent.click(screen.getByLabelText('Next track'));

    expect(fake.commands()).toEqual([{ kind: 'previous' }, { kind: 'next' }]);
  });

  it('aims every command at the device it was given', async () => {
    const fake = fakeClient();
    render(Transport, {
      playback: playing(),
      client: fake.client,
      commandTarget: { deviceId: 'dev-1' },
    });

    await fireEvent.click(screen.getByLabelText('Next track'));

    expect(fake.sent[0]?.target).toEqual({ deviceId: 'dev-1' });
  });
});

describe('a podcast', () => {
  // SCREENS.md: skip becomes ±15s. And ±15s from where the bar *is* — the
  // polled position is up to three seconds stale (D-025), which would make
  // "back fifteen" land twelve seconds back.
  it('steps 15 seconds from the interpolated position, not the polled one', async () => {
    const fake = fakeClient();
    const clock = handClock();
    render(Transport, {
      playback: playing({ item: episode, progressMs: 60_000 }),
      client: fake.client,
      monotonic: clock.monotonic,
    });

    clock.advance(2_800);
    await fireEvent.click(screen.getByLabelText('Forward 15 seconds'));

    expect(fake.commands()).toEqual([{ kind: 'seek', positionMs: 77_800 }]);
  });

  it('clamps a step back at the start rather than seeking negative', async () => {
    const fake = fakeClient();
    render(Transport, {
      playback: playing({ item: episode, progressMs: 4_000 }),
      client: fake.client,
      monotonic: () => 1_000,
    });

    await fireEvent.click(screen.getByLabelText('Back 15 seconds'));

    expect(fake.commands()).toEqual([{ kind: 'seek', positionMs: 0 }]);
  });

  it('clamps a step forward at the end of the episode', async () => {
    const fake = fakeClient();
    render(Transport, {
      playback: playing({ item: episode, progressMs: 3_596_000 }),
      client: fake.client,
      monotonic: () => 1_000,
    });

    await fireEvent.click(screen.getByLabelText('Forward 15 seconds'));

    expect(fake.commands()).toEqual([{ kind: 'seek', positionMs: 3_600_000 }]);
  });
});

describe('shuffle and repeat', () => {
  it('sends the inverse of the real shuffle state, never a local guess', async () => {
    const fake = fakeClient();
    const { rerender } = render(Transport, {
      playback: playing({ shuffle: true }),
      client: fake.client,
    });

    await fireEvent.click(screen.getByLabelText('Shuffle'));
    await rerender({ playback: playing({ shuffle: false }), client: fake.client });
    await fireEvent.click(screen.getByLabelText('Shuffle'));

    expect(fake.commands()).toEqual([
      { kind: 'shuffle', enabled: false },
      { kind: 'shuffle', enabled: true },
    ]);
  });

  it('shows shuffle as on only when playback says it is', async () => {
    const fake = fakeClient();
    const { rerender } = render(Transport, {
      playback: playing({ shuffle: false }),
      client: fake.client,
    });

    expect(screen.getByLabelText('Shuffle').getAttribute('aria-pressed')).toBe('false');
    await rerender({ playback: playing({ shuffle: true }), client: fake.client });
    expect(screen.getByLabelText('Shuffle').getAttribute('aria-pressed')).toBe('true');
  });

  // Off → all → one, the order every Spotify client cycles in.
  it('cycles repeat in the order the rest of Spotify does', async () => {
    const fake = fakeClient();
    const { rerender } = render(Transport, {
      playback: playing({ repeat: 'off' }),
      client: fake.client,
    });

    await fireEvent.click(screen.getByLabelText('Repeat'));
    await rerender({ playback: playing({ repeat: 'context' }), client: fake.client });
    await fireEvent.click(screen.getByLabelText('Repeat'));
    await rerender({ playback: playing({ repeat: 'track' }), client: fake.client });
    await fireEvent.click(screen.getByLabelText('Repeat'));

    expect(fake.commands()).toEqual([
      { kind: 'repeat', mode: 'context' },
      { kind: 'repeat', mode: 'track' },
      { kind: 'repeat', mode: 'off' },
    ]);
  });

  it('distinguishes repeat-one from repeat-all, which the label cannot', async () => {
    const fake = fakeClient();
    const { container, rerender } = render(Transport, {
      playback: playing({ repeat: 'context' }),
      client: fake.client,
    });
    const mode = (): string | null =>
      container.querySelector('[data-repeat]')?.getAttribute('data-repeat') ?? null;

    expect(mode()).toBe('context');
    expect(container.querySelector('[data-repeat] text')).toBeNull();

    await rerender({ playback: playing({ repeat: 'track' }), client: fake.client });
    expect(mode()).toBe('track');
    expect(container.querySelector('[data-repeat] text')?.textContent).toBe('1');
  });

  it('is off, not on, when repeat is off', () => {
    const fake = fakeClient();
    render(Transport, { playback: playing({ repeat: 'off' }), client: fake.client });

    expect(screen.getByLabelText('Repeat').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('states with nothing to control', () => {
  // SCREENS.md: nothing playing shows play only. A next button with no queue
  // behind it is an affordance that cannot work.
  it('shows play alone when nothing is playing', () => {
    const fake = fakeClient();
    render(Transport, { playback: IDLE_PLAYBACK, client: fake.client });

    expect(screen.getByLabelText('Play')).toBeDefined();
    expect(screen.queryByLabelText('Next track')).toBeNull();
    expect(screen.queryByLabelText('Shuffle')).toBeNull();
  });

  it('draws the same row before the first snapshot arrives', () => {
    const fake = fakeClient();
    render(Transport, { playback: null, client: fake.client });

    expect(screen.getByLabelText('Play')).toBeDefined();
  });

  // Every /me/player write needs Premium, so a control that looks live would
  // be lying about what the next tap does.
  it('disables every control without Premium, and sends nothing if tapped', async () => {
    const fake = fakeClient();
    render(Transport, { playback: playing(), client: fake.client, disabled: true });

    for (const label of ['Pause', 'Previous track', 'Next track', 'Shuffle', 'Repeat']) {
      expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(true);
    }
    await fireEvent.click(screen.getByLabelText('Pause'));
    expect(fake.commands()).toEqual([]);
  });
});
