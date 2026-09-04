/**
 * Where the refresh token lives between reboots.
 *
 * The Pi is an appliance: it boots unattended into a kiosk, with nobody
 * present to type anything. So the token set has to survive a power cut, and
 * it has to come back without a prompt. That shapes everything below —
 * encryption with a key the machine can fetch by itself, and writes that a
 * yanked power lead cannot leave half-finished.
 *
 * ## What the encryption actually buys
 *
 * The key sits in a `0600` file next to the ciphertext, so anything that can
 * read the key can read the tokens. That is not security theatre, but it is a
 * narrow guarantee, and it is worth stating plainly rather than implying
 * something stronger:
 *
 * - **Protects against** the token leaking sideways — an SD card pulled and
 *   mounted on another machine (the card is not encrypted, but a `0600` file
 *   is not in a tarball or a `cp -r` of `~/joshify` either), an rsync backup,
 *   a support bundle, a screenshot of `cat`. Those are the realistic ways a
 *   token escapes a device sitting on a shelf, and separating the secret from
 *   its key means a copy of one file is worthless.
 * - **Does NOT protect against** an attacker with root, or with the kiosk
 *   user's account, on the running device. They read the key file and decrypt.
 *   Nothing storable on an unattended machine can prevent that: a device that
 *   can decrypt without a human present hands the same ability to anyone who
 *   becomes that device. A TPM would move the key, not remove the problem.
 *
 * The blast radius is bounded by Spotify, not by us: the worst case is
 * playback control on one account, revocable from the account page.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createError,
  err,
  ok,
  type JoshifyError,
  type Result,
  type TokenSet,
} from '@joshify/core';

const TOKEN_FILE = 'tokens.enc';
const KEY_FILE = 'tokens.key';

/** Owner-only. The kiosk user is the only account that ever needs these. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // The nonce length GCM is specified around; anything else is a footgun.
const ENVELOPE_VERSION = 1;

/**
 * Bound into the ciphertext as additional authenticated data.
 *
 * The version lives in cleartext so a future reader can dispatch on it, which
 * means it is also editable. Authenticating it stops a v2 file from being
 * relabelled as v1 and fed to whatever the v1 path does.
 */
const AAD = Buffer.from(`joshify-token-store-v${String(ENVELOPE_VERSION)}`, 'utf8');

export interface TokenStoreOptions {
  /** Directory the store owns. Created on first write if absent. */
  readonly dataDir: string;
}

export interface TokenStore {
  /** `ok(null)` when nothing is stored yet — a first run is not a failure. */
  load(): Promise<Result<TokenSet | null, JoshifyError>>;
  save(tokens: TokenSet): Promise<Result<void, JoshifyError>>;
  clear(): Promise<Result<void, JoshifyError>>;
}

/** Node puts its `errno` string on `code`; nothing else in the stack does. */
const codeOf = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !('code' in cause)) return undefined;
  const { code } = cause;
  return typeof code === 'string' ? code : undefined;
};

const ioError = (message: string, cause: unknown): JoshifyError =>
  createError('unexpected', message, { cause });

/**
 * Anything that makes the stored token unrecoverable is an `auth` failure.
 *
 * Corruption, a tampered file and a missing key all lead to exactly one
 * action — start the authorize flow again — which is what `auth` already
 * means to the rest of the app. Filesystem errors deliberately do *not* map
 * here: a permission problem that presents as "please log in again" sends the
 * device round a re-auth loop that cannot fix it.
 */
const unrecoverable = (message: string, cause?: unknown): JoshifyError =>
  createError('auth', message, cause === undefined ? {} : { cause });

/**
 * `rename` swaps the directory entry atomically, but the entry itself is not
 * durable until the *directory* is flushed. Without this, a power cut can lose
 * the rename even though the file's own bytes were fsynced. Not every platform
 * allows opening a directory, so this is best-effort by design.
 */
const syncDirectory = async (dir: string): Promise<void> => {
  let handle: FileHandle;
  try {
    handle = await open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Best effort; the data write itself already succeeded.
  } finally {
    await handle.close();
  }
};

/**
 * Write-temp, fsync, rename — the sequence that makes a half-written file
 * impossible. The Pi is a device people unplug, so a reader must always find
 * either the complete old file or the complete new one.
 *
 * The temp file is created in the target directory because `rename` is only
 * atomic within a filesystem, and it is unlinked on failure so a crashed save
 * leaves no litter behind.
 */
const writeAtomic = async (dir: string, name: string, data: string): Promise<void> => {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx', FILE_MODE);
    try {
      await handle.writeFile(data, 'utf8');
      // `open`'s mode is masked by the process umask, so it is a request, not
      // a guarantee. This is the guarantee.
      await handle.chmod(FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, join(dir, name));
  } catch (cause) {
    await rm(tmp, { force: true });
    throw cause;
  }
  await syncDirectory(dir);
};

/** `null` when there is no usable key — absent, truncated, or not base64. */
const readKey = async (path: string): Promise<Buffer | null> => {
  let stored: string;
  try {
    stored = await readFile(path, 'utf8');
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return null;
    throw cause;
  }
  // Buffer.from silently drops invalid base64 characters, so the length check
  // is what actually rejects a garbage key file.
  const key = Buffer.from(stored.trim(), 'base64');
  return key.byteLength === KEY_BYTES ? key : null;
};

/**
 * Created with `wx` rather than the atomic-rename dance used for tokens.
 *
 * Two processes starting at once must not install *different* keys: whoever
 * lost the race would have already sealed a token file the winner's key cannot
 * open. Exclusive creation makes the create itself the thing that races, and
 * the loser adopts the winner's key instead of clobbering it.
 */
const createKey = async (path: string): Promise<Buffer | null> => {
  const key = randomBytes(KEY_BYTES);
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx', FILE_MODE);
  } catch (cause) {
    if (codeOf(cause) !== 'EEXIST') throw cause;
    return readKey(path);
  }
  try {
    await handle.writeFile(key.toString('base64'), 'utf8');
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return key;
};

interface Envelope {
  readonly v: number;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

const seal = (key: Buffer, plaintext: string): string => {
  // A fresh nonce per write. Reusing one under the same key is the single
  // catastrophic mistake available in GCM, and saves happen on every refresh.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(envelope);
};

const readEnvelope = (raw: string): Envelope | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const { v, iv, tag, ct } = fields;
  if (v !== ENVELOPE_VERSION) return null;
  if (typeof iv !== 'string' || typeof tag !== 'string' || typeof ct !== 'string') {
    return null;
  }
  return { v, iv, tag, ct };
};

/** Throws on any tampering; the GCM tag check is the whole point of it. */
const unseal = (key: Buffer, envelope: Envelope): string => {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== 16) {
    throw new Error('envelope header has the wrong shape');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    // Throws here when the tag does not match — a modified file never
    // reaches the caller as data.
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
};

const asStringArray = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  // Retyped away from the `any[]` Array.isArray leaves behind, so `every`'s
  // inferred predicate does the narrowing instead of a cast.
  const items: unknown[] = value;
  return items.every((item) => typeof item === 'string') ? items : null;
};

/**
 * Decrypted bytes are still untrusted input: an older Joshify may have written
 * a different shape, and a mismatch should read as "log in again", not as a
 * `TokenSet` with `undefined` where the refresh token belongs.
 */
const parseStoredTokens = (plaintext: string): TokenSet | null => {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { accessToken, refreshToken, expiresAt, refreshAt } = raw;
  const scopes = asStringArray(raw['scopes']);

  if (typeof accessToken !== 'string' || accessToken === '') return null;
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (typeof refreshAt !== 'number' || !Number.isFinite(refreshAt)) return null;
  if (scopes === null) return null;

  return { accessToken, refreshToken, expiresAt, refreshAt, scopes };
};

export const createTokenStore = (options: TokenStoreOptions): TokenStore => {
  const tokenPath = join(options.dataDir, TOKEN_FILE);
  const keyPath = join(options.dataDir, KEY_FILE);

  const load = async (): Promise<Result<TokenSet | null, JoshifyError>> => {
    let raw: string;
    try {
      raw = await readFile(tokenPath, 'utf8');
    } catch (cause) {
      // Read the token file before touching the key, so a first boot answers
      // "nothing stored" without leaving a key file behind for a token that
      // may never be written.
      if (codeOf(cause) === 'ENOENT') return ok(null);
      return err(ioError(`could not read ${tokenPath}`, cause));
    }

    let key: Buffer | null;
    try {
      key = await readKey(keyPath);
    } catch (cause) {
      return err(ioError(`could not read ${keyPath}`, cause));
    }
    if (key === null) {
      return err(unrecoverable('stored token has no usable key file'));
    }

    const envelope = readEnvelope(raw);
    if (envelope === null) {
      return err(unrecoverable('stored token file is corrupt'));
    }

    let plaintext: string;
    try {
      plaintext = unseal(key, envelope);
    } catch (cause) {
      return err(unrecoverable('stored token failed authentication', cause));
    }

    const tokens = parseStoredTokens(plaintext);
    if (tokens === null) {
      return err(unrecoverable('stored token is not a usable token set'));
    }
    return ok(tokens);
  };

  const save = async (tokens: TokenSet): Promise<Result<void, JoshifyError>> => {
    try {
      await mkdir(options.dataDir, { recursive: true, mode: DIR_MODE });
      let key = await readKey(keyPath);
      key ??= await createKey(keyPath);
      if (key === null) {
        // A key file that exists but is unusable is not ours to replace:
        // overwriting it would orphan a token file we cannot read either.
        return err(ioError(`${keyPath} exists but is not a usable key`, null));
      }
      await writeAtomic(options.dataDir, TOKEN_FILE, seal(key, JSON.stringify(tokens)));
      return ok(undefined);
    } catch (cause) {
      return err(ioError(`could not save tokens to ${tokenPath}`, cause));
    }
  };

  /**
   * Signing out drops the key along with the ciphertext.
   *
   * Keeping the key would leave every old backup of `tokens.enc` decryptable
   * by a file still sitting on the device. Dropping it costs nothing — the
   * next `save` mints a fresh one — and retires the whole history at once.
   */
  const clear = async (): Promise<Result<void, JoshifyError>> => {
    try {
      await rm(tokenPath, { force: true });
      await rm(keyPath, { force: true });
      return ok(undefined);
    } catch (cause) {
      return err(ioError(`could not clear ${tokenPath}`, cause));
    }
  };

  return { load, save, clear };
};
