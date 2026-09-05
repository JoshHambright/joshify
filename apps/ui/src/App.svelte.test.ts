/**
 * @vitest-environment jsdom
 */
/**
 * The shell's job is arrangement and the honesty rules from SCREENS.md, so
 * that is what these assert: which surface the plate is showing, and that a
 * failure never blanks a screen that has something true on it.
 *
 * The components themselves are tested next door — this file deliberately does
 * not re-assert that the transport has three weights or that a null volume
 * hides a slider. It asserts that the right component gets the right slice of
 * state, which is the only thing this file can get wrong.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import {
  IDLE_PLAYBACK,
  type JoshifyError,
  type PlaybackDevice,
  type PlaybackState,
  type PlayingItem,
} from '@joshify/core';
import App from './App.svelte';
import type { Command, CommandClient, CommandTarget } from './lib/commands.js';
import type { Connection, ConnectionState, LinkStatus } from './lib/connection.js';
import type { DeviceSource, DeviceSourceState } from './lib/device-source.js';

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

const kitchen: PlaybackDevice = {
  id: 'dev-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: true,
  volumePercent: 55,
  supportsVolume: true,
};

const study: PlaybackDevice = {
  ...kitchen,
  id: 'dev-2',
  name: 'Study',
  isActive: false,
};

const playing = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  ...IDLE_PLAYBACK,
  isPlaying: true,
  progressMs: 64_000,
  item: track,
  device: kitchen,
  ...over,
});

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

const fakeDevices = (rows: readonly PlaybackDevice[] = [kitchen, study]) => {
  const value: DeviceSourceState = { devices: rows, problem: null, pending: false };
  const subscribers = new Set<(v: DeviceSourceState) => void>();
  const calls = { opened: 0, closed: 0, refreshed: 0 };
  const source: DeviceSource = {
    subscribe: (run) => {
      subscribers.add(run);
      run(value);
      return () => subscribers.delete(run);
    },
    open: () => {
      calls.opened += 1;
    },
    close: () => {
      calls.closed += 1;
    },
    refresh: () => {
      calls.refreshed += 1;
      return Promise.resolve();
    },
    current: () => value,
  };
  return { source, calls };
};

const fakeClient = () => {
  const sent: { command: Command; target: CommandTarget | undefined }[] = [];
  const client: CommandClient = {
    send: (command, target) => {
      sent.push({ command, target });
      return Promise.resolve<JoshifyError | null>(null);
    },
  };
  return { client, sent };
};

const at = (hour: number, minute: number) => () => new Date(2026, 0, 1, hour, minute);

interface Harness {
  connection?: ReturnType<typeof fakeConnection>;
  devices?: ReturnType<typeof fakeDevices>;
  client?: ReturnType<typeof fakeClient>;
  isPremium?: boolean;
}

const mountApp = (harness: Harness = {}) => {
  const conn = harness.connection ?? fakeConnection({ state: playing() });
  const devs = harness.devices ?? fakeDevices();
  const cmd = harness.client ?? fakeClient();
  const rendered = render(App, {
    connection: conn.connection,
    client: cmd.client,
    devices: devs.source,
    now: at(21, 47),
    ...(harness.isPremium === undefined ? {} : { isPremium: harness.isPremium }),
  });
  return { ...rendered, conn, devs, cmd };
};

afterEach(cleanup);

describe('the panel at rest', () => {
  it('opens the connection on mount and closes it on unmount', () => {
    const { conn, unmount } = mountApp();

    expect(conn.counts().opened).toBe(1);
    unmount();
    expect(conn.counts().closed).toBe(1);
  });

  it('shows the track, the artist, the speaker and the clock', () => {
    mountApp();

    expect(screen.getByText('Velocity Division')).toBeDefined();
    expect(screen.getByText('Nitrous Cartel')).toBeDefined();
    expect(screen.getByText('21:47')).toBeDefined();
  });

  it('renders the album with an empty alt, since it is not content', () => {
    const { container } = mountApp();

    const art = container.querySelector('img[src="https://i/640"]');
    expect(art?.getAttribute('alt')).toBe('');
  });

  it('calls an episode a podcast rather than an album', () => {
    mountApp({
      connection: fakeConnection({
        state: playing({ item: { ...track, kind: 'episode', subtitle: 'A Show' } }),
      }),
    });

    expect(screen.getByText(/Playing from podcast/)).toBeDefined();
  });

  it('renders no artwork element at all for a track that has none', () => {
    const { container } = mountApp({
      connection: fakeConnection({
        state: playing({ item: { ...track, isLocal: true, id: null, images: [] } }),
      }),
    });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Velocity Division')).toBeDefined();
  });
});

describe('the notices', () => {
  // A device but no track. "No device" deliberately outranks this — it is the
  // one with an action attached — so the idle notice needs a speaker present.
  it('says nothing is playing rather than showing an empty plate', () => {
    mountApp({
      connection: fakeConnection({ state: { ...IDLE_PLAYBACK, device: kitchen } }),
    });

    expect(screen.getByText('Nothing playing')).toBeDefined();
  });

  it('offers a device rather than reporting an error when there is none', () => {
    mountApp({ connection: fakeConnection({ state: IDLE_PLAYBACK }) });

    expect(screen.getByRole('button', { name: /choose a device/i })).toBeDefined();
  });

  // Unknown is treated as Premium: accusing an account before we know is
  // exactly the confident lie D-022 is about.
  it('does not accuse an account of being free before it knows', () => {
    const { container } = mountApp();

    expect(container.textContent).not.toMatch(/premium/i);
  });

  it('explains a free account plainly and switches the controls off', () => {
    const { container } = mountApp({ isPremium: false });

    expect(screen.getByText('Premium required')).toBeDefined();
    expect(container.textContent).not.toMatch(/error|failed/i);
  });
});

describe('the plate, grown', () => {
  it('opens the device list from the notice action and polls only while it is open', async () => {
    const { devs } = mountApp({ connection: fakeConnection({ state: IDLE_PLAYBACK }) });
    expect(devs.calls.opened).toBe(0);

    screen.getByRole('button', { name: /choose a device/i }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Study')).toBeDefined();
    });

    expect(devs.calls.opened).toBe(1);
  });

  it('closes the list again, and stops polling, on Done', async () => {
    const { devs } = mountApp();

    screen.getByRole('button', { name: 'Kitchen' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Done' })).toBeDefined();
    });

    screen.getByRole('button', { name: 'Done' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Velocity Division')).toBeDefined();
    });
    expect(devs.calls.closed).toBeGreaterThanOrEqual(1);
  });

  // The lamp should move with the tap, not five seconds later.
  it('transfers, refreshes the list, and falls back to the plate at rest', async () => {
    const { cmd, devs } = mountApp();

    screen.getByRole('button', { name: 'Kitchen' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Study')).toBeDefined();
    });

    screen.getByRole('button', { name: /study/i }).click();
    await vi.waitFor(() => {
      expect(cmd.sent).toHaveLength(1);
    });

    expect(cmd.sent[0]?.command).toEqual({ kind: 'transfer', deviceId: 'dev-2' });
    expect(devs.calls.refreshed).toBe(1);
    await vi.waitFor(() => {
      expect(screen.getByText('Velocity Division')).toBeDefined();
    });
  });

  it('closes the device source on unmount even while it is open', async () => {
    const { devs, unmount } = mountApp();

    screen.getByRole('button', { name: 'Kitchen' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Done' })).toBeDefined();
    });

    unmount();
    expect(devs.calls.closed).toBeGreaterThanOrEqual(1);
  });
});

describe('the link lamp', () => {
  it.each<[LinkStatus, string]>([
    ['live', 'live'],
    ['connecting', 'connecting'],
    ['reconnecting', 'reconnecting'],
  ])('reflects the %s link', (link, expected) => {
    const { container } = mountApp({
      connection: fakeConnection({ link, state: playing() }),
    });

    expect(container.querySelector('[data-link]')?.getAttribute('data-link')).toBe(
      expected,
    );
  });

  // The single most important rule on the panel: a dropped socket changes the
  // lamp and nothing else. The album, the title and the artist all stay.
  it('keeps the last known state on screen when the link drops', async () => {
    const conn = fakeConnection({ state: playing() });
    const { container } = mountApp({ connection: conn });

    conn.set({ link: 'reconnecting', attempt: 3 });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-link]')?.getAttribute('data-link')).toBe(
        'reconnecting',
      );
    });

    expect(screen.getByText('Velocity Division')).toBeDefined();
    expect(container.querySelector('img[src="https://i/640"]')).not.toBeNull();
  });

  it('never renders a spinner or a raw error', () => {
    const { container } = mountApp({
      connection: fakeConnection({ link: 'reconnecting', state: playing() }),
    });

    expect(container.textContent).not.toMatch(/error|loading|failed/i);
  });
});
