import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDLE_PLAYBACK, isOk, ok, type PlaybackState } from '@joshify/core';
import { createSpotifyClient } from '../spotify/client.js';
import { createSpotifyCommands } from '../spotify/commands.js';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { createBroadcaster, type Broadcaster } from './broadcast.js';
import {
  applyServerMessage,
  parseServerMessage,
  type ClientState,
  type ServerMessage,
} from '@joshify/core';
import {
  DEFAULT_HOST,
  startHttpServer,
  WEBSOCKET_PATH,
  type HttpServerConfig,
  type RunningServer,
} from './server.js';

const PLAYING: PlaybackState = {
  isPlaying: true,
  progressMs: 1_000,
  shuffle: false,
  repeat: 'off',
  item: {
    kind: 'track',
    id: 'track-1',
    uri: 'spotify:track:track-1',
    title: 'Xtal',
    subtitle: 'Aphex Twin',
    durationMs: 293_000,
    images: [{ url: 'https://i.example/640.jpg', width: 640, height: 640 }],
    isLocal: false,
  },
  device: {
    id: 'device-1',
    name: 'Kitchen',
    type: 'Speaker',
    isActive: true,
    volumePercent: 40,
    supportsVolume: true,
  },
};

let spotify: FakeSpotify;
let broadcaster: Broadcaster;
const running: RunningServer[] = [];

/**
 * The real stack: Fastify, the real command layer, the real HTTP client, and
 * the fake Spotify — a real server on loopback. Only the credentials are
 * pretend, so a route that builds the wrong request fails here.
 */
const start = async (
  overrides: Partial<HttpServerConfig> = {},
): Promise<RunningServer> => {
  // Captured now: a test that rotates the fake's token afterwards is
  // simulating a credential revoked somewhere else, and this source has no
  // way to learn the new one — which is the whole point of that test.
  const token = spotify.validAccessToken;
  const client = createSpotifyClient({
    tokenSource: {
      getAccessToken: () => Promise.resolve(ok(token)),
      refreshAccessToken: () => Promise.resolve(ok(token)),
    },
    baseUrl: spotify.origin,
    // One attempt, no waiting: these tests are about what the route does with
    // a failure, and the retry policy has its own suite (P1-08).
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: () => Promise.resolve(),
  });
  const server = await startHttpServer({
    broadcaster,
    commands: createSpotifyCommands(client),
    port: 0,
    ...overrides,
  });
  running.push(server);
  return server;
};

const postJson = (
  server: RunningServer,
  path: string,
  body: unknown = {},
): Promise<Response> =>
  fetch(`${server.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * A GET with a chosen `Host` header.
 *
 * `fetch` refuses to set one — it is a forbidden header — and `Host` is
 * exactly what a rebinding attack gets wrong, so this goes one level down.
 */
const getWithHost = (server: RunningServer, host: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: server.host,
        port: server.port,
        path: '/health',
        headers: { host },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });

/** Speak HTTP by hand, for requests no client library will send. */
const rawRequest = (server: RunningServer, request: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: server.host, port: server.port }, () => {
      socket.write(request);
    });
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.on('end', () => {
      resolve(received);
    });
    socket.on('error', reject);
  });

/** A non-loopback IPv4 this machine actually answers on, if it has one. */
const lanAddress = (): string | null => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
};

interface TestSocket {
  readonly next: () => Promise<ServerMessage>;
  readonly silentFor: (ms: number) => Promise<boolean>;
  readonly send: (payload: unknown) => void;
  readonly close: () => Promise<void>;
}

/** A real browser-style WebSocket client, over a real socket. */
const connect = async (server: RunningServer): Promise<TestSocket> => {
  const socket = new WebSocket(
    `${server.origin.replace('http://', 'ws://')}${WEBSOCKET_PATH}`,
  );
  const queued: ServerMessage[] = [];
  let waiting: ((message: ServerMessage) => void) | null = null;

  socket.addEventListener('message', (event: { data: unknown }) => {
    const message = parseServerMessage(String(event.data));
    if (message === null) return;
    if (waiting === null) {
      queued.push(message);
      return;
    }
    waiting(message);
    waiting = null;
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('websocket failed to open'));
    });
  });

  const next = (): Promise<ServerMessage> => {
    const queuedMessage = queued.shift();
    if (queuedMessage !== undefined) return Promise.resolve(queuedMessage);
    return new Promise<ServerMessage>((resolve) => {
      waiting = resolve;
    });
  };

  return {
    next,
    silentFor: (ms) =>
      Promise.race([
        next().then(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            resolve(true);
          }, ms),
        ),
      ]),
    send: (payload) => {
      socket.send(JSON.stringify(payload));
    },
    close: () =>
      new Promise<void>((resolve) => {
        socket.addEventListener('close', () => {
          resolve();
        });
        socket.close();
      }),
  };
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  broadcaster = createBroadcaster();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await spotify.close();
});

describe('binding (P2-07)', () => {
  it('binds loopback when no host is configured', async () => {
    // The default has to be the safe one. This process holds a Spotify token
    // and can start music on the account; a home LAN is full of devices
    // nobody audits, and any of them would be able to reach a 0.0.0.0 bind.
    const server = await start();
    expect(server.host).toBe(DEFAULT_HOST);
    expect((await fetch(`${server.origin}/health`)).status).toBe(200);
  });

  it('cannot be reached from the LAN by default', async () => {
    const lan = lanAddress();
    if (lan === null) return;
    const server = await start();
    await expect(fetch(`http://${lan}:${String(server.port)}/health`)).rejects.toThrow();
  });

  it('binds a configured interface when one is asked for explicitly', async () => {
    // Loopback is the default, not a cage: a developer working from a laptop
    // against the Pi needs to be able to open it deliberately.
    const lan = lanAddress();
    if (lan === null) return;
    const server = await start({ host: lan });
    expect((await fetch(`${server.origin}/health`)).status).toBe(200);
  });

  it('refuses a request that asked for a host we do not serve', async () => {
    // DNS rebinding: a page from anywhere points a name it controls at
    // 127.0.0.1 and talks to this server same-origin, which no amount of
    // loopback binding prevents. The name it asked for gives it away.
    const server = await start();
    expect(await getWithHost(server, 'joshify.evil.example')).toBe(403);
  });

  it('serves a bracketed IPv6 loopback literal', async () => {
    // Chromium resolves `localhost` to ::1 before 127.0.0.1 on a dual-stack
    // Pi, so the kiosk's own requests arrive naming `[::1]`.
    const server = await start();
    expect(await getWithHost(server, '[::1]:1234')).toBe(200);
  });

  it('refuses a request that named no host at all', async () => {
    // HTTP/1.0 makes `Host` optional, which is how a port scanner and a
    // stripping proxy both look. Neither is the kiosk browser.
    const server = await start();
    const response = await rawRequest(server, 'GET /health HTTP/1.0\r\n\r\n');
    expect(response.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('serves a host that was explicitly allowed', async () => {
    const server = await start({ allowedHosts: ['kiosk.local'] });
    expect(await getWithHost(server, 'kiosk.local')).toBe(200);
    // And still nothing else, including the loopback default it replaced.
    expect(await getWithHost(server, '127.0.0.1')).toBe(403);
  });
});

describe('read routes', () => {
  it('answers a health check without touching Spotify', async () => {
    // The UI polls this while its socket is down (P2-09). If it cost a
    // Spotify request, a disconnected screen would burn the rate limit the
    // commands need.
    const server = await start();
    const response = await fetch(`${server.origin}/health`);
    expect(await response.json()).toEqual({ status: 'ok', version: 1, subscribers: 0 });
    expect(spotify.requests).toHaveLength(0);
  });

  it('serves the state the poller last published, in snapshot shape', async () => {
    const server = await start();
    broadcaster.publish(PLAYING);
    const response = await fetch(`${server.origin}/api/state`);
    expect(await response.json()).toEqual({ version: 2, state: PLAYING });
  });

  it('serves an idle state before the first poll returns', async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/state`);
    expect(await response.json()).toEqual({ version: 1, state: IDLE_PLAYBACK });
  });

  it('404s an unknown path', async () => {
    const server = await start();
    expect((await fetch(`${server.origin}/api/nothing`)).status).toBe(404);
  });
});

describe('command routes', () => {
  it('accepts a transport tap and sends exactly one player write', async () => {
    const server = await start();
    const response = await postJson(server, '/api/playback/pause');
    expect(response.status).toBe(202);
    expect(
      spotify.requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual(['PUT /v1/me/player/pause']);
  });

  it('passes a device target through to the query Spotify reads', async () => {
    // The one thing the UI can get wrong that looks like nothing happened:
    // a command aimed at no device pauses whatever is active instead.
    const server = await start();
    await postJson(server, '/api/playback/next', { deviceId: 'dev-9' });
    expect(spotify.requests[0]?.search).toBe('?device_id=dev-9');
  });

  it('sends a context play with its offset in the body', async () => {
    const server = await start();
    const response = await postJson(server, '/api/playback/play', {
      contextUri: 'spotify:album:abc',
      offset: { position: 3 },
      positionMs: 1_500,
    });
    expect(response.status).toBe(202);
    expect(spotify.requests[0]?.json).toEqual({
      context_uri: 'spotify:album:abc',
      offset: { position: 3 },
      position_ms: 1_500,
    });
  });

  it('sends a uri list play with a uri offset', async () => {
    const server = await start();
    await postJson(server, '/api/playback/play', {
      uris: ['spotify:track:a', 'spotify:track:b'],
      offset: { uri: 'spotify:track:b' },
    });
    expect(spotify.requests[0]?.json).toEqual({
      uris: ['spotify:track:a', 'spotify:track:b'],
      offset: { uri: 'spotify:track:b' },
    });
  });

  it('resumes with no body when the tap carried no options', async () => {
    const server = await start();
    await postJson(server, '/api/playback/play');
    expect(spotify.requests[0]?.json).toBeUndefined();
  });

  it.each([
    ['seek', { positionMs: 30_000 }, '/v1/me/player/seek', '?position_ms=30000'],
    ['volume', { volumePercent: 55 }, '/v1/me/player/volume', '?volume_percent=55'],
    ['shuffle', { enabled: true }, '/v1/me/player/shuffle', '?state=true'],
    ['repeat', { mode: 'track' }, '/v1/me/player/repeat', '?state=track'],
    ['previous', {}, '/v1/me/player/previous', ''],
  ])('sends %s with the query Spotify expects', async (name, body, path, search) => {
    const server = await start();
    const response = await postJson(server, `/api/playback/${name}`, body);
    expect(response.status).toBe(202);
    expect(spotify.requests[0]?.path).toBe(path);
    expect(spotify.requests[0]?.search).toBe(search);
  });

  it('transfers playback with the device in the body, as Spotify wants it', async () => {
    const server = await start();
    await postJson(server, '/api/playback/transfer', { deviceId: 'dev-2', play: true });
    expect(spotify.requests[0]?.json).toEqual({ device_ids: ['dev-2'], play: true });
  });

  it.each([
    ['seek', {}, 'positionMs'],
    ['seek', { positionMs: 'soon' }, 'positionMs'],
    ['volume', { volumePercent: null }, 'volumePercent'],
    ['shuffle', { enabled: 'yes' }, 'enabled'],
    ['repeat', { mode: 'sometimes' }, 'mode'],
    ['repeat', { mode: 42 }, 'mode'],
    ['transfer', {}, 'deviceId'],
    ['transfer', { deviceId: 'dev-2', play: 'yes' }, 'play'],
    ['pause', { deviceId: 7 }, 'deviceId'],
    ['play', { uris: ['a', 3] }, 'uris'],
    ['play', { contextUri: 'spotify:album:abc', offset: { at: 3 } }, 'offset'],
    ['play', { contextUri: 12 }, 'contextUri'],
    ['play', { positionMs: 'start' }, 'positionMs'],
  ])('rejects %s with a bad %s before Spotify sees it', async (name, body, field) => {
    // A malformed body must fail locally. Spotify answers every bad player
    // write with a flat "Player command failed" that names nothing, so a
    // request that gets that far produces an error nobody can act on.
    const server = await start();
    const response = await postJson(server, `/api/playback/${name}`, body);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(field);
    expect(spotify.requests).toHaveLength(0);
  });

  it('rejects a body that is not an object at all', async () => {
    const server = await start();
    const response = await postJson(server, '/api/playback/seek', 'thirty seconds');
    expect(response.status).toBe(400);
    expect(spotify.requests).toHaveLength(0);
  });

  it('refuses a form-encoded post, which is what a hostile page can send', async () => {
    // Only JSON is parsed, so a cross-origin form submission — the one shape
    // of request a browser will send without a preflight — never reaches a
    // command handler.
    const server = await start();
    const response = await fetch(`${server.origin}/api/playback/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'deviceId=dev-1',
    });
    expect(response.status).toBe(415);
    expect(spotify.requests).toHaveLength(0);
  });
});

describe('command failures', () => {
  it('reports a device that will not take a volume as forbidden', async () => {
    // Cast targets, TVs and receivers answer 403 to a volume write. The UI
    // has to hear about it so it can stop pretending the slider moved (P2-05).
    const server = await start();
    spotify.volumeSupported = false;
    const response = await postJson(server, '/api/playback/volume', {
      volumePercent: 20,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { kind: 'forbidden' } });
  });

  it('passes a rate limit through with the wait Spotify asked for', async () => {
    // The UI must back off by what Spotify said, not by a guess of its own.
    const server = await start();
    spotify.failNext({
      status: 429,
      body: { error: { status: 429, message: 'rate limited' } },
      headers: { 'retry-after': '3' },
    });
    const response = await postJson(server, '/api/playback/next');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
  });

  it('reports no active device as a conflict, not a fault', async () => {
    // Nothing is broken: the last device went to sleep, and the remedy is to
    // pick another one.
    const server = await start();
    spotify.failNext({ status: 404, body: { error: { message: 'no active device' } } });
    const response = await postJson(server, '/api/playback/pause');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { kind: 'no-active-device', retryable: false },
    });
  });

  it('reports a free account as forbidden with the reason intact', async () => {
    const server = await start();
    spotify.failNext({
      status: 403,
      body: { error: { message: 'Player command failed: Premium required' } },
    });
    const response = await postJson(server, '/api/playback/play');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { kind: 'not-premium' } });
  });

  it('reports Spotify being down as a bad gateway', async () => {
    const server = await start();
    spotify.failNext({
      status: 503,
      body: { error: { message: 'service unavailable' } },
    });
    const response = await postJson(server, '/api/playback/pause');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { retryable: true } });
  });

  it('reports a dead token as unauthorised', async () => {
    const server = await start();
    spotify.validAccessToken = 'rotated-elsewhere';
    const response = await postJson(server, '/api/playback/pause');
    expect(response.status).toBe(401);
  });
});

describe('websocket push (P2-08)', () => {
  it('sends a full snapshot the moment a client connects', async () => {
    const server = await start();
    broadcaster.publish(PLAYING);
    const socket = await connect(server);
    expect(await socket.next()).toEqual({ type: 'snapshot', version: 2, state: PLAYING });
    await socket.close();
  });

  it('sends only what changed on an ordinary tick', async () => {
    // Several times a second only the progress bar moves. Re-sending the
    // album art URL, the device list and the track metadata each time is the
    // waste this exists to avoid on a device we want to stay responsive.
    const server = await start();
    broadcaster.publish(PLAYING);
    const socket = await connect(server);
    await socket.next();

    broadcaster.publish({ ...PLAYING, progressMs: 4_000 });
    expect(await socket.next()).toEqual({
      type: 'diff',
      version: 3,
      from: 2,
      changes: { progressMs: 4_000 },
    });
    await socket.close();
  });

  it('says nothing at all when a tick changed nothing', async () => {
    const server = await start();
    broadcaster.publish(PLAYING);
    const socket = await connect(server);
    await socket.next();

    broadcaster.publish({ ...PLAYING });
    expect(await socket.silentFor(75)).toBe(true);
    await socket.close();
  });

  it('rebuilds the server state exactly from a snapshot plus diffs', async () => {
    // The end-to-end claim: a client that starts from a snapshot and applies
    // every diff in order holds precisely what the server holds.
    const server = await start();
    const socket = await connect(server);
    let held: ClientState | null = null;

    for (const state of [PLAYING, { ...PLAYING, progressMs: 8_000, shuffle: true }]) {
      broadcaster.publish(state);
    }
    for (let index = 0; index < 3; index += 1) {
      const applied = applyServerMessage(held, await socket.next());
      expect(applied.ok).toBe(true);
      if (isOk(applied)) held = applied.value;
    }

    expect(held?.state).toEqual(broadcaster.getState());
    expect(held?.version).toBe(broadcaster.getVersion());
    await socket.close();
  });

  it('keeps proving it is alive while nothing plays', async () => {
    // A dropped wifi link leaves the browser's socket OPEN for minutes. On a
    // wall-mounted screen nobody is going to click anything to find out, so
    // silence has to be bounded.
    const server = await start({ heartbeatMs: 20 });
    const socket = await connect(server);
    await socket.next();
    expect(await socket.next()).toEqual({ type: 'heartbeat', version: 1 });
    await socket.close();
  });

  it('ignores a frame it cannot parse instead of dropping the socket', async () => {
    const server = await start();
    const socket = await connect(server);
    await socket.next();

    socket.send('not a message we speak');
    broadcaster.publish(PLAYING);
    expect((await socket.next()).type).toBe('diff');
    await socket.close();
  });

  it('lets go of a client that disconnects', async () => {
    const server = await start();
    const socket = await connect(server);
    await socket.next();
    expect(broadcaster.subscriberCount()).toBe(1);

    await socket.close();
    await expect.poll(() => broadcaster.subscriberCount()).toBe(0);
  });
});

describe('reconnect and resume (P2-09)', () => {
  it('answers a resync request with a snapshot, without a reconnect', async () => {
    // What a client does the moment it detects a gap: the socket is fine, its
    // state is not, and re-opening the socket to fix that would throw away a
    // working connection.
    const server = await start();
    const socket = await connect(server);
    await socket.next();
    broadcaster.publish(PLAYING);
    await socket.next();

    socket.send({ type: 'resync' });
    expect(await socket.next()).toEqual({ type: 'snapshot', version: 2, state: PLAYING });
    await socket.close();
  });

  it('gives a reconnecting client a snapshot, never a diff into stale state', async () => {
    // The seam: after the socket dies the client's state is arbitrarily old,
    // so the next diff is meaningless to it. It gets a full state instead,
    // and the version stamp means it could not have applied one anyway.
    const server = await start();
    const first = await connect(server);
    const opening = await first.next();
    const held = isOk(applyServerMessage(null, opening))
      ? applyServerMessage(null, opening)
      : null;
    await first.close();

    broadcaster.publish(PLAYING);
    broadcaster.publish({ ...PLAYING, progressMs: 30_000 });

    const second = await connect(server);
    const resumed = await second.next();
    expect(resumed).toEqual({
      type: 'snapshot',
      version: 3,
      state: { ...PLAYING, progressMs: 30_000 },
    });
    // And the state it was holding is provably not something a diff could
    // have been folded into.
    expect(held !== null && isOk(held) && held.value.version).toBe(1);
    await second.close();
  });

  it('recovers from the server process restarting on the same port', async () => {
    // The most common outage by far: the unit restarts, the socket dies, and
    // the screen must come back on its own with no error and nothing stale.
    const first = await start();
    const socket = await connect(first);
    await socket.next();
    await first.close();
    running.length = 0;

    broadcaster = createBroadcaster({ initialState: PLAYING });
    const second = await start({ port: first.port });
    const reconnected = await connect(second);
    expect(await reconnected.next()).toEqual({
      type: 'snapshot',
      version: 1,
      state: PLAYING,
    });
    await reconnected.close();
  });

  it('serves the same state over HTTP as over the socket', async () => {
    // A client backing off between reconnects can fall back to polling
    // `/api/state` and end up holding exactly what a socket would have given
    // it — same version, same state, same recovery path.
    const server = await start();
    broadcaster.publish(PLAYING);
    const socket = await connect(server);
    const snapshot = await socket.next();
    const fetched: unknown = await (await fetch(`${server.origin}/api/state`)).json();
    expect(fetched).toEqual({
      version: snapshot.type === 'snapshot' ? snapshot.version : 0,
      state: PLAYING,
    });
    await socket.close();
  });
});
