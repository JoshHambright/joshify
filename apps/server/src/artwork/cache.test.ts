import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isErr, isOk } from '@joshify/core';
import { createArtworkCache, SOURCE_KIND } from './cache.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01]);

const respondWith = (
  body: BodyInit,
  init: ResponseInit = { headers: { 'content-type': 'image/jpeg' } },
): typeof fetch =>
  vi.fn(() => Promise.resolve(new Response(body, init))) as unknown as typeof fetch;

const calls = (impl: typeof fetch): number =>
  (impl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

let cacheDir: string;
const URL_A = 'https://i.scdn.co/image/ab67616d00001e02aaaa';
const URL_B = 'https://i.scdn.co/image/ab67616d00001e02bbbb';

const entryNames = async (): Promise<string[]> =>
  (await readdir(cacheDir)).filter((name) => !name.startsWith('.')).sort();

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'joshify-artwork-cache-'));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('createArtworkCache.load', () => {
  it('fetches once and serves the second play from disk', async () => {
    // The whole point of the cache: an album on repeat costs one download.
    const fetchImpl = respondWith(JPEG);
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    const first = await cache.load(URL_A);
    const second = await cache.load(URL_A);

    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.value.fromCache).toBe(false);
    expect(second.value.fromCache).toBe(true);
    expect(second.value.bytes).toEqual(JPEG);
    expect(calls(fetchImpl)).toBe(1);
  });

  it('writes the bytes where a static handler can serve them', async () => {
    const cache = createArtworkCache({ cacheDir, fetchImpl: respondWith(JPEG) });

    const loaded = await cache.load(URL_A);

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value.path).toBe(
      join(cacheDir, `${cache.keyFor(URL_A)}.${SOURCE_KIND}`),
    );
    expect(await readFile(loaded.value.path)).toEqual(JPEG);
  });

  it('gives the same URL the same key across process restarts', () => {
    // Keys are derived, never allocated: a fresh boot must find yesterday's
    // files rather than refetch every cover on the account.
    const first = createArtworkCache({ cacheDir }).keyFor(URL_A);
    const second = createArtworkCache({ cacheDir: '/somewhere/else' }).keyFor(URL_A);

    expect(first).toBe(second);
    expect(first).not.toBe(createArtworkCache({ cacheDir }).keyFor(URL_B));
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('collapses concurrent requests for the same cover into one fetch', async () => {
    // A track change and a UI reconnect can ask at the same instant. Two
    // downloads racing to write one file is wasted bandwidth at best.
    const fetchImpl = respondWith(JPEG);
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    const results = await Promise.all([
      cache.load(URL_A),
      cache.load(URL_A),
      cache.load(URL_A),
    ]);

    expect(results.every(isOk)).toBe(true);
    expect(calls(fetchImpl)).toBe(1);
  });

  it('leaves nothing on disk when the download fails midway', async () => {
    // A truncated cached file is worse than no file: it fails to decode
    // identically on every boot and looks like corrupt artwork forever.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xd8]));
        controller.error(new Error('ECONNRESET'));
      },
    });
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: respondWith(body, { headers: { 'content-type': 'image/jpeg' } }),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('network');
    expect(await entryNames()).toEqual([]);
  });

  it('refuses a captive portal login page that answers 200', async () => {
    // Hotel and café wifi answers every request with HTML. Caching that as a
    // cover poisons the entry until it is evicted.
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: respondWith('<html>sign in</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.message).toContain('text/html');
    expect(await entryNames()).toEqual([]);
  });

  it('accepts a response that declares no content type', async () => {
    const cache = createArtworkCache({ cacheDir, fetchImpl: respondWith(JPEG, {}) });

    expect(isOk(await cache.load(URL_A))).toBe(true);
  });

  it('rejects an empty body instead of caching zero bytes', async () => {
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: respondWith(Buffer.alloc(0)),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.message).toContain('empty');
  });

  it('refetches a zero-length file left behind by an older bug', async () => {
    const fetchImpl = respondWith(JPEG);
    const cache = createArtworkCache({ cacheDir, fetchImpl });
    await writeFile(join(cacheDir, `${cache.keyFor(URL_A)}.${SOURCE_KIND}`), '');

    const loaded = await cache.load(URL_A);

    expect(isOk(loaded)).toBe(true);
    if (!isOk(loaded)) return;
    expect(loaded.value.fromCache).toBe(false);
    expect(calls(fetchImpl)).toBe(1);
  });

  it('refuses an oversized image by its declared length, before downloading it', async () => {
    // A redirect to something that is not artwork must not be allowed to fill
    // the SD card of an appliance nobody is watching.
    const cache = createArtworkCache({
      cacheDir,
      maxImageBytes: 16,
      fetchImpl: respondWith(JPEG, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '999999' },
      }),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.message).toContain('too large');
  });

  it('refuses an oversized image that lied about its length', async () => {
    const cache = createArtworkCache({
      cacheDir,
      maxImageBytes: 4,
      fetchImpl: respondWith(JPEG),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.message).toContain('too large');
    expect(await entryNames()).toEqual([]);
  });

  it('maps CDN failures onto the taxonomy the UI already understands', async () => {
    const cases: readonly { status: number; kind: string; retryable: boolean }[] = [
      // Not 'no-active-device': a 404 here means the artwork URL in a cached
      // playback state expired, which has nothing to do with speakers.
      { status: 404, kind: 'unexpected', retryable: false },
      { status: 429, kind: 'rate-limited', retryable: true },
      { status: 503, kind: 'server', retryable: true },
    ];

    for (const { status, kind, retryable } of cases) {
      const cache = createArtworkCache({
        cacheDir,
        fetchImpl: respondWith('', { status, headers: { 'retry-after': '2' } }),
      });
      const loaded = await cache.load(URL_A);

      expect(isErr(loaded)).toBe(true);
      if (!isErr(loaded)) return;
      expect(loaded.error.kind).toBe(kind);
      expect(loaded.error.retryable).toBe(retryable);
      if (kind === 'rate-limited') expect(loaded.error.retryAfterMs).toBe(2000);
    }
  });

  it('reports a transport failure as network, so the poller can retry it', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    ) as unknown as typeof fetch;
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('network');
    expect(loaded.error.retryable).toBe(true);
  });

  it('refuses a URL that is not http(s)', async () => {
    // Image URLs arrive inside a Spotify payload. Without the check, a `file:`
    // url would turn this into an arbitrary-file reader.
    const fetchImpl = respondWith(JPEG);
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    expect(isErr(await cache.load('file:///etc/passwd'))).toBe(true);
    expect(isErr(await cache.load('not a url'))).toBe(true);
    expect(calls(fetchImpl)).toBe(0);
  });

  it('reports a filesystem failure instead of silently refetching forever', async () => {
    // A directory sitting where the cached file belongs is unreadable in a way
    // no retry fixes; it must surface rather than turn into a fetch every poll.
    const fetchImpl = respondWith(JPEG);
    const cache = createArtworkCache({ cacheDir, fetchImpl });
    await mkdir(join(cacheDir, `${cache.keyFor(URL_A)}.${SOURCE_KIND}`));

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.kind).toBe('unexpected');
    expect(calls(fetchImpl)).toBe(0);
  });

  it('reports a write failure rather than pretending the image was cached', async () => {
    const file = join(cacheDir, 'not-a-directory');
    await writeFile(file, 'x');
    const cache = createArtworkCache({
      cacheDir: join(file, 'nested'),
      fetchImpl: respondWith(JPEG),
    });

    const loaded = await cache.load(URL_A);

    expect(isErr(loaded)).toBe(true);
    if (!isErr(loaded)) return;
    expect(loaded.error.message).toContain('could not cache artwork');
  });
});

describe('createArtworkCache derived files', () => {
  it('round trips a derived render and reports a miss as null', async () => {
    const cache = createArtworkCache({ cacheDir });
    const key = cache.keyFor(URL_A);

    const missing = await cache.readDerived(key, 'backdrop');
    expect(isOk(missing) && missing.value).toBeNull();

    const written = await cache.writeDerived(key, 'backdrop', JPEG);
    expect(isOk(written)).toBe(true);
    const read = await cache.readDerived(key, 'backdrop');

    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.value).toEqual(JPEG);
  });

  it('refuses a kind that would escape the cache directory', async () => {
    // `kind` becomes part of a path. It is internal today and one refactor
    // away from being a route parameter.
    const cache = createArtworkCache({ cacheDir });

    expect(isErr(await cache.writeDerived(cache.keyFor(URL_A), '../escape', JPEG))).toBe(
      true,
    );
    expect(isErr(await cache.readDerived(cache.keyFor(URL_A), '../escape'))).toBe(true);
  });

  it('reports a write failure, and reads an unreachable path as absent', async () => {
    const file = join(cacheDir, 'blocked');
    await writeFile(file, 'x');
    const cache = createArtworkCache({ cacheDir: join(file, 'nested') });

    expect(isErr(await cache.writeDerived('abc', 'backdrop', JPEG))).toBe(true);
    const read = await cache.readDerived('abc', 'backdrop');
    expect(isOk(read) && read.value).toBeNull();
  });
});

describe('createArtworkCache.prune', () => {
  const write = async (name: string, size: number, ageMs: number): Promise<void> => {
    const path = join(cacheDir, name);
    await writeFile(path, Buffer.alloc(size, 1));
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
  };

  it('evicts the least recently used entries first', async () => {
    // Months of unattended playback is the design case. Eviction is always
    // safe: the cost of being wrong is refetching a few kilobytes.
    await write('aaa.src', 10, 30_000);
    await write('bbb.src', 10, 20_000);
    await write('ccc.src', 10, 10_000);

    const report = await createArtworkCache({ cacheDir, maxEntries: 2 }).prune();

    expect(isOk(report)).toBe(true);
    if (!isOk(report)) return;
    expect(report.value.removed).toBe(1);
    expect(await entryNames()).toEqual(['bbb.src', 'ccc.src']);
  });

  it('evicts on total size as well as on count', async () => {
    await write('aaa.src', 4096, 30_000);
    await write('bbb.src', 4096, 10_000);

    const report = await createArtworkCache({ cacheDir, maxBytes: 5000 }).prune();

    expect(isOk(report)).toBe(true);
    if (!isOk(report)) return;
    expect(report.value.bytes).toBeLessThanOrEqual(5000);
    expect(await entryNames()).toEqual(['bbb.src']);
  });

  it('keeps a cover on heavy rotation and drops one played once in March', async () => {
    // LRU, not FIFO — a read has to count as a use or the cache evicts exactly
    // the images it is about to be asked for again.
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: respondWith(JPEG),
      maxEntries: 1,
    });
    await cache.load(URL_A);
    await cache.load(URL_B);
    const oldTime = new Date(Date.now() - 60_000);
    for (const name of await entryNames()) {
      await utimes(join(cacheDir, name), oldTime, oldTime);
    }

    await cache.load(URL_A); // a hit, which must refresh A's recency
    await cache.prune();

    expect(await entryNames()).toEqual([`${cache.keyFor(URL_A)}.${SOURCE_KIND}`]);
  });

  it('prunes automatically on write, so nothing has to remember to call it', async () => {
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: respondWith(JPEG),
      maxEntries: 1,
    });

    await cache.load(URL_A);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.load(URL_B);

    expect(await entryNames()).toEqual([`${cache.keyFor(URL_B)}.${SOURCE_KIND}`]);
  });

  it('sweeps temp files a crashed write left behind, but not live ones', async () => {
    await write('.aaaa.tmp', 10, 10 * 60 * 1000);
    await write('.bbbb.tmp', 10, 1000);

    await createArtworkCache({ cacheDir }).prune();

    const remaining = await readdir(cacheDir);
    expect(remaining).toEqual(['.bbbb.tmp']);
  });

  it('ignores subdirectories and treats a missing cache directory as empty', async () => {
    await import('node:fs/promises').then(async (fs) =>
      fs.mkdir(join(cacheDir, 'nested')),
    );
    const populated = await createArtworkCache({ cacheDir, maxEntries: 0 }).prune();
    expect(isOk(populated)).toBe(true);
    if (!isOk(populated)) return;
    expect(populated.value.entries).toBe(0);

    const absent = await createArtworkCache({ cacheDir: join(cacheDir, 'gone') }).prune();
    expect(isOk(absent)).toBe(true);
    if (!isOk(absent)) return;
    expect(absent.value.entries).toBe(0);
  });

  it('reports a prune failure instead of throwing out of a fetch', async () => {
    const file = join(cacheDir, 'a-file');
    await writeFile(file, 'x');

    const report = await createArtworkCache({ cacheDir: file }).prune();

    expect(isErr(report)).toBe(true);
  });

  it('survives an entry that vanishes between listing and stat', async () => {
    await write('aaa.src', 10, 1000);
    const path = join(cacheDir, 'aaa.src');
    const cache = createArtworkCache({ cacheDir });
    const original = await stat(path);
    expect(original.isFile()).toBe(true);
    await rm(path);

    expect(isOk(await cache.prune())).toBe(true);
  });
});
