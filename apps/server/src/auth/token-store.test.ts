import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isErr, isOk, type TokenSet } from '@joshify/core';
import { createTokenStore } from './token-store.js';

const TOKENS: TokenSet = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-xyz',
  expiresAt: 1_700_000_003_600_000,
  refreshAt: 1_700_000_002_880_000,
  scopes: ['user-read-playback-state', 'user-modify-playback-state'],
};

let dataDir: string;
const tokenFile = () => join(dataDir, 'tokens.enc');
const keyFile = () => join(dataDir, 'tokens.key');

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'joshify-token-store-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('createTokenStore', () => {
  it('round trips every field of a token set', async () => {
    const store = createTokenStore({ dataDir });

    expect(isOk(await store.save(TOKENS))).toBe(true);
    const loaded = await store.load();

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toEqual(TOKENS);
  });

  it('survives a restart: a new store instance reads what the old one wrote', async () => {
    // The whole point of the module. A fresh process must derive nothing and
    // prompt for nothing — the key file is the only thing carrying it over.
    await createTokenStore({ dataDir }).save(TOKENS);

    const loaded = await createTokenStore({ dataDir }).load();

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toEqual(TOKENS);
  });

  it('returns ok(null) when nothing has been stored yet', async () => {
    const loaded = await createTokenStore({ dataDir }).load();

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toBeNull();
  });

  it('does not create a key file just because load() was called', async () => {
    // A first boot that never completes authorize should leave the data dir
    // exactly as it found it.
    await createTokenStore({ dataDir }).load();

    expect(await readdir(dataDir)).toEqual([]);
  });

  it('creates the data directory if it does not exist', async () => {
    const nested = join(dataDir, 'nested', 'joshify');
    const store = createTokenStore({ dataDir: nested });

    expect(isOk(await store.save(TOKENS))).toBe(true);
    expect(isOk(await store.load())).toBe(true);
  });

  it('does not write the access token to disk in cleartext', async () => {
    await createTokenStore({ dataDir }).save(TOKENS);

    const onDisk = await readFile(tokenFile(), 'utf8');

    expect(onDisk).not.toContain(TOKENS.accessToken);
    expect(onDisk).not.toContain(TOKENS.refreshToken);
  });

  it('stores both files 0600', async () => {
    // If these ever widen, the threat model in token-store.ts is void: the
    // protection is entirely "another account cannot read these two files".
    await createTokenStore({ dataDir }).save(TOKENS);

    expect(await modeOf(tokenFile())).toBe(0o600);
    expect(await modeOf(keyFile())).toBe(0o600);
  });

  it('leaves no temp file behind after a successful save', async () => {
    // A stale .tmp means the rename path was skipped, which means the write
    // was not atomic after all.
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await store.save({ ...TOKENS, accessToken: 'access-second' });

    const entries = await readdir(dataDir);

    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(entries.toSorted()).toEqual(['tokens.enc', 'tokens.key']);
  });

  it('overwrites a previous token set rather than appending', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await store.save({ ...TOKENS, accessToken: 'access-second' });

    const loaded = await store.load();

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value?.accessToken).toBe('access-second');
  });

  it('rejects a tampered ciphertext instead of returning altered data', async () => {
    // Proves the GCM auth tag is actually being checked. Without setAuthTag
    // this test is the one that fails: AES-CTR-shaped ciphertext decrypts to
    // *something* for any key, so a flipped byte would otherwise surface as
    // silently corrupted plaintext rather than an error.
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);

    const envelope = JSON.parse(await readFile(tokenFile(), 'utf8')) as {
      ct: string;
    };
    const ct = Buffer.from(envelope.ct, 'base64');
    ct.writeUInt8(ct.readUInt8(0) ^ 0x01, 0);
    await writeFile(
      tokenFile(),
      JSON.stringify({ ...envelope, ct: ct.toString('base64') }),
    );

    const loaded = await store.load();

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('auth');
  });

  it('rejects a tampered auth tag', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);

    const envelope = JSON.parse(await readFile(tokenFile(), 'utf8')) as {
      tag: string;
    };
    const tag = Buffer.from(envelope.tag, 'base64');
    tag.writeUInt8(tag.readUInt8(0) ^ 0x01, 0);
    await writeFile(
      tokenFile(),
      JSON.stringify({ ...envelope, tag: tag.toString('base64') }),
    );

    expect(isErr(await store.load())).toBe(true);
  });

  it('rejects a truncated file', async () => {
    // What a power cut used to produce before writes went through rename.
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    const whole = await readFile(tokenFile(), 'utf8');
    await writeFile(tokenFile(), whole.slice(0, Math.floor(whole.length / 2)));

    const loaded = await store.load();

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('auth');
  });

  it('rejects garbage bytes', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await writeFile(tokenFile(), Buffer.from([0x00, 0xff, 0x10, 0x9a, 0x42]));

    expect(isErr(await store.load())).toBe(true);
  });

  it('rejects a file encrypted under a different key', async () => {
    // The SD-card case: ciphertext copied off one device is inert on another,
    // because the key never travels with it.
    const other = await mkdtemp(join(tmpdir(), 'joshify-token-store-'));
    try {
      await createTokenStore({ dataDir: other }).save(TOKENS);
      await createTokenStore({ dataDir }).save(TOKENS);
      await writeFile(tokenFile(), await readFile(join(other, 'tokens.enc')));

      expect(isErr(await createTokenStore({ dataDir }).load())).toBe(true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('rejects a correctly sealed payload that is not a token set', async () => {
    // Guards the upgrade path: an older release's schema decrypts perfectly
    // and is still unusable, and must read as "log in again" rather than a
    // TokenSet with undefined where the refresh token belongs.
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    const key = Buffer.from((await readFile(keyFile(), 'utf8')).trim(), 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('joshify-token-store-v1', 'utf8'));
    const ct = Buffer.concat([
      cipher.update(JSON.stringify({ accessToken: 'access-abc' }), 'utf8'),
      cipher.final(),
    ]);
    await writeFile(
      tokenFile(),
      JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
      }),
    );

    const loaded = await store.load();

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('auth');
  });

  it('rejects an envelope claiming an unknown format version', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    const envelope = JSON.parse(await readFile(tokenFile(), 'utf8')) as object;
    await writeFile(tokenFile(), JSON.stringify({ ...envelope, v: 99 }));

    expect(isErr(await store.load())).toBe(true);
  });

  it('reports an unusable key file without destroying it', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await writeFile(keyFile(), 'not-a-key');

    const loaded = await store.load();

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('auth');
    // A save must not paper over it by minting a new key, which would leave
    // the existing ciphertext permanently unreadable.
    expect(isErr(await store.save(TOKENS))).toBe(true);
    expect(await readFile(keyFile(), 'utf8')).toBe('not-a-key');
  });

  it('treats a missing key file as a re-authenticate, not a crash', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await rm(keyFile());

    const loaded = await store.load();

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('auth');
  });

  it('clear() removes the stored token and load() goes back to ok(null)', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);

    expect(isOk(await store.clear())).toBe(true);

    const loaded = await store.load();
    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toBeNull();
    // The key goes too, so old backups of tokens.enc stay inert.
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('clear() on an empty store succeeds', async () => {
    expect(isOk(await createTokenStore({ dataDir }).clear())).toBe(true);
  });

  it('can save again after a clear', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    await store.clear();

    expect(isOk(await store.save(TOKENS))).toBe(true);
    const loaded = await store.load();
    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toEqual(TOKENS);
  });

  it('keeps the previous token set when a save cannot complete', async () => {
    // Atomicity's user-visible promise: a failed write never costs you the
    // credentials you already had.
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    const readOnly = createTokenStore({ dataDir: join(dataDir, 'tokens.enc') });

    expect(isErr(await readOnly.save(TOKENS))).toBe(true);

    const loaded = await store.load();
    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value).toEqual(TOKENS);
  });
});

describe('filesystem faults degrade instead of throwing', () => {
  // These paths matter more than they look: an unhandled throw here happens
  // during kiosk boot, where there is nobody to read a stack trace. Returning
  // an Err lets the UI show something; throwing takes the whole device down.

  it('reports an unreadable key file rather than throwing', async () => {
    const store = createTokenStore({ dataDir });
    await store.save(TOKENS);
    // A directory where the key belongs makes readFile fail with EISDIR —
    // a stand-in for any I/O fault, and one that works even running as root.
    await rm(join(dataDir, 'tokens.key'));
    await mkdir(join(dataDir, 'tokens.key'));

    const result = await store.load();

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // An I/O fault is not "log in again" — re-authorising cannot fix a disk.
    expect(result.error.kind).toBe('unexpected');
  });

  it('reports a failed clear rather than throwing', async () => {
    const store = createTokenStore({ dataDir });
    await mkdir(join(dataDir, 'tokens.enc'), { recursive: true });
    await writeFile(join(dataDir, 'tokens.enc', 'blocker'), 'x');

    const result = await store.clear();

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('unexpected');
  });
});
