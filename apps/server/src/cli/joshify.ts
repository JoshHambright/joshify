/**
 * `joshify` — the first-run command line.
 *
 * Deliberately thin. The interesting logic is in `runAuthFlow` and the token
 * store, both tested directly; this only reads configuration, prints something
 * a human can act on, and persists the result.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isExpired, needsRefresh } from '@joshify/core';
import { runAuthFlow } from '../auth/auth-flow.js';
import { createTokenStore } from '../auth/token-store.js';

export const DEFAULT_PORT = 8080;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly openBrowser: (url: string) => void;
}

const openWithDesktop = (url: string): void => {
  // Best effort. On the Pi the kiosk browser is already up; on a dev machine
  // this saves a copy-paste. A failure is not worth reporting, because the URL
  // is printed anyway.
  try {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
};

export const defaultIo: CliIo = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
  openBrowser: openWithDesktop,
};

export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env['JOSHIFY_DATA_DIR'] ?? join(env['HOME'] ?? homedir(), '.joshify');

const USAGE = `joshify — Spotify control surface

  joshify auth     Connect a Spotify account (run once)
  joshify status   Show whether an account is connected
  joshify logout   Forget the stored account`;

export const main = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo = defaultIo,
): Promise<number> => {
  const command = argv[0];
  const store = createTokenStore({ dataDir: defaultDataDir(env) });

  if (command === 'status') {
    const stored = await store.load();
    if (!stored.ok) {
      io.err(`Could not read stored credentials: ${stored.error.message}`);
      return 1;
    }
    if (stored.value === null) {
      io.out('Not connected. Run `joshify auth`.');
      return 1;
    }
    const now = Date.now();
    io.out('Connected.');
    io.out(`  Access token ${isExpired(stored.value, now) ? 'expired' : 'valid'}`);
    io.out(`  Refresh ${needsRefresh(stored.value, now) ? 'due now' : 'not yet due'}`);
    io.out(`  Scopes: ${stored.value.scopes.join(', ')}`);
    return 0;
  }

  if (command === 'logout') {
    const cleared = await store.clear();
    if (!cleared.ok) {
      io.err(`Could not clear credentials: ${cleared.error.message}`);
      return 1;
    }
    io.out('Forgotten. Run `joshify auth` to connect again.');
    return 0;
  }

  if (command !== 'auth') {
    io.err(USAGE);
    return command === undefined ? 1 : 2;
  }

  const clientId = env['SPOTIFY_CLIENT_ID'];
  if (clientId === undefined || clientId === '') {
    io.err('SPOTIFY_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
    io.err('The Client ID is not secret; there is no client secret to set.');
    return 1;
  }

  const port = Number(env['JOSHIFY_PORT'] ?? DEFAULT_PORT);
  const result = await runAuthFlow({
    clientId,
    port,
    onPrompt: (url) => {
      io.out('Opening Spotify to authorise this device.');
      io.out('If nothing opens, visit:');
      io.out(`  ${url}`);
      io.openBrowser(url);
    },
  });

  if (!result.ok) {
    io.err(`Authorisation failed: ${result.error.message}`);
    return 1;
  }

  const saved = await store.save(result.value.tokens);
  if (!saved.ok) {
    io.err(`Authorised, but could not save credentials: ${saved.error.message}`);
    return 1;
  }

  const { profile } = result.value;
  io.out(`Connected as ${profile.displayName ?? profile.id}.`);

  if (!profile.isPremium) {
    // Better to say so now than to let every transport control fail with a 403
    // the user cannot interpret.
    io.err('');
    io.err('This account does not have Spotify Premium.');
    io.err('Joshify can display what is playing, but every playback control');
    io.err('will be refused by Spotify until the account has Premium.');
    return 1;
  }

  io.out('Ready.');
  return 0;
};
