/**
 * A stand-in for Spotify's auth endpoints, speaking the same shapes.
 *
 * This is what lets every test from here on run in CI with no credentials and
 * no network (P1-10). It is not a mock: it is a real HTTP server on loopback,
 * so the code under test does real `fetch` calls, real form encoding and real
 * status handling.
 *
 * It also verifies PKCE for real — the challenge is stored at `/authorize` and
 * SHA-256 of the verifier is recomputed at `/api/token` — so a test that
 * passes the wrong verifier genuinely fails.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly form: Readonly<Record<string, string>>;
}

export interface CannedFailure {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeSpotify {
  readonly origin: string;
  /** Bearer token the fake will accept. Change it to simulate expiry. */
  validAccessToken: string;
  /** Body served by `GET /v1/me/player`. `null` produces a 204, as Spotify does. */
  playbackState: unknown;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  /** Queue a canned failure for the next request. Queued failures pop in order. */
  failNext: (failure: CannedFailure) => void;
  /** Every request the fake has served, in order. */
  readonly requests: readonly RecordedRequest[];
  /** Refresh tokens the fake considers valid. Seeded with `refresh-seed`. */
  readonly validRefreshTokens: Set<string>;
  /** When true, refresh responses omit `refresh_token`, as Spotify often does. */
  omitRefreshTokenOnRefresh: boolean;
  close: () => Promise<void>;
}

const base64Url = (buffer: Buffer): string => buffer.toString('base64url');

export const startFakeSpotify = async (): Promise<FakeSpotify> => {
  const pendingCodes = new Map<string, { challenge: string | null }>();
  const failures: CannedFailure[] = [];
  const requests: RecordedRequest[] = [];
  const validRefreshTokens = new Set<string>(['refresh-seed']);
  let issued = 0;

  const state = {
    omitRefreshTokenOnRefresh: false,
    validAccessToken: 'access-seed',
    playbackState: null as unknown,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const form: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawBody)) form[key] = value;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, form });

      const json = (
        status: number,
        payload: unknown,
        headers: Record<string, string> = {},
      ) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      const failure = failures.shift();
      if (failure) {
        json(failure.status, failure.body ?? { error: { message: 'canned failure' } }, {
          ...failure.headers,
        });
        return;
      }

      // --- Web API endpoints, all bearer-authenticated ---
      if (url.pathname.startsWith('/v1/')) {
        const authorization = req.headers.authorization ?? '';
        if (authorization !== `Bearer ${state.validAccessToken}`) {
          json(401, { error: { status: 401, message: 'The access token expired' } });
          return;
        }

        if (url.pathname === '/v1/me') {
          json(200, { id: 'josh', display_name: 'Josh', product: 'premium' });
          return;
        }
        if (url.pathname === '/v1/me/player') {
          // Spotify answers 204 with no body when nothing is playing.
          if (state.playbackState === null) {
            res.writeHead(204);
            res.end();
            return;
          }
          json(200, state.playbackState);
          return;
        }
        if (url.pathname === '/v1/me/player/devices') {
          json(200, { devices: [{ id: 'dev-1', name: 'Kitchen', is_active: true }] });
          return;
        }
        res.writeHead(404);
        res.end();
        return;
      }

      if (url.pathname === '/authorize') {
        const code = randomUUID();
        pendingCodes.set(code, { challenge: url.searchParams.get('code_challenge') });
        const back = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1');
        back.searchParams.set('code', code);
        const requestState = url.searchParams.get('state');
        if (requestState !== null) back.searchParams.set('state', requestState);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }

      if (url.pathname === '/api/token' && req.method === 'POST') {
        issued += 1;
        const grantType = form['grant_type'];

        if (grantType === 'authorization_code') {
          const record = pendingCodes.get(form['code'] ?? '');
          if (!record) {
            json(400, { error: 'invalid_grant', error_description: 'unknown code' });
            return;
          }
          pendingCodes.delete(form['code'] ?? '');
          const recomputed = base64Url(
            createHash('sha256')
              .update(form['code_verifier'] ?? '')
              .digest(),
          );
          if (recomputed !== record.challenge) {
            json(400, {
              error: 'invalid_grant',
              error_description: 'code_verifier does not match code_challenge',
            });
            return;
          }
          json(200, {
            access_token: `access-${String(issued)}`,
            refresh_token: `refresh-${String(issued)}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'user-read-playback-state user-modify-playback-state',
          });
          return;
        }

        if (grantType === 'refresh_token') {
          const presented = form['refresh_token'] ?? '';
          if (!validRefreshTokens.has(presented)) {
            json(400, { error: 'invalid_grant', error_description: 'revoked' });
            return;
          }
          json(200, {
            access_token: `access-${String(issued)}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'user-read-playback-state user-modify-playback-state',
            ...(state.omitRefreshTokenOnRefresh
              ? {}
              : { refresh_token: `refresh-${String(issued)}` }),
          });
          return;
        }

        json(400, { error: 'unsupported_grant_type' });
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;

  return {
    origin,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/api/token`,
    failNext: (failure) => failures.push(failure),
    requests,
    validRefreshTokens,
    get validAccessToken() {
      return state.validAccessToken;
    },
    set validAccessToken(value: string) {
      state.validAccessToken = value;
    },
    get playbackState() {
      return state.playbackState;
    },
    set playbackState(value: unknown) {
      state.playbackState = value;
    },
    get omitRefreshTokenOnRefresh() {
      return state.omitRefreshTokenOnRefresh;
    },
    set omitRefreshTokenOnRefresh(value: boolean) {
      state.omitRefreshTokenOnRefresh = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
};
