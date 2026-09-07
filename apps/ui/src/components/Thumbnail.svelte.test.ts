/**
 * @vitest-environment jsdom
 */
/**
 * The cache's own policy — LRU order, capacity, what counts as a use — is
 * proved in `lib/thumbnails.test.ts`, in Node. What needs a DOM is the three
 * rules the component itself is responsible for: that a row with no artwork
 * draws no image element at all, that the URL comes from the cache under the
 * row's stable key rather than from the array's first entry, and that a row
 * that has been seen before appears rather than fading in again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import type { Artwork } from '@joshify/core';
import Thumbnail from './Thumbnail.svelte';
import { createThumbnailCache } from '../lib/thumbnails.js';

/** Widest first, as Spotify sends them — so `images[0]` is the wrong answer. */
const SLEEVE: readonly Artwork[] = [
  { url: 'https://art/640.jpg', width: 640, height: 640 },
  { url: 'https://art/300.jpg', width: 300, height: 300 },
  { url: 'https://art/64.jpg', width: 64, height: 64 },
];

const mount = (props: {
  images?: readonly Artwork[];
  cacheKey?: string;
  cache?: ReturnType<typeof createThumbnailCache>;
  round?: boolean;
  size?: number;
}) => {
  const cache = props.cache ?? createThumbnailCache();
  const view = render(Thumbnail, {
    images: props.images ?? SLEEVE,
    cacheKey: props.cacheKey ?? 'spotify:album:1',
    cache,
    ...(props.round === undefined ? {} : { round: props.round }),
    ...(props.size === undefined ? {} : { size: props.size }),
  });
  return { ...view, cache };
};

const img = (container: HTMLElement): HTMLImageElement | null =>
  container.querySelector('img');

afterEach(cleanup);

describe('a row with artwork', () => {
  it('takes the URL the cache chose, not the first in the array', () => {
    const { container } = mount({});

    expect(img(container)?.getAttribute('src')).toBe('https://art/64.jpg');
  });

  it('is decorative: an empty alt, so a screen reader reads the row once', () => {
    const { container } = mount({});

    expect(img(container)?.getAttribute('alt')).toBe('');
  });

  // A thousand-row library asks the browser for a thousand images otherwise.
  it('defers the ones the browser has laid out but not reached', () => {
    const { container } = mount({});

    expect(img(container)?.getAttribute('loading')).toBe('lazy');
    expect(img(container)?.getAttribute('decoding')).toBe('async');
  });
});

// A broken-image glyph on a wall panel reads as a fault. A local file and a
// fresh playlist genuinely have no picture, and that is not a failure.
describe('a row with no artwork', () => {
  it('draws no image element at all, only the tint', () => {
    const { container } = mount({ images: [] });

    expect(img(container)).toBeNull();
    expect(container.querySelector('.thumb')).not.toBeNull();
  });
});

describe('coming back into view', () => {
  it('fades in the first time it is seen', () => {
    const { container } = mount({});

    expect(img(container)?.classList.contains('shown')).toBe(false);
  });

  it('appears at once for a row that has already loaded', async () => {
    const cache = createThumbnailCache();
    const first = mount({ cache, cacheKey: 'spotify:album:1' });
    await fireEvent.load(img(first.container) as HTMLImageElement);
    cleanup();

    // The same row, remounted the way virtualisation remounts one.
    const { container } = mount({ cache, cacheKey: 'spotify:album:1' });

    expect(img(container)?.classList.contains('shown')).toBe(true);
  });

  it('still fades in a different row that happens to follow a loaded one', async () => {
    const cache = createThumbnailCache();
    const first = mount({ cache, cacheKey: 'spotify:album:1' });
    await fireEvent.load(img(first.container) as HTMLImageElement);
    cleanup();

    const { container } = mount({ cache, cacheKey: 'spotify:album:2' });

    expect(img(container)?.classList.contains('shown')).toBe(false);
  });
});

describe('the shape', () => {
  it('is a square sleeve by default', () => {
    const { container } = mount({});

    expect(container.querySelector('.thumb')?.classList.contains('round')).toBe(false);
  });

  it('is round for an artist', () => {
    const { container } = mount({ round: true });

    expect(container.querySelector('.thumb')?.classList.contains('round')).toBe(true);
  });

  it('sizes itself from the prop, so one component serves every list', () => {
    const { container } = mount({ size: 88 });

    expect(
      container
        .querySelector<HTMLElement>('.thumb')
        ?.style.getPropertyValue('--jf-thumb'),
    ).toBe('88px');
  });
});
