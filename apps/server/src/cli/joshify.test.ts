import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenStore } from '../auth/token-store.js';
import { defaultDataDir, main, type CliIo } from './joshify.js';

let dataDir: string;
let out: string[];
let errs: string[];
const io = (): CliIo => ({
  out: (line) => out.push(line),
  err: (line) => errs.push(line),
  openBrowser: () => undefined,
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  JOSHIFY_DATA_DIR: dataDir,
  ...extra,
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'joshify-cli-'));
  out = [];
  errs = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('defaultDataDir', () => {
  it('honours an explicit override', () => {
    expect(defaultDataDir({ JOSHIFY_DATA_DIR: '/somewhere' })).toBe('/somewhere');
  });

  it('falls back to a dotfile in the home directory', () => {
    expect(defaultDataDir({ HOME: '/home/josh' })).toBe('/home/josh/.joshify');
  });
});

describe('status', () => {
  it('exits non-zero and says what to do when not connected', async () => {
    const code = await main(['status'], env(), io());
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('joshify auth');
  });

  it('reports a stored account', async () => {
    await createTokenStore({ dataDir }).save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      refreshAt: Date.now() + 2_880_000,
      scopes: ['user-read-playback-state'],
    });
    const code = await main(['status'], env(), io());
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Connected.');
    expect(out.join('\n')).toContain('user-read-playback-state');
  });
});

describe('logout', () => {
  it('clears a stored account', async () => {
    const store = createTokenStore({ dataDir });
    await store.save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 1000,
      refreshAt: Date.now() + 500,
      scopes: [],
    });
    expect(await main(['logout'], env(), io())).toBe(0);
    const after = await store.load();
    expect(after.ok && after.value).toBeNull();
  });
});

describe('auth', () => {
  // The Client ID is the only configuration; failing without a clear message
  // is the most likely first-run stumble.
  it('explains a missing client id, and that no secret is needed', async () => {
    const code = await main(['auth'], env(), io());
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('SPOTIFY_CLIENT_ID');
    expect(errs.join('\n')).toContain('no client secret');
  });

  it('treats an empty client id as missing', async () => {
    const code = await main(['auth'], env({ SPOTIFY_CLIENT_ID: '' }), io());
    expect(code).toBe(1);
  });
});

describe('usage', () => {
  it('prints usage for an unknown command', async () => {
    expect(await main(['wat'], env(), io())).toBe(2);
    expect(errs.join('\n')).toContain('joshify auth');
  });

  it('prints usage when given no command', async () => {
    expect(await main([], env(), io())).toBe(1);
  });
});
