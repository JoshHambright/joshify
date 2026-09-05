import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, type PlayingItem } from '@joshify/core';
import { createArtworkPresenter } from './artwork-presenter.js';
import type { ArtworkCache } from '../artwork/cache.js';

const track = (over: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  durationMs: 211_000,
  images: [{ url: 'https://i/64', width: 64, height: 64 }],
  isLocal: false,
  ...over,
});

/**
 * A cache that never produces an image. That is enough for what this file
 * decides — the memo and the failure fallback — and keeps the test free of a
 * decoder and a temp directory, which the pipeline's own suite already covers.
 */
const emptyCache = () => {
  let loads = 0;
  const cache = {
    load: () => {
      loads += 1;
      return Promise.resolve({
        ok: false as const,
        error: { kind: 'network' as const, message: 'no network here', retryable: true },
      });
    },
  } as unknown as ArtworkCache;
  return { cache, loads: () => loads };
};

describe('the artwork presenter', () => {
  // A colour is the least important thing on the panel. It must never be the
  // reason the title does not appear.
  it('falls back to the neutral theme when nothing can be fetched', async () => {
    const { cache } = emptyCache();
    const presenter = createArtworkPresenter({ cache });

    expect(await presenter.themeFor(track())).toEqual(DEFAULT_THEME);
  });

  it('answers without fetching at all for a track that has no artwork', async () => {
    const { cache, loads } = emptyCache();
    const presenter = createArtworkPresenter({ cache });

    expect(await presenter.themeFor(track({ images: [] }))).toEqual(DEFAULT_THEME);
    expect(loads()).toBe(0);
  });

  // A paused player is polled for hours, and someone flicking through an album
  // revisits the same cover a dozen times.
  it('remembers a theme rather than extracting it twice', async () => {
    const { cache, loads } = emptyCache();
    const presenter = createArtworkPresenter({ cache });

    await presenter.themeFor(track());
    const after = loads();
    await presenter.themeFor(track());

    expect(loads()).toBe(after);
  });

  it('keys on the item, so a local file with no id is still remembered', async () => {
    const { cache, loads } = emptyCache();
    const presenter = createArtworkPresenter({ cache });
    const local = track({ id: null, uri: null, isLocal: true });

    await presenter.themeFor(local);
    const after = loads();
    await presenter.themeFor(local);

    expect(loads()).toBe(after);
  });

  it('treats two different tracks as two different themes', async () => {
    const { cache, loads } = emptyCache();
    const presenter = createArtworkPresenter({ cache });

    await presenter.themeFor(track());
    const afterFirst = loads();
    await presenter.themeFor(track({ id: 'track-2', uri: 'spotify:track:track-2' }));

    expect(afterFirst).toBeGreaterThan(0);
    expect(loads()).toBeGreaterThan(afterFirst);
  });

  // The device runs for weeks. An unbounded memo is a leak that shows up in
  // month three rather than in a test.
  it('evicts the least recently used entry past its limit', async () => {
    const { cache, loads } = emptyCache();
    const presenter = createArtworkPresenter({ cache, memoLimit: 2 });

    await presenter.themeFor(track({ id: 'a', uri: 'spotify:track:a' }));
    await presenter.themeFor(track({ id: 'b', uri: 'spotify:track:b' }));
    // Touching `a` makes `b` the oldest.
    await presenter.themeFor(track({ id: 'a', uri: 'spotify:track:a' }));
    await presenter.themeFor(track({ id: 'c', uri: 'spotify:track:c' }));

    const before = loads();
    await presenter.themeFor(track({ id: 'a', uri: 'spotify:track:a' }));
    expect(loads()).toBe(before); // still remembered

    await presenter.themeFor(track({ id: 'b', uri: 'spotify:track:b' }));
    expect(loads()).toBeGreaterThan(before); // evicted, so re-extracted
  });
});
