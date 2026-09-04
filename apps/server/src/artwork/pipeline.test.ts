import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp, JimpMime } from 'jimp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createError, err, ok, type Artwork } from '@joshify/core';
import { createArtworkCache, type ArtworkCache } from './cache.js';
import { parseHex, rgbToHsl } from './contrast.js';
import { BACKDROP_KIND, prepareArtwork } from './pipeline.js';
import { DEFAULT_THEME } from './theme.js';

const SOURCE_URL = 'https://i.scdn.co/image/small';
const HERO_URL = 'https://i.scdn.co/image/large';

const IMAGES: readonly Artwork[] = [
  { url: HERO_URL, width: 640, height: 640 },
  { url: SOURCE_URL, width: 64, height: 64 },
];

const coverBytes = async (colour: number, size: number): Promise<Buffer> =>
  new Jimp({ width: size, height: size, color: colour }).getBuffer(JimpMime.png);

/** Serves a different body per URL, the way the real CDN does. */
const serving = (bodies: Readonly<Record<string, Buffer | number>>): typeof fetch =>
  vi.fn((input: unknown) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) return Promise.resolve(new Response('', { status: 404 }));
    if (typeof body === 'number')
      return Promise.resolve(new Response('', { status: body }));
    return Promise.resolve(
      new Response(body, { headers: { 'content-type': 'image/png' } }),
    );
  }) as unknown as typeof fetch;

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'joshify-artwork-pipeline-'));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('prepareArtwork', () => {
  it('produces the whole per-track payload in one pass', async () => {
    // PRODUCT.md §8.1: the UI gets a hero, a backdrop and a theme, and does no
    // work of its own to obtain any of them.
    const fetchImpl = serving({
      [SOURCE_URL]: await coverBytes(0x1e88e5ff, 64),
      [HERO_URL]: await coverBytes(0x1e88e5ff, 640),
    });
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.problems).toEqual([]);
    expect(prepared.hero?.key).toBe(cache.keyFor(HERO_URL));
    expect(prepared.backdrop?.key).toBe(cache.keyFor(SOURCE_URL));
    expect(prepared.backdrop?.contentType).toBe('image/jpeg');
    expect(
      rgbToHsl(parseHex(prepared.theme.accent) ?? { r: 0, g: 0, b: 0 }).h,
    ).toBeGreaterThan(180);
  });

  it('writes the backdrop where a static handler can serve it, and keeps it tiny', async () => {
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: serving({
        [SOURCE_URL]: await coverBytes(0xcc4400ff, 64),
        [HERO_URL]: await coverBytes(0xcc4400ff, 640),
      }),
    });

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.backdrop?.path).toBe(
      join(cacheDir, `${cache.keyFor(SOURCE_URL)}.${BACKDROP_KIND}`),
    );
    const written = await stat(prepared.backdrop?.path ?? '');
    expect(written.size).toBeLessThan(2048);
  });

  it('themes the device even when the hero download fails', async () => {
    // The 640px image is the one worth losing: the colour of the room should
    // not depend on the largest download succeeding.
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: serving({
        [SOURCE_URL]: await coverBytes(0x8bc34aff, 64),
        [HERO_URL]: 500,
      }),
    });

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.hero).toBeNull();
    expect(prepared.backdrop).not.toBeNull();
    expect(prepared.theme).not.toEqual(DEFAULT_THEME);
    expect(prepared.problems).toHaveLength(1);
  });

  it('falls back to the neutral theme when there is no artwork at all', async () => {
    // Local files have no cover. This is a state, not a failure.
    const cache = createArtworkCache({ cacheDir, fetchImpl: serving({}) });

    const prepared = await prepareArtwork([], { cache });

    expect(prepared).toEqual({
      theme: DEFAULT_THEME,
      hero: null,
      backdrop: null,
      problems: [],
    });
  });

  it('never throws when the source image cannot be fetched', async () => {
    const cache = createArtworkCache({ cacheDir, fetchImpl: serving({}) });

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.theme).toEqual(DEFAULT_THEME);
    expect(prepared.backdrop).toBeNull();
    expect(prepared.problems).toHaveLength(2);
  });

  it('degrades to the neutral theme when the bytes are not a decodable image', async () => {
    // A CDN edge serving a stale error body with an image content type. Both
    // the theme and the backdrop are lost; neither loses the track change.
    const junk = Buffer.from('not really a png');
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: serving({ [SOURCE_URL]: junk, [HERO_URL]: junk }),
    });

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.theme).toEqual(DEFAULT_THEME);
    expect(prepared.hero).not.toBeNull();
    expect(prepared.backdrop).toBeNull();
    expect(prepared.problems.map((problem) => problem.kind)).toEqual([
      'unexpected',
      'unexpected',
    ]);
  });

  it('keeps the theme when only the backdrop cannot be stored', async () => {
    // A full or read-only filesystem: the theme is already computed and is
    // pushed over the websocket, so it survives losing the disk write.
    const bytes = await coverBytes(0x9c27b0ff, 64);
    const real = createArtworkCache({
      cacheDir,
      fetchImpl: serving({ [SOURCE_URL]: bytes, [HERO_URL]: bytes }),
    });
    const cache: ArtworkCache = {
      ...real,
      writeDerived: () => Promise.resolve(err(createError('unexpected', 'disk full'))),
      readDerived: () => Promise.resolve(ok(null)),
    };

    const prepared = await prepareArtwork(IMAGES, { cache });

    expect(prepared.backdrop).toBeNull();
    expect(prepared.theme).not.toEqual(DEFAULT_THEME);
    expect(prepared.problems.map((problem) => problem.message)).toEqual(['disk full']);
  });

  it('uses the one image available when a cover has only a single size', async () => {
    // Generated playlist mosaics and some podcast art come back as one entry.
    const only: readonly Artwork[] = [{ url: SOURCE_URL, width: 300, height: 300 }];
    const fetchImpl = serving({ [SOURCE_URL]: await coverBytes(0x336699ff, 300) });
    const cache = createArtworkCache({ cacheDir, fetchImpl });

    const prepared = await prepareArtwork(only, { cache });

    expect(prepared.hero?.key).toBe(cache.keyFor(SOURCE_URL));
    expect(prepared.backdrop?.key).toBe(cache.keyFor(SOURCE_URL));
    // One image, one download: the second request is a cache hit.
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls,
    ).toHaveLength(1);
  });

  it('honours backdrop options passed through to the renderer', async () => {
    const bytes = await coverBytes(0x223344ff, 64);
    const cache = createArtworkCache({
      cacheDir,
      fetchImpl: serving({ [SOURCE_URL]: bytes, [HERO_URL]: bytes }),
    });

    const prepared = await prepareArtwork(IMAGES, { cache, backdrop: { edge: 8 } });

    expect(prepared.backdrop?.width).toBe(8);
  });
});
