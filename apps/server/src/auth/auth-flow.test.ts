import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOk } from '@joshify/core';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { runAuthFlow } from './auth-flow.js';

let spotify: FakeSpotify;
let dataDir: string;

const options = (extra: Record<string, unknown> = {}) => ({
  clientId: 'client-123',
  port: 0, // ephemeral, so concurrent test runs cannot collide
  authorizeEndpoint: spotify.authorizeEndpoint,
  tokenEndpoint: spotify.tokenEndpoint,
  apiBaseUrl: spotify.origin,
  now: () => 1_700_000_000_000,
  ...extra,
});

/** Stands in for the human: opens the URL and follows Spotify's redirect. */
const approve = (url: string): void => {
  void fetch(url, { redirect: 'follow' }).catch(() => undefined);
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  // The fake mints `access-N` from a counter but guards its `/v1/` routes with
  // a separately configured token. Each test gets a fresh instance, so the
  // first exchange always issues `access-1`; line them up so the profile call
  // made at the end of the flow is accepted.
  spotify.validAccessToken = 'access-1';
  dataDir = await mkdtemp(join(tmpdir(), 'joshify-auth-'));
});
afterEach(async () => {
  await spotify.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('runAuthFlow', () => {
  it('completes the round trip and returns tokens plus profile', async () => {
    const result = await runAuthFlow(options({ onPrompt: approve }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.tokens.accessToken).toMatch(/^access-/);
    expect(result.value.tokens.refreshToken).toMatch(/^refresh-/);
    expect(result.value.profile.isPremium).toBe(true);
  });

  it('requests every scope Joshify needs', async () => {
    let seen: URL | undefined;
    await runAuthFlow(
      options({
        onPrompt: (url: string) => {
          seen = new URL(url);
          approve(url);
        },
      }),
    );
    const scopes = seen?.searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).toContain('user-read-playback-state');
    expect(scopes).toContain('user-modify-playback-state');
    // Never requested: Joshify does not modify saved music, and not holding
    // the permission is a stronger guarantee than promising not to use it.
    expect(scopes).not.toContain('user-library-modify');
    expect(scopes).not.toContain('playlist-modify-private');
  });

  it('uses PKCE and never sends a client secret', async () => {
    await runAuthFlow(options({ onPrompt: approve }));
    const tokenCall = spotify.requests.find((r) => r.path === '/api/token');
    expect(tokenCall?.form['code_verifier']).toBeDefined();
    expect(tokenCall?.form).not.toHaveProperty('client_secret');
  });

  // A callback whose state does not match did not come from our request, so
  // the code in it is not ours to spend.
  it('rejects a callback with a mismatched state', async () => {
    const result = await runAuthFlow(
      options({
        onPrompt: (url: string) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
          const forged = new URL(redirectUri);
          forged.searchParams.set('code', 'attacker-code');
          forged.searchParams.set('state', 'not-our-state');
          void fetch(forged).catch(() => undefined);
        },
      }),
    );
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.message).toContain('state');
  });

  it('reports a declined authorisation without saving anything', async () => {
    const result = await runAuthFlow(
      options({
        onPrompt: (url: string) => {
          const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
          const denied = new URL(redirectUri);
          denied.searchParams.set('error', 'access_denied');
          void fetch(denied).catch(() => undefined);
        },
      }),
    );
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('access_denied');
  });

  it('reports a redirect that carries neither code nor error', async () => {
    const result = await runAuthFlow(
      options({
        onPrompt: (url: string) => {
          const parsed = new URL(url);
          const bare = new URL(parsed.searchParams.get('redirect_uri') ?? '');
          // Correct state, so this gets past the CSRF check and exercises the
          // malformed-response path rather than short-circuiting earlier.
          bare.searchParams.set('state', parsed.searchParams.get('state') ?? '');
          void fetch(bare).catch(() => undefined);
        },
      }),
    );
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('without an authorization code');
  });

  // Without a deadline, a mistyped password leaves the process holding the
  // port forever and the next attempt fails with a confusing EADDRINUSE.
  it('gives up rather than waiting forever', async () => {
    const result = await runAuthFlow(
      options({ timeoutMs: 40, onPrompt: () => undefined }),
    );
    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('nothing was saved');
  });

  it('releases the port after a failure, so a retry can bind it', async () => {
    const first = await runAuthFlow(options({ port: 45_517, timeoutMs: 40 }));
    expect(isOk(first)).toBe(false);
    const second = await runAuthFlow(
      options({ port: 45_517, timeoutMs: 40, onPrompt: () => undefined }),
    );
    if (isOk(second)) throw new Error('expected failure');
    expect(second.error.message).not.toContain('already running');
  });

  it('explains a port already in use instead of crashing', async () => {
    // The realistic cause is Joshify already running as a service. A raw
    // EADDRINUSE stack trace tells the user nothing actionable.
    const blocker = createServer(() => undefined);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;

    const result = await runAuthFlow(options({ port, timeoutMs: 50 }));

    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });

    if (isOk(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('already running');
  });
});
