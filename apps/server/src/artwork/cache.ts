/**
 * The on-disk artwork cache (P3-02).
 *
 * Two jobs, both shaped by the device rather than by the API: fetch each image
 * exactly once, and never let the cache become a problem for a machine that is
 * expected to run for months without anyone logging into it.
 *
 * ## Two sizes, for two different reasons
 *
 * Spotify offers the same cover at several widths. The **64px** variant is the
 * source for colour extraction and the blurred backdrop — 4,096 pixels, a
 * download measured in single-digit kilobytes, and everything downstream throws
 * away more detail than that anyway (PRODUCT.md §8.1). The **640px** variant is
 * fetched separately as the hero image the screen actually shows. Fetching one
 * and deriving the other would mean either processing 16× the pixels for the
 * theme or displaying a 64px cover full-screen; both sizes are cheap, so we
 * take both.
 *
 * ## A truncated cache file is worse than no cache file
 *
 * A half-written JPEG is not a smaller image, it is a decode error that repeats
 * on every boot, and the device would have no way to tell it apart from a
 * genuinely corrupt source. So writes go through the same temp-then-rename
 * sequence the token store uses (`auth/token-store.ts`): a reader finds either
 * the complete file or no file. The download is fully buffered before the write
 * begins, which is what makes that possible — an aborted transfer throws while
 * the bytes are still in memory and never reaches the disk at all.
 *
 * ## Growth is bounded, because nothing here ever prunes itself
 *
 * An appliance playing music all day accumulates covers forever. Every write
 * prunes the directory back to a bounded number of files and a bounded number
 * of bytes, evicting least-recently-*used* first — reads touch the file's mtime,
 * so an album on heavy rotation survives while one played once in March does
 * not. Eviction is always safe: the worst case is refetching a few kilobytes.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import {
  createError,
  classifyThrown,
  err,
  ok,
  parseRetryAfter,
  type JoshifyError,
  type Result,
} from '@joshify/core';

/** The variant that feeds theme extraction and the blur. */
export const SOURCE_IMAGE_WIDTH = 64;
/** The variant the screen displays. */
export const HERO_IMAGE_WIDTH = 640;

/** Suffix for a fetched original, as opposed to something derived from one. */
export const SOURCE_KIND = 'src';

const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/**
 * No cover is anywhere near this large. The cap is here so that a redirect to
 * something that is not artwork cannot fill the SD card before we notice.
 */
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Litter from a crashed write. Old enough that no live write owns it. */
const TEMP_TTL_MS = 5 * 60 * 1000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface ArtworkCacheOptions {
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly maxEntries?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxImageBytes?: number | undefined;
}

export interface CachedArtwork {
  readonly key: string;
  /** Where the bytes live, for a static file handler to serve directly. */
  readonly path: string;
  readonly bytes: Buffer;
  /** True when nothing was requested over the network. */
  readonly fromCache: boolean;
}

export interface PruneReport {
  readonly removed: number;
  readonly entries: number;
  readonly bytes: number;
}

export interface ArtworkCache {
  /** Stable, filesystem-safe, and derived only from the URL. */
  keyFor(url: string): string;
  /** Cache hit, or one fetch. Concurrent callers for the same URL share it. */
  load(url: string): Promise<Result<CachedArtwork, JoshifyError>>;
  /** `null` when the derived file is absent — a miss is not a failure. */
  readDerived(key: string, kind: string): Promise<Result<Buffer | null, JoshifyError>>;
  writeDerived(
    key: string,
    kind: string,
    bytes: Buffer,
  ): Promise<Result<string, JoshifyError>>;
  prune(): Promise<Result<PruneReport, JoshifyError>>;
}

/**
 * 128 bits of SHA-256 over the URL.
 *
 * Spotify's image URLs are already content-addressed (the path is a hash of the
 * image), so hashing the URL inherits that: the same album art played twice,
 * reached through two different tracks, lands on the same key and is fetched
 * once. Hashing also flattens a URL — which contains `/` and can be long enough
 * to break a filename limit — into something a filesystem is happy with.
 */
const hashUrl = (url: string): string =>
  createHash('sha256').update(url).digest('hex').slice(0, 32);

/** Anything a caller could pass as `kind` becomes part of a path, so gate it. */
const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/;

const codeOf = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !('code' in cause)) return undefined;
  const { code } = cause;
  return typeof code === 'string' ? code : undefined;
};

const ioError = (message: string, cause: unknown): JoshifyError =>
  createError('unexpected', message, { cause });

/**
 * The image CDN is not the Web API, so it does not get the Web API's mapping.
 *
 * `classifyHttpFailure` reads a 404 as "no active device", which is exactly
 * right for `/me/player` and nonsense for `i.scdn.co` — there, a 404 means the
 * artwork URL in a cached playback state has expired, and the answer is to
 * carry on without a cover, not to tell the user their speakers vanished.
 */
const classifyImageFailure = (
  status: number,
  retryAfter: string | null,
): JoshifyError => {
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return createError('rate-limited', 'artwork CDN rate limited the request', {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status >= 500) {
    return createError('server', `artwork CDN returned ${String(status)}`, { status });
  }
  return createError('unexpected', `artwork is not available (${String(status)})`, {
    status,
  });
};

interface Entry {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export const createArtworkCache = (options: ArtworkCacheOptions): ArtworkCache => {
  const doFetch = options.fetchImpl ?? fetch;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const inFlight = new Map<string, Promise<Result<CachedArtwork, JoshifyError>>>();

  const pathFor = (key: string, kind: string): string =>
    join(options.cacheDir, `${key}.${kind}`);

  const writeAtomic = async (target: string, bytes: Buffer): Promise<void> => {
    await mkdir(options.cacheDir, { recursive: true, mode: DIR_MODE });
    const tmp = join(options.cacheDir, `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const handle = await open(tmp, 'wx', FILE_MODE);
      try {
        await handle.writeFile(bytes);
        // The rename is atomic, but only over bytes the kernel has actually
        // committed; without this a power cut can leave an empty file under a
        // name that says it is a complete image.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    } catch (cause) {
      await rm(tmp, { force: true });
      throw cause;
    }
  };

  const listEntries = async (): Promise<Entry[]> => {
    let names: string[];
    try {
      names = await readdir(options.cacheDir);
    } catch (cause) {
      // Nothing cached yet is not a state worth reporting.
      if (codeOf(cause) === 'ENOENT') return [];
      throw cause;
    }

    const entries: Entry[] = [];
    const now = Date.now();
    for (const name of names) {
      let info: Stats;
      try {
        info = await stat(join(options.cacheDir, name));
      } catch {
        // Raced with another prune, or with a rename. Either way it is gone.
        continue;
      }
      if (!info.isFile()) continue;
      if (name.startsWith('.')) {
        // A temp file from a write that died. Young ones may still be live.
        if (now - info.mtimeMs > TEMP_TTL_MS) {
          await rm(join(options.cacheDir, name), { force: true });
        }
        continue;
      }
      entries.push({ name, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    return entries;
  };

  const prune = async (): Promise<Result<PruneReport, JoshifyError>> => {
    try {
      const entries = await listEntries();
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      let count = entries.length;
      let removed = 0;

      for (const entry of entries) {
        if (count <= maxEntries && totalBytes <= maxBytes) break;
        await rm(join(options.cacheDir, entry.name), { force: true });
        totalBytes -= entry.bytes;
        count -= 1;
        removed += 1;
      }
      return ok({ removed, entries: count, bytes: totalBytes });
    } catch (cause) {
      return err(ioError(`could not prune ${options.cacheDir}`, cause));
    }
  };

  const readFileOrNull = async (path: string): Promise<Buffer | null> => {
    try {
      const bytes = await readFile(path);
      // A zero-length file is a bug's leftovers, not a cache hit: decoding it
      // fails identically every time, so treat it as absent and refetch.
      return bytes.byteLength === 0 ? null : bytes;
    } catch (cause) {
      // ENOTDIR joins ENOENT as "there is no such file": it is what a
      // misconfigured cache directory pointing at a regular file looks like,
      // and the honest answer is still a miss followed by a write that fails
      // loudly, rather than a read error on every single track.
      const code = codeOf(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw cause;
    }
  };

  /** Best effort: LRU that silently degrades to FIFO is still a bounded cache. */
  const touch = async (path: string): Promise<void> => {
    const now = new Date();
    try {
      await utimes(path, now, now);
    } catch {
      // A read-only filesystem or a file evicted mid-read. Neither is fatal.
    }
  };

  const download = async (url: string): Promise<Result<Buffer, JoshifyError>> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err(createError('unexpected', `artwork url is not a url: ${url}`));
    }
    // Artwork URLs come from a Spotify payload, which is remote input. Without
    // this, a `file:` url would turn the cache into an arbitrary-file reader.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return err(
        createError('unexpected', `artwork url is not http(s): ${parsed.protocol}`),
      );
    }

    let response: Response;
    try {
      response = await doFetch(url);
    } catch (cause) {
      return err(classifyThrown(cause));
    }

    if (!response.ok) {
      return err(
        classifyImageFailure(response.status, response.headers.get('retry-after')),
      );
    }

    // A captive portal on café or hotel wifi answers 200 with an HTML login
    // page. Caching that as `cover.jpg` poisons the entry until eviction, and
    // the only clue is the content type.
    const contentType = response.headers.get('content-type');
    if (contentType !== null && !contentType.toLowerCase().startsWith('image/')) {
      return err(
        createError('unexpected', `artwork response was ${contentType}, not an image`),
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxImageBytes) {
      return err(
        createError(
          'unexpected',
          `artwork is too large: ${String(declaredLength)} bytes`,
        ),
      );
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      // A connection dropped mid-body. The bytes are still in memory, so
      // nothing partial has been written — this is why the write happens after.
      return err(classifyThrown(cause));
    }

    if (bytes.byteLength === 0) {
      return err(createError('unexpected', 'artwork response was empty'));
    }
    if (bytes.byteLength > maxImageBytes) {
      return err(
        createError(
          'unexpected',
          `artwork is too large: ${String(bytes.byteLength)} bytes`,
        ),
      );
    }
    return ok(bytes);
  };

  const fetchAndStore = async (
    url: string,
    key: string,
  ): Promise<Result<CachedArtwork, JoshifyError>> => {
    const downloaded = await download(url);
    if (!downloaded.ok) return downloaded;

    const path = pathFor(key, SOURCE_KIND);
    try {
      await writeAtomic(path, downloaded.value);
    } catch (cause) {
      return err(ioError(`could not cache artwork at ${path}`, cause));
    }
    // Pruning after the write, not before: the new entry is the one most worth
    // keeping, and a failure to prune must not fail the fetch.
    await prune();
    return ok({ key, path, bytes: downloaded.value, fromCache: false });
  };

  const load = async (url: string): Promise<Result<CachedArtwork, JoshifyError>> => {
    const key = hashUrl(url);
    const path = pathFor(key, SOURCE_KIND);

    let cached: Buffer | null;
    try {
      cached = await readFileOrNull(path);
    } catch (cause) {
      return err(ioError(`could not read cached artwork at ${path}`, cause));
    }
    if (cached !== null) {
      await touch(path);
      return ok({ key, path, bytes: cached, fromCache: true });
    }

    // Track changes and a UI reconnect can ask for the same cover at the same
    // moment. Without this they race to write the same file and pay for two
    // downloads to do it.
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const pending = fetchAndStore(url, key).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  };

  const readDerived = async (
    key: string,
    kind: string,
  ): Promise<Result<Buffer | null, JoshifyError>> => {
    if (!KIND_PATTERN.test(kind)) {
      return err(createError('unexpected', `not a usable cache kind: ${kind}`));
    }
    const path = pathFor(key, kind);
    try {
      const bytes = await readFileOrNull(path);
      if (bytes !== null) await touch(path);
      return ok(bytes);
    } catch (cause) {
      return err(ioError(`could not read ${path}`, cause));
    }
  };

  const writeDerived = async (
    key: string,
    kind: string,
    bytes: Buffer,
  ): Promise<Result<string, JoshifyError>> => {
    if (!KIND_PATTERN.test(kind)) {
      return err(createError('unexpected', `not a usable cache kind: ${kind}`));
    }
    const path = pathFor(key, kind);
    try {
      await writeAtomic(path, bytes);
    } catch (cause) {
      return err(ioError(`could not write ${path}`, cause));
    }
    await prune();
    return ok(path);
  };

  return { keyFor: hashUrl, load, readDerived, writeDerived, prune };
};
