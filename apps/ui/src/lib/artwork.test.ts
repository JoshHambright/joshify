/**
 * The crossfade, asserted as a decision rather than as a DOM.
 *
 * Everything the panel can get wrong on a track change is in here: showing an
 * image before it has decoded, dropping the old one first and flashing the
 * surface, fading an album into an identical copy of itself, or holding the
 * last cover up under a track that has none.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlayingItem } from '@joshify/core';
import {
  artworkSources,
  BACKDROP_MIN_WIDTH,
  decodeImage,
  failLayer,
  HERO_MIN_WIDTH,
  requestLayer,
  retireLayers,
  settleLayer,
  topLayer,
  type ArtworkLayer,
} from './artwork.js';

const track = (over: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  durationMs: 211_000,
  images: [
    { url: 'https://i/640', width: 640, height: 640 },
    { url: 'https://i/300', width: 300, height: 300 },
    { url: 'https://i/64', width: 64, height: 64 },
  ],
  isLocal: false,
  ...over,
});

const ready = (id: number, src: string): ArtworkLayer => ({ id, src, ready: true });
const pending = (id: number, src: string): ArtworkLayer => ({ id, src, ready: false });

describe('artworkSources', () => {
  it('gives the hero the largest variant and the backdrop the smallest', () => {
    const sources = artworkSources(track());

    // 640 is under the 720 the panel wants, so the largest available wins.
    expect(sources.hero).toBe('https://i/640');
    expect(sources.backdrop).toBe('https://i/64');
  });

  it('asks for a hero wide enough for the panel and a backdrop small enough to be free', () => {
    expect(HERO_MIN_WIDTH).toBe(720);
    expect(BACKDROP_MIN_WIDTH).toBe(64);
  });

  it('carries the item identity for anything keyed by track rather than by image', () => {
    expect(artworkSources(track()).key).toBe('track-1');
  });

  // A local file has neither images nor an id, and both absences are normal.
  it('has no artwork at all for a local file, but still has a key', () => {
    const sources = artworkSources(
      track({ id: null, uri: null, images: [], isLocal: true }),
    );

    expect(sources.hero).toBeNull();
    expect(sources.backdrop).toBeNull();
    expect(sources.key).toBe('local:Velocity Division:211000');
  });

  it('is empty when nothing is playing', () => {
    expect(artworkSources(null)).toEqual({ hero: null, backdrop: null, key: null });
  });
});

describe('topLayer', () => {
  it('is the layer nearest the viewer, or nothing', () => {
    expect(topLayer([])).toBeNull();
    expect(topLayer([ready(1, 'a'), pending(2, 'b')])?.id).toBe(2);
  });
});

describe('requestLayer', () => {
  it('mounts the first image as pending, never as visible', () => {
    expect(requestLayer([], 'a', 1)).toEqual([pending(1, 'a')]);
  });

  // The rule the whole component exists for: the old frame stays until the new
  // one has pixels. Dropping it here is the flash of empty surface.
  it('keeps the visible image underneath the arriving one', () => {
    expect(requestLayer([ready(1, 'a')], 'b', 2)).toEqual([
      ready(1, 'a'),
      pending(2, 'b'),
    ]);
  });

  // A re-poll of the same track re-renders with the same URL every few
  // seconds; restarting a 420ms fade on each would be a permanent shimmer.
  it('is a no-op for the image already on top, identity included', () => {
    const layers = [ready(1, 'a')];
    expect(requestLayer(layers, 'a', 2)).toBe(layers);

    const arriving = [ready(1, 'a'), pending(2, 'b')];
    expect(requestLayer(arriving, 'b', 3)).toBe(arriving);
  });

  // Two tracks from one album share a cover. Fading an image into an identical
  // copy of itself costs a decode and shows nothing.
  it('does not restart when a different track has the same cover', () => {
    const layers = [ready(1, 'https://i/640')];
    expect(requestLayer(layers, 'https://i/640', 9)).toBe(layers);
  });

  it('abandons an image that never arrived rather than queueing behind it', () => {
    const skipping = requestLayer([ready(1, 'a'), pending(2, 'b')], 'c', 3);

    expect(skipping).toEqual([ready(1, 'a'), pending(3, 'c')]);
  });

  it('never composites more than the visible image and the arriving one', () => {
    const settled = requestLayer([ready(1, 'a'), ready(2, 'b')], 'c', 3);

    expect(settled).toEqual([ready(2, 'b'), pending(3, 'c')]);
  });

  it('clears to the flat surface when there is no artwork to show', () => {
    expect(requestLayer([ready(1, 'a')], null, 2)).toEqual([]);
  });

  it('stays empty, identity included, when there was nothing to clear', () => {
    const layers: readonly ArtworkLayer[] = [];
    expect(requestLayer(layers, null, 1)).toBe(layers);
  });
});

describe('settleLayer', () => {
  it('promotes the decoded image without disturbing the one below', () => {
    expect(settleLayer([ready(1, 'a'), pending(2, 'b')], 2)).toEqual([
      ready(1, 'a'),
      ready(2, 'b'),
    ]);
  });

  // A decode that resolves after two more track changes must not resurrect a
  // layer that has already been dropped.
  it('ignores an id that is no longer on screen', () => {
    const layers = [ready(1, 'a')];
    expect(settleLayer(layers, 7)).toBe(layers);
  });

  it('ignores an image that is already showing', () => {
    const layers = [ready(1, 'a')];
    expect(settleLayer(layers, 1)).toBe(layers);
  });
});

describe('retireLayers', () => {
  it('drops what the finished fade has covered', () => {
    expect(retireLayers([ready(1, 'a'), ready(2, 'b')], 2)).toEqual([ready(2, 'b')]);
  });

  it('keeps everything when the bottom layer reports, since it covers nothing', () => {
    const layers = [ready(1, 'a'), ready(2, 'b')];
    expect(retireLayers(layers, 1)).toBe(layers);
  });

  it('keeps everything for an unknown id', () => {
    const layers = [ready(1, 'a'), ready(2, 'b')];
    expect(retireLayers(layers, 5)).toBe(layers);
  });

  // A transition on a layer that has not decoded is not the crossfade
  // finishing, and acting on it would remove the frame still being shown.
  it('keeps everything when the reporting layer has not decoded', () => {
    const layers = [ready(1, 'a'), pending(2, 'b')];
    expect(retireLayers(layers, 2)).toBe(layers);
  });
});

describe('failLayer', () => {
  // Attractive and dishonest: the previous album under a track that has none.
  it('clears to the flat surface rather than leaving the wrong record up', () => {
    expect(failLayer([ready(1, 'a'), pending(2, 'b')], 2)).toEqual([]);
  });

  it('lets a layer that was already leaving go quietly', () => {
    expect(failLayer([ready(1, 'a'), pending(2, 'b')], 1)).toEqual([pending(2, 'b')]);
  });

  it('keeps everything for an unknown id', () => {
    const layers = [ready(1, 'a'), pending(2, 'b')];
    expect(failLayer(layers, 9)).toBe(layers);
  });
});

describe('decodeImage', () => {
  it('waits for the pixels when the browser offers to produce them', async () => {
    const decode = vi.fn(() => Promise.resolve());
    await decodeImage({ decode });

    expect(decode).toHaveBeenCalledTimes(1);
  });

  // Not universal, and jsdom has none: `load` is then the best signal there is.
  it('resolves where there is no decoder', async () => {
    await expect(decodeImage({})).resolves.toBeUndefined();
  });

  it('reports an image that arrived but will not decode', async () => {
    const decode = (): Promise<void> => Promise.reject(new Error('undecodable'));

    await expect(decodeImage({ decode })).rejects.toThrow('undecodable');
  });
});
