/**
 * The composition root, exercised end to end: a real token store on a real
 * temp directory, a real HTTP server on a real port, and the fake Spotify
 * behind it.
 *
 * This is the only test that proves the *whole* thing fits together. Every
 * other suite tests one seam with the others faked, which is what makes them
 * fast and precise — and also what makes it possible for all of them to pass
 * while nothing actually runs.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOk, type JoshifyError } from '@joshify/core';
import { createTokenStore } from '../auth/token-store.js';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { serve, type RunningJoshify } from './serve.js';

let spotify: FakeSpotify;
let dataDir: string;
const running: RunningJoshify[] = [];
const problems: JoshifyError[] = [];

const trackPayload = () => ({
  is_playing: true,
  progress_ms: 30_000,
  shuffle_state: false,
  repeat_state: 'off',
  device: {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    is_active: true,
    volume_percent: 55,
  },
  item: {
    type: 'track',
    id: 'track-1',
    uri: 'spotify:track:track-1',
    name: 'Velocity Division',
    duration_ms: 211_000,
    artists: [{ name: 'Nitrous Cartel' }],
    album: { name: 'Velocity Division', images: [] },
  },
});

const connect = async (): Promise<void> => {
  const store = createTokenStore({ dataDir });
  const saved = await store.save({
    accessToken: spotify.validAccessToken,
    refreshToken: 'refresh-seed',
    expiresAt: Date.now() + 3_600_000,
    refreshAt: Date.now() + 2_880_000,
    scopes: ['user-read-playback-state'],
  });
  expect(isOk(saved)).toBe(true);
};

const start = async () => {
  const result = await serve({
    dataDir,
    clientId: 'client-id',
    port: 0,
    spotify: { baseUrl: spotify.origin, tokenEndpoint: spotify.tokenEndpoint },
    onProblem: (problem) => problems.push(problem),
  });
  if (!isOk(result)) throw new Error(`serve failed: ${result.error.message}`);
  running.push(result.value);
  return result.value;
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  dataDir = await mkdtemp(join(tmpdir(), 'joshify-serve-'));
  problems.length = 0;
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
  await spotify.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('starting', () => {
  // A unit that exits is visible in `systemctl status`. One that comes up and
  // serves 401s looks healthy from the outside and is far worse.
  it('refuses to start when no account is connected', async () => {
    const result = await serve({ dataDir, clientId: 'client-id', port: 0 });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('auth');
    expect(result.error.message).toContain('joshify auth');
  });

  it('creates its artwork cache directory', async () => {
    await connect();
    await start();

    // No throw from `serve` is the assertion — it returns an error if mkdir
    // fails — but check the directory is really there rather than trusting it.
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(dataDir, 'artwork'))).isDirectory()).toBe(true);
  });

  it('binds loopback and serves health', async () => {
    await connect();
    const { server } = await start();

    const response = await fetch(`${server.origin}/health`);

    expect(response.status).toBe(200);
    expect(server.host).toBe('127.0.0.1');
  });
});

describe('running', () => {
  it('polls Spotify and serves what is playing', async () => {
    spotify.playbackState = trackPayload();
    await connect();
    const { server } = await start();

    await vi.waitFor(async () => {
      const body = (await (await fetch(`${server.origin}/api/state`)).json()) as {
        state: { item: { title: string } | null };
      };
      expect(body.state.item?.title).toBe('Velocity Division');
    });
  });

  it('serves the read routes the panel needs', async () => {
    spotify.playbackState = trackPayload();
    spotify.queue = { currently_playing: null, queue: [] };
    await connect();
    const { server } = await start();

    expect((await fetch(`${server.origin}/api/devices`)).status).toBe(200);
    expect((await fetch(`${server.origin}/api/queue`)).status).toBe(200);
    expect((await fetch(`${server.origin}/api/library`)).status).toBe(200);
  });

  it('accepts a transport command', async () => {
    spotify.playbackState = trackPayload();
    await connect();
    const { server } = await start();

    const response = await fetch(`${server.origin}/api/playback/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    // 202: Spotify accepted it, the proof arrives on the socket (D-028).
    expect(response.status).toBe(202);
    expect(spotify.requests.some((r) => r.path === '/v1/me/player/pause')).toBe(true);
  });

  // The routes must go through the engine, not the raw Spotify commands.
  // Both compile; the raw ones just silently skip the optimistic layer, and
  // every tap then waits a full poll to show any effect.
  it('applies a command optimistically before Spotify has confirmed it', async () => {
    spotify.playbackState = trackPayload();
    await connect();
    const { server } = await start();

    const readPlaying = async (): Promise<boolean> => {
      const body = (await (await fetch(`${server.origin}/api/state`)).json()) as {
        state: { isPlaying: boolean };
      };
      return body.state.isPlaying;
    };
    await vi.waitFor(async () => {
      expect(await readPlaying()).toBe(true);
    });

    // The fake will not answer the pause until it is released, so anything
    // observable before then is the optimistic layer and nothing else.
    await fetch(`${server.origin}/api/playback/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(await readPlaying()).toBe(false);
  });

  // The artwork route is registered, and a key it has never cached is a miss
  // rather than a fault — the panel's own fallback is a flat surface.
  it('registers the artwork route and 404s an unknown key', async () => {
    await connect();
    const { server } = await start();

    const response = await fetch(`${server.origin}/api/artwork/${'0'.repeat(32)}`);

    expect(response.status).toBe(404);
  });

  it('reports the account as Premium once the profile is read', async () => {
    spotify.playbackState = trackPayload();
    await connect();
    const { server } = await start();

    await vi.waitFor(async () => {
      const body = (await (await fetch(`${server.origin}/api/state`)).json()) as {
        state: { isPremium: boolean | null };
      };
      expect(body.state.isPremium).toBe(true);
    });
  });
});

describe('stopping', () => {
  it('closes the port so a restart can take it again', async () => {
    await connect();
    const started = await start();
    const { origin } = started.server;

    await started.stop();
    running.length = 0;

    await expect(fetch(`${origin}/health`)).rejects.toThrow();
  });

  it('stops the poll loop, so nothing talks to Spotify after shutdown', async () => {
    spotify.playbackState = trackPayload();
    await connect();
    const started = await start();
    await vi.waitFor(() => {
      expect(spotify.requests.some((r) => r.path === '/v1/me/player')).toBe(true);
    });

    await started.stop();
    running.length = 0;
    const after = spotify.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(spotify.requests).toHaveLength(after);
  });
});
