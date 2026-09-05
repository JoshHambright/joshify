/**
 * The real panel, driven by a scripted fake instead of a Spotify account.
 *
 * This is not a mockup. It mounts `App.svelte` with the same props `main.ts`
 * gives it — the same components, the same tokens, the same CSS — and swaps
 * only the three things that would otherwise need a server: the socket, the
 * command client and the device source. So what a reviewer taps is the thing
 * that will run on the Pi, on different hardware (CLAUDE.md, D-016).
 *
 * Built to a single self-contained file so it can be published and opened
 * anywhere with no build step and no network.
 */
import { mount } from 'svelte';
import App from '../src/App.svelte';
import type { PlaybackDevice, PlaybackState } from '@joshify/core';
import type { CommandClient } from '../src/lib/commands.js';
import type { Connection, ConnectionState } from '../src/lib/connection.js';
import type { DeviceSource, DeviceSourceState } from '../src/lib/device-source.js';
import { createThemeApplier } from '../src/lib/theme.js';
import '../src/styles/tokens.css';

/**
 * Covers drawn as data URIs rather than fetched.
 *
 * A published page has no network guarantee, and the whole point of the
 * crossfade is that it waits for a *decode* — an image that never arrives
 * would make the panel look broken while behaving correctly.
 */
const cover = (a: string, b: string, mark: string): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
    </linearGradient></defs>
    <rect width="640" height="640" fill="url(#g)"/>
    <circle cx="470" cy="180" r="130" fill="${mark}" opacity="0.85"/>
    <rect x="60" y="430" width="300" height="26" fill="${mark}" opacity="0.7"/>
    <rect x="60" y="476" width="190" height="26" fill="${mark}" opacity="0.45"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const TRACKS = [
  {
    title: 'Velocity Division',
    subtitle: 'Nitrous Cartel',
    durationMs: 211_000,
    art: cover('#1b2a4a', '#0b1020', '#ff5c8a'),
  },
  {
    title: 'Coolant',
    subtitle: 'Nitrous Cartel',
    durationMs: 184_000,
    art: cover('#123a33', '#04140f', '#4fe3a1'),
  },
  {
    title: 'Redline Sermon',
    subtitle: 'Bright Corridor',
    durationMs: 246_000,
    art: cover('#3a1e0c', '#160804', '#ffb347'),
  },
] as const;

const DEVICES: readonly PlaybackDevice[] = [
  {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    isActive: true,
    volumePercent: 62,
    supportsVolume: true,
  },
  {
    id: 'dev-2',
    name: 'Study',
    type: 'Computer',
    isActive: false,
    volumePercent: 40,
    supportsVolume: true,
  },
  // Reports no volume: the row must show no slider at all (D-022, D-047).
  {
    id: 'dev-3',
    name: 'Living Room TV',
    type: 'TV',
    isActive: false,
    volumePercent: null,
    supportsVolume: false,
  },
  // Restricted: listed, dimmed, untappable — never silently dropped.
  {
    id: null,
    name: 'Car',
    type: 'Automobile',
    isActive: false,
    volumePercent: null,
    supportsVolume: false,
  },
];

let index = 0;
let playing = true;
let progressMs = 64_000;
let shuffle = false;
let repeat: PlaybackState['repeat'] = 'off';
let volume = 62;
let deviceId = 'dev-1';
let link: ConnectionState['link'] = 'live';
let nothingPlaying = false;
let hasDevice = true;

const stateNow = (): PlaybackState => {
  const t = TRACKS[index] ?? TRACKS[0];
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0];
  if (nothingPlaying || !hasDevice) {
    return {
      isPlaying: false,
      progressMs: null,
      shuffle,
      repeat,
      item: null,
      device: hasDevice ? { ...device, volumePercent: volume, isActive: true } : null,
    };
  }
  return {
    isPlaying: playing,
    progressMs,
    shuffle,
    repeat,
    item: {
      kind: 'track',
      id: `track-${String(index)}`,
      uri: `spotify:track:${String(index)}`,
      title: t.title,
      subtitle: t.subtitle,
      durationMs: t.durationMs,
      images: [{ url: t.art, width: 640, height: 640 }],
      isLocal: false,
    },
    device: { ...device, volumePercent: volume, isActive: true },
  };
};

const listeners = new Set<(v: ConnectionState) => void>();
let version = 1;

const publish = (): void => {
  version += 1;
  const value: ConnectionState = { link, state: stateNow(), version, attempt: 0 };
  for (const run of listeners) run(value);
};

const connection: Connection = {
  subscribe: (run) => {
    listeners.add(run);
    run({ link, state: stateNow(), version, attempt: 0 });
    return () => listeners.delete(run);
  },
  open: () => undefined,
  close: () => undefined,
  current: () => ({ link, state: stateNow(), version, attempt: 0 }),
};

// The real server answers commands with 202 and proves them on the socket a
// moment later. This does the same thing, so the optimistic path is exercised
// exactly as it will be.
const client: CommandClient = {
  send: (command, target) => {
    switch (command.kind) {
      case 'play':
        playing = true;
        break;
      case 'pause':
        playing = false;
        break;
      case 'next':
        index = (index + 1) % TRACKS.length;
        progressMs = 0;
        break;
      case 'previous':
        index = (index + TRACKS.length - 1) % TRACKS.length;
        progressMs = 0;
        break;
      case 'seek':
        progressMs = command.positionMs;
        break;
      case 'volume':
        volume = command.volumePercent;
        break;
      case 'shuffle':
        shuffle = command.enabled;
        break;
      case 'repeat':
        repeat = command.mode;
        break;
      case 'transfer':
        deviceId = command.deviceId;
        break;
    }
    void target;
    setTimeout(publish, 120);
    return Promise.resolve(null);
  },
};

const deviceState = (): DeviceSourceState => ({
  devices: DEVICES.map((d) => ({ ...d, isActive: d.id === deviceId })),
  problem: null,
  pending: false,
});

const deviceListeners = new Set<(v: DeviceSourceState) => void>();
const devices: DeviceSource = {
  subscribe: (run) => {
    deviceListeners.add(run);
    run(deviceState());
    return () => deviceListeners.delete(run);
  },
  open: () => undefined,
  close: () => undefined,
  refresh: () => {
    for (const run of deviceListeners) run(deviceState());
    return Promise.resolve();
  },
  current: deviceState,
};

// A poll every second, as the real engine does near nothing in particular.
setInterval(() => {
  const t = TRACKS[index] ?? TRACKS[0];
  if (playing) progressMs = (progressMs + 1000) % t.durationMs;
  publish();
}, 1000);

const target = document.querySelector('#panel');
if (target === null) throw new Error('#panel is missing');

createThemeApplier(document.documentElement);
mount(App, { target, props: { connection, client, devices } });

/**
 * A review harness, not part of the product.
 *
 * The states worth looking at — reconnecting, nothing playing, no device — are
 * the ones a reviewer cannot reach by tapping, and the ones most likely to be
 * wrong. Keeping them one keypress away is the difference between reviewing
 * the panel and reviewing its happy path.
 */
const controls = document.querySelector('#harness');
if (controls !== null) {
  const button = (label: string, run: () => void): HTMLButtonElement => {
    const el = document.createElement('button');
    el.textContent = label;
    el.addEventListener('click', run);
    controls.append(el);
    return el;
  };
  button('link: live', () => {
    link = 'live';
    publish();
  });
  button('link: reconnecting', () => {
    link = 'reconnecting';
    publish();
  });
  button('nothing playing', () => {
    nothingPlaying = true;
    hasDevice = true;
    publish();
  });
  button('no device', () => {
    hasDevice = false;
    publish();
  });
  button('resume', () => {
    nothingPlaying = false;
    hasDevice = true;
    publish();
  });
}
