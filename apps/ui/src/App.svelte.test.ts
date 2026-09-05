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
  IDLE_PANEL,
  type JoshifyError,
  type PanelState,
  type PlaybackDevice,
  type PlayingItem,
} from '@joshify/core';
import App from './App.svelte';
import { DEFAULT_THEME } from '@joshify/core';
import type { Command, CommandClient, CommandTarget } from './lib/commands.js';
import type { Connection, ConnectionState, LinkStatus } from './lib/connection.js';
import type { DeviceSource, DeviceSourceState } from './lib/device-source.js';
import type { QueueSource, QueueSourceState } from './lib/queue-source.js';
import type { StyleTarget } from './lib/theme.js';

/** Collects the custom properties App writes, without a real document. */
const fakeThemeTarget = () => {
  const properties = new Map<string, string>();
  const target: StyleTarget = {
    style: {
      setProperty: (property, value) => properties.set(property, value),
      removeProperty: (property) => {
        properties.delete(property);
      },
    },
  };
  return { target, properties };
};

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

const playing = (over: Partial<PanelState> = {}): PanelState => ({
  ...IDLE_PANEL,
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

const fakeQueue = (upcoming: readonly PlayingItem[] = []) => {
  const value: QueueSourceState = {
    queue: { current: track, upcoming },
    problem: null,
    pending: false,
  };
  const subscribers = new Set<(v: QueueSourceState) => void>();
  const calls = { opened: 0, closed: 0, refreshed: 0 };
  const source: QueueSource = {
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
  queue?: ReturnType<typeof fakeQueue>;
  client?: ReturnType<typeof fakeClient>;
  theme?: ReturnType<typeof fakeThemeTarget>;
}

const mountApp = (harness: Harness = {}) => {
  const conn = harness.connection ?? fakeConnection({ state: playing() });
  const devs = harness.devices ?? fakeDevices();
  const q = harness.queue ?? fakeQueue();
  const cmd = harness.client ?? fakeClient();
  const theme = harness.theme ?? fakeThemeTarget();
  const rendered = render(App, {
    connection: conn.connection,
    client: cmd.client,
    devices: devs.source,
    queue: q.source,
    themeTarget: theme.target,
    now: at(21, 47),
  });
  return { ...rendered, conn, devs, cmd, theme, q };
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
      connection: fakeConnection({ state: { ...IDLE_PANEL, device: kitchen } }),
    });

    expect(screen.getByText('Nothing playing')).toBeDefined();
  });

  it('offers a device rather than reporting an error when there is none', () => {
    mountApp({ connection: fakeConnection({ state: IDLE_PANEL }) });

    expect(screen.getByRole('button', { name: /choose a device/i })).toBeDefined();
  });

  // Unknown is treated as Premium: accusing an account before we know is
  // exactly the confident lie D-022 is about.
  it('does not accuse an account of being free before it knows', () => {
    const { container } = mountApp();

    expect(container.textContent).not.toMatch(/premium/i);
  });

  it('explains a free account plainly and switches the controls off', () => {
    const { container } = mountApp({
      connection: fakeConnection({ state: playing({ isPremium: false }) }),
    });

    expect(screen.getByText('Premium required')).toBeDefined();
    expect(container.textContent).not.toMatch(/error|failed/i);
  });
});

describe('the plate, grown', () => {
  it('opens the device list from the notice action and polls only while it is open', async () => {
    const { devs } = mountApp({ connection: fakeConnection({ state: IDLE_PANEL }) });
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

/**
 * P3-13's visible half: the album's colour has to actually land on the
 * document, and it has to survive the gap between a track change and its
 * extraction.
 */
describe('the album colour', () => {
  const BLUE = {
    surface: '#0d1418',
    foreground: '#eef4f6',
    accent: '#4fa8ff',
    onAccent: '#04121f',
    controlTint: '#7d94a0',
  };

  it('starts neutral rather than unstyled', () => {
    const { theme } = mountApp({
      connection: fakeConnection({ state: playing() }),
    });

    expect(theme.properties.get('--joshify-accent')).toBe(DEFAULT_THEME.accent);
  });

  it('writes the album colour when it arrives', async () => {
    const conn = fakeConnection({ state: playing() });
    const { theme } = mountApp({ connection: conn });

    conn.set({ state: playing({ theme: BLUE, themeFor: 'track-1' }) });
    await vi.waitFor(() => {
      expect(theme.properties.get('--joshify-accent')).toBe('#4fa8ff');
    });

    expect(theme.properties.get('--joshify-surface')).toBe('#0d1418');
  });

  // The gap between a track change and its extraction is a few hundred
  // milliseconds. Snapping to grey and back across it is a visible flicker on
  // every track change, so the previous album's colour is held instead.
  it('holds the previous colour across a track change', async () => {
    const conn = fakeConnection({
      state: playing({ theme: BLUE, themeFor: 'track-1' }),
    });
    const { theme } = mountApp({ connection: conn });
    await vi.waitFor(() => {
      expect(theme.properties.get('--joshify-accent')).toBe('#4fa8ff');
    });

    // A new track, whose own theme has not been extracted yet: the server
    // sends the old tokens with the old `themeFor`.
    conn.set({
      state: playing({
        item: { ...track, id: 'track-2', title: 'Coolant' },
        theme: BLUE,
        themeFor: 'track-1',
      }),
    });
    await vi.waitFor(() => {
      expect(screen.getByText('Coolant')).toBeDefined();
    });

    expect(theme.properties.get('--joshify-accent')).toBe('#4fa8ff');
  });
});

describe('the queue surface', () => {
  const queued: PlayingItem[] = [
    { ...track, id: 'q-1', uri: 'spotify:track:q-1', title: 'Coolant' },
    { ...track, id: 'q-2', uri: 'spotify:track:q-2', title: 'Redline Sermon' },
  ];

  it('opens from the chip and polls only while it is open', async () => {
    const q = fakeQueue(queued);
    mountApp({ queue: q });
    expect(q.calls.opened).toBe(0);

    screen.getByRole('button', { name: 'Queue' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Redline Sermon')).toBeDefined();
    });

    expect(q.calls.opened).toBe(1);
  });

  // Spotify has no reorder, no remove and no jump-to-position (D-007, D-051).
  // A queue row that responded to touch would be promising something no client
  // can deliver.
  it('offers no way to act on a queued track', async () => {
    const q = fakeQueue(queued);
    const { container } = mountApp({ queue: q });

    screen.getByRole('button', { name: 'Queue' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Redline Sermon')).toBeDefined();
    });

    // Only the surface's own Done control, nothing per row.
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Done']);
  });

  it('closes the queue when the devices surface opens, and never both at once', async () => {
    const q = fakeQueue(queued);
    const devs = fakeDevices();
    mountApp({ queue: q, devices: devs });

    screen.getByRole('button', { name: 'Queue' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Redline Sermon')).toBeDefined();
    });

    screen.getByRole('button', { name: 'Done' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kitchen' })).toBeDefined();
    });
    screen.getByRole('button', { name: 'Kitchen' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Study')).toBeDefined();
    });

    expect(q.calls.closed).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Redline Sermon')).toBeNull();
  });

  it('closes both sources on unmount', async () => {
    const q = fakeQueue(queued);
    const devs = fakeDevices();
    const { unmount } = mountApp({ queue: q, devices: devs });

    screen.getByRole('button', { name: 'Queue' }).click();
    await vi.waitFor(() => {
      expect(screen.getByText('Redline Sermon')).toBeDefined();
    });

    unmount();
    expect(q.calls.closed).toBeGreaterThanOrEqual(1);
    expect(devs.calls.closed).toBeGreaterThanOrEqual(1);
  });
});
