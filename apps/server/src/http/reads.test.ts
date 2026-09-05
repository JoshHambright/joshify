/**
 * The read half of the panel's API: devices, queue, search and library.
 *
 * These run the real Fastify stack against the real Spotify client with the
 * fake Spotify behind it, for the same reason the command routes do — a route
 * that builds the wrong upstream request fails here rather than on the device.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '@joshify/core';
import { createSpotifyClient } from '../spotify/client.js';
import { createSpotifyCommands } from '../spotify/commands.js';
import { createLibraryBrowser } from '../library/browse.js';
import { createSearchSession } from '../library/search.js';
import { normaliseDeviceList, normaliseQueue } from '@joshify/core';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { createBroadcaster, type Broadcaster } from './broadcast.js';
import { startHttpServer, type PanelReads, type RunningServer } from './server.js';

let spotify: FakeSpotify;
let broadcaster: Broadcaster;
const running: RunningServer[] = [];

const start = async (readsOverride?: Partial<PanelReads>): Promise<RunningServer> => {
  const token = spotify.validAccessToken;
  const client = createSpotifyClient({
    tokenSource: {
      getAccessToken: () => Promise.resolve(ok(token)),
      refreshAccessToken: () => Promise.resolve(ok(token)),
    },
    baseUrl: spotify.origin,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: () => Promise.resolve(),
  });
  const browser = createLibraryBrowser(client);
  // No debounce: the delay is the search session's own tested behaviour, and
  // waiting 250ms per assertion here would buy nothing.
  const session = createSearchSession({ client, debounceMs: 0 });

  const reads: PanelReads = {
    devices: async () => {
      const raw = await client.getDevices();
      return raw.ok ? normaliseDeviceList(raw.value) : raw;
    },
    queue: async () => {
      const raw = await client.getQueue();
      return raw.ok ? normaliseQueue(raw.value) : raw;
    },
    search: (query) => session.search(query),
    savedAlbums: (page) => browser.savedAlbums(page),
    playlists: (page) => browser.playlists(page),
    playlistTracks: (id, page) => browser.playlistTracks(id, page),
    ...readsOverride,
  };

  const server = await startHttpServer({
    broadcaster,
    commands: createSpotifyCommands(client),
    port: 0,
    reads,
  });
  running.push(server);
  return server;
};

const getJson = async (
  server: RunningServer,
  path: string,
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${server.origin}${path}`);
  const body: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body };
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  broadcaster = createBroadcaster();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await spotify.close();
});

describe('GET /api/devices', () => {
  it('answers the normalised list the panel expects', async () => {
    spotify.devices = {
      devices: [
        {
          id: 'dev-1',
          name: 'Kitchen',
          type: 'Speaker',
          is_active: true,
          volume_percent: 40,
        },
        { id: 'dev-2', name: 'TV', type: 'TV', is_active: false, supports_volume: false },
      ],
    };
    const server = await start();

    const { status, body } = await getJson(server, '/api/devices');

    expect(status).toBe(200);
    expect(body).toEqual({
      devices: [
        {
          id: 'dev-1',
          name: 'Kitchen',
          type: 'Speaker',
          isActive: true,
          volumePercent: 40,
          supportsVolume: true,
        },
        {
          id: 'dev-2',
          name: 'TV',
          type: 'TV',
          isActive: false,
          volumePercent: null,
          supportsVolume: false,
        },
      ],
    });
  });

  // Nothing to move music to is a state, not a fault: the panel says "no
  // devices" rather than showing an error.
  it('answers an empty list rather than an error when nothing is available', async () => {
    spotify.devices = { devices: [] };
    const server = await start();

    const { status, body } = await getJson(server, '/api/devices');

    expect(status).toBe(200);
    expect(body).toEqual({ devices: [] });
  });

  // 500 rather than 401: a 401 makes the client refresh and retry, which is
  // its own tested behaviour. What is being checked here is that a failure
  // the client cannot recover from reaches the panel as a status, not a 200.
  it('maps an upstream failure onto the status the panel should show', async () => {
    const server = await start();
    spotify.failNext({ status: 500 });

    const { status, body } = await getJson(server, '/api/devices');

    expect(status).toBe(502);
    expect(body).toMatchObject({ error: { kind: 'server' } });
  });
});

describe('GET /api/queue', () => {
  it('reports what is on now and what follows', async () => {
    spotify.queue = {
      currently_playing: {
        type: 'track',
        id: 'track-1',
        uri: 'spotify:track:track-1',
        name: 'Xtal',
        duration_ms: 293_000,
        artists: [{ name: 'Aphex Twin' }],
        album: { name: 'SAW 85-92', images: [] },
      },
      queue: [
        {
          type: 'track',
          id: 'track-2',
          uri: 'spotify:track:track-2',
          name: 'Tha',
          duration_ms: 550_000,
          artists: [{ name: 'Aphex Twin' }],
          album: { name: 'SAW 85-92', images: [] },
        },
      ],
    };
    const server = await start();

    const { status, body } = await getJson(server, '/api/queue');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      current: { title: 'Xtal' },
      upcoming: [{ title: 'Tha', subtitle: 'Aphex Twin' }],
    });
  });

  // The endpoint 204s when nothing is queued, which is a state with a sensible
  // thing to draw — an empty list — not a failure.
  it('reads an empty queue as empty rather than as an error', async () => {
    spotify.queue = null;
    const server = await start();

    const { status, body } = await getJson(server, '/api/queue');

    expect(status).toBe(200);
    expect(body).toEqual({ current: null, upcoming: [] });
  });

  it('asks Spotify for episodes, so a queued podcast is not a null row', async () => {
    spotify.queue = { queue: [] };
    const server = await start();
    await getJson(server, '/api/queue');

    const call = spotify.requests.find((r) => r.path === '/v1/me/player/queue');
    expect(call?.query['additional_types']).toBe('episode');
  });
});

describe('GET /api/search', () => {
  it('rejects a missing or empty query before spending a round trip', async () => {
    const server = await start();

    expect((await getJson(server, '/api/search')).status).toBe(400);
    expect((await getJson(server, '/api/search?q=')).status).toBe(400);
    expect((await getJson(server, '/api/search?q=%20%20')).status).toBe(400);
    expect(spotify.requests.filter((r) => r.path === '/v1/search')).toHaveLength(0);
  });

  it('passes the query upstream and answers the normalised results', async () => {
    const server = await start();

    const { status, body } = await getJson(server, '/api/search?q=aphex');

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'results' });
    const call = spotify.requests.find((r) => r.path === '/v1/search');
    expect(call?.query['q']).toBe('aphex');
  });
});

describe('GET /api/library', () => {
  it('serves saved albums and playlists', async () => {
    const server = await start();

    expect((await getJson(server, '/api/library/albums')).status).toBe(200);
    expect((await getJson(server, '/api/library/playlists')).status).toBe(200);
    expect(spotify.requests.some((r) => r.path === '/v1/me/albums')).toBe(true);
    expect(spotify.requests.some((r) => r.path === '/v1/me/playlists')).toBe(true);
  });

  it('passes the paging window through', async () => {
    const server = await start();
    await getJson(server, '/api/library/albums?offset=50&limit=25');

    const call = spotify.requests.find((r) => r.path === '/v1/me/albums');
    expect(call?.query['offset']).toBe('50');
    expect(call?.query['limit']).toBe('25');
  });

  // Left absent, not defaulted: a browser sending `offset=banana` has broken
  // paging arithmetic, and defaulting to 0 hides that behind a list that
  // silently repeats its first page.
  it('does not invent a window from an unparseable one', async () => {
    const server = await start();
    await getJson(server, '/api/library/albums?offset=banana');

    const call = spotify.requests.find((r) => r.path === '/v1/me/albums');
    expect(call?.query['offset']).toBe('0');
  });

  it('reports a bad window as the caller’s error rather than clamping it', async () => {
    const server = await start();

    const { status } = await getJson(server, '/api/library/albums?limit=999');

    // 400: `unexpected` is the panel's own mistake, and the status says so.
    expect(status).toBe(400);
    expect(spotify.requests.some((r) => r.path === '/v1/me/albums')).toBe(false);
  });

  // An empty query shows the library, and that first paint wants both halves.
  // Two round trips to fill one screen is two chances to be half-drawn.
  it('serves both halves in one request for the first paint', async () => {
    const server = await start();

    const { status, body } = await getJson(server, '/api/library');

    expect(status).toBe(200);
    expect(body).toMatchObject({ albums: { items: [] }, playlists: { items: [] } });
  });

  // A half-library is not a useful thing to render, and reporting it as
  // success leaves the screen quietly missing rows nobody knows are missing.
  it('fails the combined request when either half fails', async () => {
    const server = await start();
    spotify.failNext({ status: 500 });
    spotify.failNext({ status: 500 });

    const { status } = await getJson(server, '/api/library');

    expect(status).toBe(502);
  });

  it('serves the tracks behind one playlist', async () => {
    const server = await start();

    const { status } = await getJson(server, '/api/library/playlists/pl-1');

    expect(status).toBe(200);
    expect(spotify.requests.some((r) => r.path === '/v1/playlists/pl-1/tracks')).toBe(
      true,
    );
  });
});

// A panel built for transport alone should not have to stub five endpoints it
// never calls, and a 404 is a truer answer than a 200 with nothing in it.
describe('a server built without a reader', () => {
  it('does not register the read routes at all', async () => {
    const client = createSpotifyClient({
      tokenSource: {
        getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
        refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
      },
      baseUrl: spotify.origin,
      sleep: () => Promise.resolve(),
    });
    const server = await startHttpServer({
      broadcaster,
      commands: createSpotifyCommands(client),
      port: 0,
    });
    running.push(server);

    expect((await getJson(server, '/api/devices')).status).toBe(404);
    expect((await getJson(server, '/api/queue')).status).toBe(404);
    // The playback half still works, which is the point of it being optional.
    expect((await getJson(server, '/api/state')).status).toBe(200);
  });
});
