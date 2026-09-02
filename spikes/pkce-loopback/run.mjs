/**
 * Spike P1-01 — does Authorization Code + PKCE actually work for Joshify?
 *
 * Runs the whole flow against a fake Spotify on loopback, with no real
 * credentials and no network. The fake verifies the PKCE binding for real:
 * it stores the challenge from /authorize and recomputes SHA-256 of the
 * verifier at /api/token, so a mismatched verifier is genuinely rejected.
 *
 *   node spikes/pkce-loopback/run.mjs
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildAuthorizeUrl,
  challengeFor,
  checkRedirectUri,
  createState,
  createVerifier,
} from '../../packages/core/dist/index.js';

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const b64url = (buf) => buf.toString('base64url');

const step = (n, msg) => console.log(`\x1b[36m${n}\x1b[0m ${msg}`);
const good = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg) => console.log(`    \x1b[90m${msg}\x1b[0m`);

/* ---------------- fake Spotify ---------------- */
const pending = new Map(); // code -> { challenge, redirectUri }

const fakeSpotify = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/authorize') {
    // The user has just approved. Mint a code bound to the challenge.
    const code = randomUUID();
    pending.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirectUri: url.searchParams.get('redirect_uri'),
    });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }

  if (url.pathname === '/api/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const record = pending.get(form.get('code'));
      const json = (status, payload) =>
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(payload));

      if (!record) return json(400, { error: 'invalid_grant' });
      pending.delete(form.get('code')); // codes are single-use

      // The actual PKCE check.
      const recomputed = b64url(
        createHash('sha256').update(form.get('code_verifier') ?? '').digest(),
      );
      if (recomputed !== record.challenge) {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'code_verifier does not match code_challenge',
        });
      }
      return json(200, {
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    return;
  }
  res.writeHead(404).end();
});

/* ---------------- the device's loopback listener ---------------- */
let resolveCallback;
const callbackReceived = new Promise((r) => (resolveCallback = r));

const loopback = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<h1>Joshify is connected.</h1><p>You can put your phone down.</p>',
  );
  resolveCallback({
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
  });
});

/* ---------------- the flow ---------------- */
const SPOTIFY_PORT = 9317;
const LOOPBACK_PORT = 9318;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

await listen(fakeSpotify, SPOTIFY_PORT);
await listen(loopback, LOOPBACK_PORT);

console.log('\n\x1b[1mP1-01 — Authorization Code + PKCE on a loopback redirect\x1b[0m\n');

try {
  step('1', 'Validate the redirect URI against Spotify\'s current rules');
  if (checkRedirectUri(REDIRECT_URI)) throw new Error('redirect rejected');
  good(`${REDIRECT_URI} accepted`);
  info('https is required since 2025-11-27, except for loopback literals');
  info(`http://localhost:${LOOPBACK_PORT}/callback would be rejected`);

  step('2', 'Generate the PKCE pair and CSRF state');
  const verifier = createVerifier();
  const challenge = await challengeFor(verifier);
  const state = createState();
  good(`verifier ${verifier.length} chars, S256 challenge ${challenge.length} chars`);

  step('3', 'Build the authorize URL the user opens');
  const authorizeUrl = buildAuthorizeUrl({
    clientId: 'spike-client',
    redirectUri: REDIRECT_URI,
    scopes: ['user-read-playback-state', 'user-modify-playback-state'],
    state,
    codeChallenge: challenge,
    authorizeEndpoint: `http://127.0.0.1:${SPOTIFY_PORT}/authorize`,
  });
  good('authorize URL built');

  step('4', 'User approves in a browser; Spotify redirects to the device');
  const approval = await fetch(authorizeUrl, { redirect: 'follow' });
  if (!approval.ok) throw new Error(`approval failed: ${approval.status}`);
  const callback = await callbackReceived;
  good('loopback listener received the redirect');

  step('5', 'Verify the state matches (CSRF defence)');
  if (callback.state !== state) throw new Error('state mismatch');
  good('state matches');

  step('6', 'Exchange the code for tokens, proving possession of the verifier');
  const tokenRes = await fetch(`http://127.0.0.1:${SPOTIFY_PORT}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: REDIRECT_URI,
      client_id: 'spike-client',
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  good(`got access + refresh tokens, expires_in ${tokens.expires_in}`);
  info('no client secret was used anywhere in this flow');

  step('7', 'Confirm a wrong verifier is actually rejected');
  const replay = await fetch(`http://127.0.0.1:${SPOTIFY_PORT}/authorize?` +
    new URLSearchParams({
      code_challenge: challenge,
      redirect_uri: REDIRECT_URI,
      state,
    }), { redirect: 'manual' });
  const replayCode = new URL(replay.headers.get('location')).searchParams.get('code');
  const bad = await fetch(`http://127.0.0.1:${SPOTIFY_PORT}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: replayCode,
      code_verifier: createVerifier(),
    }),
  });
  if (bad.ok) throw new Error('a wrong verifier was accepted — PKCE is not binding');
  good(`rejected with ${bad.status} ${(await bad.json()).error}`);

  console.log('\n\x1b[32m\x1b[1mPASS\x1b[0m — PKCE over a loopback redirect works end to end.\n');
} finally {
  await close(fakeSpotify);
  await close(loopback);
}
