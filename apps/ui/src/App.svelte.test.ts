/**
 * @vitest-environment jsdom
 */
/**
 * The shell's job is the honesty rules from SCREENS.md, so that is what these
 * assert: never a raw error, never a spinner where a last-known truth exists,
 * never a blank screen because a packet dropped.
 *
 * The connection is a fake driven by hand — the same one the store's own tests
 * use — so a "the link dropped" test costs no timers and no sockets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { IDLE_PLAYBACK, type PlaybackState, type PlayingItem } from '@joshify/core';
import App from './App.svelte';
import type { Connection, ConnectionState, LinkStatus } from './lib/connection.js';

const track: PlayingItem = {
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  durationMs: 211_000,
  images: [{ url: 'https://i/640', width: 640, height: 640 }],
  isLocal: false,
};

/** A connection whose value the test sets directly. */
const fakeConnection = (initial: Partial<ConnectionState> = {}) => {
  let value: ConnectionState = {
    link: 'live',
    state: null,
    version: null,
    attempt: 0,
    ...initial,
  };
  const subscribers = new Set<(v: ConnectionState) => void>();
  let opened = 0;
  let closed = 0;

  const connection: Connection = {
    subscribe: (run) => {
      subscribers.add(run);
      run(value);
      return () => subscribers.delete(run);
    },
    open: () => {
      opened += 1;
    },
    close: () => {
      closed += 1;
    },
    current: () => value,
  };

  return {
    connection,
    counts: () => ({ opened, closed }),
    set: (next: Partial<ConnectionState>) => {
      value = { ...value, ...next };
      for (const run of subscribers) run(value);
    },
  };
};

const playing = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  ...IDLE_PLAYBACK,
  isPlaying: true,
  progressMs: 64_000,
  item: track,
  device: {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    isActive: true,
    volumePercent: 55,
    supportsVolume: true,
  },
  ...over,
});

const at = (hour: number, minute: number) => () => new Date(2026, 0, 1, hour, minute);

afterEach(cleanup);

describe('the shell', () => {
  it('opens the connection on mount and closes it on unmount', () => {
    const fake = fakeConnection();
    const { unmount } = render(App, { connection: fake.connection, now: at(21, 47) });

    expect(fake.counts().opened).toBe(1);
    unmount();
    expect(fake.counts().closed).toBe(1);
  });

  it('shows the track, the artist and the speaker', () => {
    const fake = fakeConnection({ state: playing() });
    render(App, { connection: fake.connection, now: at(21, 47) });

    expect(screen.getByText('Velocity Division')).toBeDefined();
    expect(screen.getByText('Nitrous Cartel')).toBeDefined();
    expect(screen.getByText('Kitchen')).toBeDefined();
    expect(screen.getByText('21:47')).toBeDefined();
  });

  it('renders the album full bleed with an empty alt, since it is not content', () => {
    const fake = fakeConnection({ state: playing() });
    const { container } = render(App, { connection: fake.connection });

    const art = container.querySelector('img');
    expect(art?.getAttribute('src')).toBe('https://i/640');
    expect(art?.getAttribute('alt')).toBe('');
  });

  // Nothing playing is a state, not a failure, and it gets a sentence.
  it('says nothing is playing rather than showing an empty plate', () => {
    const fake = fakeConnection({ state: IDLE_PLAYBACK });
    render(App, { connection: fake.connection });

    expect(screen.getByText('Nothing playing')).toBeDefined();
  });

  // An offer, not an error: choosing a speaker is the action. The rail states
  // the fact once; the plate says what to do about it, and does not repeat it.
  it('offers a device rather than reporting an error when there is none', () => {
    const fake = fakeConnection({ state: IDLE_PLAYBACK });
    render(App, { connection: fake.connection });

    expect(screen.getByText('Choose a device')).toBeDefined();
    expect(screen.getAllByText('No active device')).toHaveLength(1);
  });

  it('shows no artwork element at all for a local file', () => {
    const fake = fakeConnection({
      state: playing({ item: { ...track, isLocal: true, id: null, images: [] } }),
    });
    const { container } = render(App, { connection: fake.connection });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Velocity Division')).toBeDefined();
  });

  it('calls an episode a podcast rather than an album', () => {
    const fake = fakeConnection({
      state: playing({ item: { ...track, kind: 'episode', subtitle: 'A Show' } }),
    });
    render(App, { connection: fake.connection });

    expect(screen.getByText(/Playing from podcast/)).toBeDefined();
  });
});

describe('the link lamp', () => {
  it.each<[LinkStatus, string]>([
    ['live', 'live'],
    ['connecting', 'connecting'],
    ['reconnecting', 'reconnecting'],
  ])('reflects the %s link', (link, expected) => {
    const fake = fakeConnection({ link, state: playing() });
    const { container } = render(App, { connection: fake.connection });

    expect(container.querySelector('[data-link]')?.getAttribute('data-link')).toBe(
      expected,
    );
  });

  // The single most important rule on the panel: a dropped socket changes the
  // lamp and nothing else. The album, the title and the artist all stay.
  it('keeps the last known state on screen when the link drops', async () => {
    const fake = fakeConnection({ state: playing() });
    const { container } = render(App, { connection: fake.connection });

    fake.set({ link: 'reconnecting', attempt: 3 });
    await Promise.resolve();

    expect(screen.getByText('Velocity Division')).toBeDefined();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://i/640');
    expect(container.querySelector('[data-link]')?.getAttribute('data-link')).toBe(
      'reconnecting',
    );
  });

  it('never renders a spinner or a raw error', () => {
    const fake = fakeConnection({ link: 'reconnecting', state: playing() });
    const { container } = render(App, { connection: fake.connection });

    expect(container.textContent).not.toMatch(/error|loading|failed/i);
  });
});
