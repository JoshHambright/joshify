/**
 * The local HTTP + WebSocket server the kiosk UI talks to (P2-07).
 *
 * It binds to loopback and nothing else by default. This process holds a
 * Spotify token and can start music on the user's account, and it runs on a
 * home LAN full of devices nobody audits — a guest phone, a smart bulb, a TV.
 * A default of `0.0.0.0` would hand every one of them the playback controls,
 * so the bind address is configurable but the safe value is the one you get
 * for free.
 *
 * Everything it needs comes in through the config: the broadcaster that holds
 * playback state, and the command handler that writes to Spotify. Nothing is
 * constructed in here, which is what lets the tests run the real Fastify stack
 * over a real socket with a fake Spotify behind it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import {
  createError,
  err,
  ok,
  type ErrorKind,
  type JoshifyError,
  type Result,
} from '@joshify/core';
import type {
  CommandTarget,
  PlayOffset,
  PlayOptions,
  SpotifyCommands,
} from '../spotify/commands.js';
import type { Broadcaster } from './broadcast.js';
import { parseClientMessage } from './protocol.js';

/** Loopback: reachable from the Pi's own browser, from nothing else. */
export const DEFAULT_HOST = '127.0.0.1';

/** Arbitrary, high, and not in the IANA registry. */
export const DEFAULT_PORT = 4770;

export const DEFAULT_HEARTBEAT_MS = 15_000;

export const WEBSOCKET_PATH = '/ws';

export interface HttpServerConfig {
  /** Holds current playback state and pushes changes to sockets (P2-08). */
  readonly broadcaster: Broadcaster;
  /** The write half. P2-05's optimistic layer implements the same interface. */
  readonly commands: SpotifyCommands;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly heartbeatMs?: number | undefined;
  /**
   * Host header values to accept, overriding the default policy below. Needed
   * when the device is deliberately served under a name.
   */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Off by default: an unattended kiosk should not fill its SD card. */
  readonly logger?: boolean | undefined;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set([
  'localhost',
  '::1',
  '[::1]',
  '0000:0000:0000:0000:0000:0000:0000:0001',
]);

/** The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. */
const isLoopbackName = (name: string): boolean =>
  LOOPBACK_NAMES.has(name) || name.startsWith('127.');

/** `Host` carries an optional port, and an IPv6 literal is bracketed. */
const hostnameOf = (header: string): string => {
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1);
  const colon = header.indexOf(':');
  return colon === -1 ? header : header.slice(0, colon);
};

/**
 * Which `Host` headers this server answers to.
 *
 * Binding to loopback stops packets from the LAN, but not a browser on the Pi
 * itself: a page from anywhere can point a name it controls at 127.0.0.1 (DNS
 * rebinding) and then talk to this server same-origin, with no preflight to
 * stop it. Checking the name the request asked for closes that, and costs one
 * string comparison.
 *
 * An operator who binds a real interface has explicitly opted out of the
 * loopback posture, so the default there is to answer to anything; naming
 * `allowedHosts` is how you get the check back.
 */
const hostChecker = (
  bindHost: string,
  allowedHosts: readonly string[] | undefined,
): ((header: string | undefined) => boolean) => {
  if (allowedHosts !== undefined) {
    const allowed = new Set(allowedHosts);
    return (header) => allowed.has(hostnameOf(header ?? ''));
  }
  if (!isLoopbackName(bindHost)) return () => true;
  return (header) => isLoopbackName(hostnameOf(header ?? ''));
};

/**
 * Failure kind to status code.
 *
 * Chosen by what the UI does about it, the same axis the taxonomy itself is
 * built on: 409 for "no active device" because the request was valid and the
 * remedy is to pick a device, 502 for anything that went wrong upstream
 * because the device did nothing wrong, and 400 for `unexpected` because by
 * the time one reaches here it means a value we sent was rejected.
 */
const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  auth: 401,
  'not-premium': 403,
  forbidden: 403,
  'no-active-device': 409,
  'rate-limited': 429,
  network: 502,
  server: 502,
  unexpected: 400,
};

type Body = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Body =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {};

const wrongType = (key: string, expected: string): JoshifyError =>
  createError('unexpected', `${key} must be ${expected}`);

const requireNumber = (body: Body, key: string): Result<number, JoshifyError> => {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? ok(value)
    : err(wrongType(key, 'a finite number'));
};

const requireBoolean = (body: Body, key: string): Result<boolean, JoshifyError> => {
  const value = body[key];
  return typeof value === 'boolean' ? ok(value) : err(wrongType(key, 'a boolean'));
};

const requireString = (body: Body, key: string): Result<string, JoshifyError> => {
  const value = body[key];
  return typeof value === 'string' && value !== ''
    ? ok(value)
    : err(wrongType(key, 'a non-empty string'));
};

const optionalString = (
  body: Body,
  key: string,
): Result<string | undefined, JoshifyError> =>
  body[key] === undefined ? ok(undefined) : requireString(body, key);

const optionalBoolean = (
  body: Body,
  key: string,
): Result<boolean | undefined, JoshifyError> =>
  body[key] === undefined ? ok(undefined) : requireBoolean(body, key);

const optionalNumber = (
  body: Body,
  key: string,
): Result<number | undefined, JoshifyError> =>
  body[key] === undefined ? ok(undefined) : requireNumber(body, key);

const optionalUris = (
  body: Body,
): Result<readonly string[] | undefined, JoshifyError> => {
  const value = body['uris'];
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return err(wrongType('uris', 'an array of strings'));
  }
  return ok(value as readonly string[]);
};

/** Spotify takes one shape or the other, never both (P2-06). */
const optionalOffset = (body: Body): Result<PlayOffset | undefined, JoshifyError> => {
  const value = body['offset'];
  if (value === undefined) return ok(undefined);
  const offset = asRecord(value);
  const position = offset['position'];
  if (typeof position === 'number') return ok({ position });
  const uri = offset['uri'];
  if (typeof uri === 'string') return ok({ uri });
  return err(wrongType('offset', 'either { position } or { uri }'));
};

const readTarget = (body: Body): Result<CommandTarget, JoshifyError> => {
  const deviceId = optionalString(body, 'deviceId');
  return deviceId.ok ? ok({ deviceId: deviceId.value }) : err(deviceId.error);
};

const readPlayOptions = (body: Body): Result<PlayOptions, JoshifyError> => {
  const target = readTarget(body);
  if (!target.ok) return err(target.error);
  const contextUri = optionalString(body, 'contextUri');
  if (!contextUri.ok) return err(contextUri.error);
  const uris = optionalUris(body);
  if (!uris.ok) return err(uris.error);
  const offset = optionalOffset(body);
  if (!offset.ok) return err(offset.error);
  const positionMs = optionalNumber(body, 'positionMs');
  if (!positionMs.ok) return err(positionMs.error);

  return ok({
    deviceId: target.value.deviceId,
    contextUri: contextUri.value,
    uris: uris.value,
    offset: offset.value,
    positionMs: positionMs.value,
  });
};

type CommandResult = Result<void, JoshifyError>;

/**
 * A route's whole job: turn a JSON body into one command call.
 *
 * Validation failures come back through the same `Err` channel as Spotify's
 * own rejections, so there is a single path from "this did not work" to a
 * status code — and a malformed body can never reach Spotify.
 */
type Dispatch = (commands: SpotifyCommands, body: Body) => Promise<CommandResult>;

const withTarget = (
  run: (commands: SpotifyCommands, target: CommandTarget) => Promise<CommandResult>,
): Dispatch => {
  return async (commands, body) => {
    const target = readTarget(body);
    return target.ok ? await run(commands, target.value) : err(target.error);
  };
};

const COMMAND_ROUTES: Readonly<Record<string, Dispatch>> = {
  play: async (commands, body) => {
    const options = readPlayOptions(body);
    return options.ok ? await commands.play(options.value) : err(options.error);
  },
  pause: withTarget((commands, target) => commands.pause(target)),
  next: withTarget((commands, target) => commands.next(target)),
  previous: withTarget((commands, target) => commands.previous(target)),
  seek: async (commands, body) => {
    const target = readTarget(body);
    if (!target.ok) return err(target.error);
    const positionMs = requireNumber(body, 'positionMs');
    return positionMs.ok
      ? await commands.seek(positionMs.value, target.value)
      : err(positionMs.error);
  },
  volume: async (commands, body) => {
    const target = readTarget(body);
    if (!target.ok) return err(target.error);
    const volumePercent = requireNumber(body, 'volumePercent');
    return volumePercent.ok
      ? await commands.setVolume(volumePercent.value, target.value)
      : err(volumePercent.error);
  },
  shuffle: async (commands, body) => {
    const target = readTarget(body);
    if (!target.ok) return err(target.error);
    const enabled = requireBoolean(body, 'enabled');
    return enabled.ok
      ? await commands.setShuffle(enabled.value, target.value)
      : err(enabled.error);
  },
  repeat: async (commands, body) => {
    const target = readTarget(body);
    if (!target.ok) return err(target.error);
    const mode = requireString(body, 'mode');
    if (!mode.ok) return err(mode.error);
    if (mode.value !== 'off' && mode.value !== 'track' && mode.value !== 'context') {
      return err(wrongType('mode', 'one of off, track, context'));
    }
    return await commands.setRepeat(mode.value, target.value);
  },
  transfer: async (commands, body) => {
    const deviceId = requireString(body, 'deviceId');
    if (!deviceId.ok) return err(deviceId.error);
    const play = optionalBoolean(body, 'play');
    return play.ok
      ? await commands.transferPlayback(deviceId.value, { play: play.value })
      : err(play.error);
  },
};

/**
 * The part of a `ws` socket this route touches.
 *
 * `ws` ships no types of its own and `@types/ws` is not a dependency here, so
 * the socket handed to the handler arrives untyped. Rather than add a
 * dependency for four members, the four are declared: `send` and three events
 * is the entire surface, and writing it down means a change to it is a
 * compile error rather than a silent `any`.
 */
interface SocketEvents {
  message: [raw: unknown];
  close: [];
  error: [];
}

export interface KioskSocket {
  readonly send: (payload: string) => void;
  readonly on: <E extends keyof SocketEvents>(
    event: E,
    listener: (...args: SocketEvents[E]) => void,
  ) => void;
}

export const createHttpServer = async (
  config: HttpServerConfig,
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: config.logger ?? false });
  await app.register(websocketPlugin);

  const { broadcaster, commands } = config;
  const isAllowedHost = hostChecker(config.host ?? DEFAULT_HOST, config.allowedHosts);

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host)) {
      await reply
        .code(403)
        .send({ error: { kind: 'forbidden', message: 'host not served' } });
    }
  });

  const heartbeat = setInterval(() => {
    broadcaster.heartbeat();
  }, config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  // The timer must never be the reason the process stays up, and it must not
  // outlive a server a test closed.
  heartbeat.unref();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(heartbeat);
    done();
  });

  // Cheap enough for the UI's reconnect loop to poll while the socket is down.
  app.get('/health', () => ({
    status: 'ok',
    version: broadcaster.getVersion(),
    subscribers: broadcaster.subscriberCount(),
  }));

  /**
   * The same envelope a WebSocket snapshot carries, so a client that fell back
   * to HTTP while reconnecting ends up holding exactly what a socket would
   * have given it (P2-09).
   *
   * Reads the state the poller last stored; it never triggers a Spotify call
   * of its own, because a UI that refetched on every mount would spend the
   * rate limit the commands need.
   */
  app.get('/api/state', () => ({
    version: broadcaster.getVersion(),
    state: broadcaster.getState(),
  }));

  for (const [name, dispatch] of Object.entries(COMMAND_ROUTES)) {
    app.post(`/api/playback/${name}`, async (request, reply) => {
      const result = await dispatch(commands, asRecord(request.body));
      if (result.ok) {
        // 202, not 200: Spotify has accepted the command, but the playback
        // state that proves it arrives later on the socket. The UI should be
        // showing its optimistic update (P2-05), not waiting on this.
        return await reply.code(202).send({ status: 'accepted' });
      }
      const { error } = result;
      if (error.retryAfterMs !== undefined) {
        void reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
      }
      return await reply.code(STATUS_BY_KIND[error.kind]).send({
        error: { kind: error.kind, message: error.message, retryable: error.retryable },
      });
    });
  }

  app.get(WEBSOCKET_PATH, { websocket: true }, (socket: KioskSocket) => {
    const subscription = broadcaster.subscribe({
      send: (payload) => {
        socket.send(payload);
      },
    });
    socket.on('message', (raw) => {
      // Garbage on the wire is ignored rather than fatal: closing the socket
      // would blank a screen that is otherwise working, and the client's own
      // recovery path already covers everything a bad frame could mean.
      if (parseClientMessage(String(raw))?.type === 'resync') subscription.resync();
    });
    socket.on('close', () => {
      subscription.unsubscribe();
    });
    socket.on('error', () => {
      subscription.unsubscribe();
    });
  });

  return app;
};

export const startHttpServer = async (
  config: HttpServerConfig,
): Promise<RunningServer> => {
  const app = await createHttpServer(config);
  const host = config.host ?? DEFAULT_HOST;
  await app.listen({ host, port: config.port ?? DEFAULT_PORT });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('server bound to something that is not a TCP address');
  }
  const authority = host.includes(':') ? `[${host}]` : host;

  return {
    app,
    origin: `http://${authority}:${String(address.port)}`,
    host: address.address,
    port: address.port,
    close: () => app.close(),
  };
};
