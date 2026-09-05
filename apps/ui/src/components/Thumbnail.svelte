<script lang="ts">
  /**
   * The picture on a list row (P6-08).
   *
   * Three rules, all of them about a list that is a thousand rows long on a
   * device with a fixed memory budget:
   *
   * 1. **It only exists while the row does.** Virtualisation unmounts rows that
   *    scrolled away, and the decoded bitmap goes with the element — which is
   *    the actual eviction. `loading="lazy"` covers the rows the browser has
   *    laid out but not reached.
   * 2. **The URL is chosen once and remembered, in a bounded cache.** The
   *    policy and the reasoning are in `lib/thumbnails.ts`: an LRU, so flicking
   *    back up the list does not reload what you just passed.
   * 3. **No artwork is a state, not a failure.** A local file and a fresh
   *    playlist genuinely have no image, and a broken-image glyph on a wall
   *    panel reads as a fault. They get a flat tint instead — the same move
   *    `Stage` makes for a missing hero.
   */
  import type { Artwork } from '@joshify/core';
  import type { ThumbnailCache } from '../lib/thumbnails.js';

  interface Props {
    images: readonly Artwork[];
    /** Stable across queries — the item's uri, never its row index. */
    cacheKey: string;
    cache: ThumbnailCache;
    size?: number | undefined;
    /** Artists are round; everything else is a square sleeve. */
    round?: boolean | undefined;
  }

  const { images, cacheKey, cache, size = 56, round = false }: Props = $props();

  const src = $derived(cache.resolve(cacheKey, images));

  // A row coming back into view has already been seen, so it appears rather
  // than fading in again. Only a genuinely new image is worth 120ms.
  let shown = $state(false);
  $effect(() => {
    shown = cache.isLoaded(cacheKey);
  });
</script>

<span class="thumb" class:round style="--jf-thumb: {size}px">
  {#if src !== null}
    <img
      {src}
      alt=""
      loading="lazy"
      decoding="async"
      class:shown
      onload={() => {
        cache.markLoaded(cacheKey);
        shown = true;
      }}
    />
  {/if}
</span>

<style>
  .thumb {
    position: relative;
    display: block;
    flex: none;
    width: var(--jf-thumb);
    height: var(--jf-thumb);
    overflow: hidden;
    border-radius: 6px;
    /* The tint a row shows when there is no artwork, and the ground an image
       fades in over. Reads as a design; a placeholder glyph reads as a fault. */
    background: rgb(255 255 255 / 0.07);
  }

  .thumb.round {
    border-radius: 50%;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  img.shown {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    img {
      transition: none;
    }
  }
</style>
