/**
 * First-run authorisation: PKCE against a loopback redirect.
 *
 * Spike P1-01 settled the shape. Spotify's Device Authorization Grant — the
 * flow built for appliances — is allowlisted to Spotify's own TV apps and
 * unavailable to a Dashboard client, so the device authorises in a browser on
 * the device itself. That works because the Pi is not headless: the redirect
 * target (127.0.0.1) and the browser are the same machine, so nothing has to
 * be transferred back by hand.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildAuthorizeUrl,
  challengeFor,
  createError,
  createState,
  createVerifier,
  err,
  ok,
  type JoshifyError,
  type Result,
  type TokenSet,
} from '@joshify/core';
import { createSpotifyClient, type SpotifyProfile } from '../spotify/client.js';
import { exchangeCode } from './token-client.js';
import { REQUIRED_SCOPES } from './scopes.js';

export interface AuthFlowOptions {
  readonly clientId: string;
  /** 0 binds an ephemeral port; production passes the registered 8080. */
  readonly port: number;
  readonly redirectPath?: string;
  readonly scopes?: readonly string[];
  readonly authorizeEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly apiBaseUrl?: string;
  /** Called with the authorize URL once the listener is up. */
  readonly onPrompt?: (url: string) => void;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface AuthFlowResult {
  readonly tokens: TokenSet;
  readonly profile: SpotifyProfile;
}

interface Callback {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const PAGE = (heading: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Joshify</title>` +
  `<body style="font-family:system-ui;background:#07060f;color:#ece9f7;` +
  `display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
  `<div><h1 style="color:#00e5ff">${heading}</h1><p>${detail}</p></div>`;

export const runAuthFlow = async (
  options: AuthFlowOptions,
): Promise<Result<AuthFlowResult, JoshifyError>> => {
  const redirectPath = options.redirectPath ?? '/callback';
  const scopes = options.scopes ?? REQUIRED_SCOPES;

  let settle: (callback: Callback) => void = () => undefined;
  const received = new Promise<Callback>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== redirectPath) {
      res.writeHead(404).end();
      return;
    }
    const failure = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      failure === null
        ? PAGE('Joshify is connected.', 'You can close this and put the phone down.')
        : PAGE(
            'Authorisation was declined.',
            'Nothing was saved. Run the command again to retry.',
          ),
    );
    settle({
      ...(url.searchParams.get('code') === null
        ? {}
        : { code: url.searchParams.get('code') as string }),
      ...(url.searchParams.get('state') === null
        ? {}
        : { state: url.searchParams.get('state') as string }),
      ...(failure === null ? {} : { error: failure }),
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
  } catch (cause) {
    return err(
      createError(
        'unexpected',
        `could not listen on 127.0.0.1:${String(options.port)} — is Joshify already running?`,
        { cause },
      ),
    );
  }

  try {
    const { port } = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${String(port)}${redirectPath}`;

    const verifier = createVerifier();
    const state = createState();
    const authorizeUrl = buildAuthorizeUrl({
      clientId: options.clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: await challengeFor(verifier),
      ...(options.authorizeEndpoint === undefined
        ? {}
        : { authorizeEndpoint: options.authorizeEndpoint }),
    });

    options.onPrompt?.(authorizeUrl);

    // Without a deadline a mistyped password leaves the process holding the
    // port forever, and the next attempt fails with a confusing EADDRINUSE.
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timedOut = Symbol('timeout');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => {
        resolve(timedOut);
      }, timeoutMs);
    });
    const outcome = await Promise.race([received, deadline]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === timedOut) {
      return err(
        createError(
          'auth',
          `no response within ${String(timeoutMs / 1000)}s; nothing was saved`,
        ),
      );
    }

    if (outcome.error !== undefined) {
      return err(createError('auth', `Spotify returned "${outcome.error}"`));
    }
    // A mismatched state means the callback did not come from the request we
    // made, so the code is not ours to spend.
    if (outcome.state !== state) {
      return err(createError('auth', 'state did not match; discarding the response'));
    }
    if (outcome.code === undefined) {
      return err(createError('auth', 'Spotify redirected without an authorization code'));
    }

    const tokens = await exchangeCode(
      {
        clientId: options.clientId,
        ...(options.tokenEndpoint === undefined
          ? {}
          : { tokenEndpoint: options.tokenEndpoint }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
      { code: outcome.code, codeVerifier: verifier, redirectUri },
    );
    if (!tokens.ok) return tokens;

    // Confirm the token works before persisting it, and surface a free account
    // now rather than at the first tap on play.
    const client = createSpotifyClient({
      tokenSource: {
        getAccessToken: () => Promise.resolve(ok(tokens.value.accessToken)),
        refreshAccessToken: () =>
          Promise.resolve(
            err(createError('auth', 'cannot refresh during first-run auth')),
          ),
      },
      ...(options.apiBaseUrl === undefined ? {} : { baseUrl: options.apiBaseUrl }),
    });
    const profile = await client.getProfile();
    if (!profile.ok) return profile;

    return ok({ tokens: tokens.value, profile: profile.value });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};
