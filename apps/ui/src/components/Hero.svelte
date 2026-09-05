<script lang="ts">
  /**
   * The album, full bleed. The art *is* the background (D-040), so this is
   * `object-fit: cover` across the whole panel — cropped rather than
   * letterboxed, because a letterbox would put a border around the one thing
   * the device exists to show.
   *
   * **The crossfade holds the old frame until the new one has pixels.** The
   * failure mode this exists to prevent is the obvious implementation:
   * swapping `src`, or keying the element on the track, blanks the panel for
   * as long as the fetch takes and shows a flash of empty surface on every
   * single track change. Instead the arriving image is mounted underneath
   * nothing, at `opacity: 0`, and is promoted only once `load` *and* `decode`
   * have settled (`lib/artwork.ts`). The outgoing image is dropped when its
   * replacement finishes fading over it.
   *
   * **A track with no artwork gets a flat surface tint, not a placeholder.**
   * Local files and some podcasts have no images at all. A missing-image glyph
   * blown up on a 720×1280 panel reads as a fault; a plain dark panel reads as
   * a design, and the plate simply has more room (SCREENS.md).
   *
   * **Only `opacity` animates.** It is a compositor property, so a fade is a
   * GPU blend of two cached rasters with no layout and no repaint — which is
   * the difference between a crossfade the Pi renders at 60fps and one that
   * drops frames while a shader chain waits its turn (Phase 5).
   */
  import { untrack } from 'svelte';
  import {
    decodeImage,
    failLayer,
    requestLayer,
    retireLayers,
    settleLayer,
    type ArtworkLayer,
    type DecodableImage,
  } from '../lib/artwork.js';

  interface Props {
    /** The artwork URL, or `null` for a track that genuinely has none. */
    src: string | null;
    /**
     * Nothing playing: the last album stays but recedes (SCREENS.md). Keep
     * passing the previous `src` alongside it — the dimming is a black scrim
     * whose opacity animates, so it costs no repaint of the image itself.
     */
    dimmed?: boolean | undefined;
    /**
     * Injected so the decode step can be driven by a test. jsdom implements
     * neither image loading nor `decode()`, so without a seam the one rule
     * worth proving here — *do not swap before the pixels exist* — could only
     * be asserted in a real browser.
     */
    decode?: ((image: DecodableImage) => Promise<void>) | undefined;
  }

  const { src, dimmed = false, decode = decodeImage }: Props = $props();

  // Ids are the each-block's keys, so they must be unique for the life of the
  // component: reusing one would make Svelte patch an old element rather than
  // mount a new image, and the fade would never run.
  let sequence = 1;

  // Seeded during initialisation rather than from an effect, so the first
  // artwork is in the very first render rather than one flush later.
  let layers = $state<readonly ArtworkLayer[]>(requestLayer([], src, sequence));

  // `src` is the only dependency; `layers` is history, and reading it as a
  // dependency would re-enter this effect on every promotion.
  $effect.pre(() => {
    const wanted = src;
    untrack(() => {
      const id = sequence + 1;
      const next = requestLayer(layers, wanted, id);
      if (next === layers) return;
      sequence = id;
      layers = next;
    });
  });

  const loaded = async (id: number, image: DecodableImage): Promise<void> => {
    try {
      await decode(image);
    } catch {
      // Bytes that will not decode are a broken image by another route, and
      // get the same answer: the flat surface, never a broken-image glyph.
      layers = failLayer(layers, id);
      return;
    }
    // Safe to apply late: `settleLayer` ignores an id that has already been
    // retired, so a decode that finishes after two more track changes is a
    // no-op rather than a resurrection.
    layers = settleLayer(layers, id);
  };
</script>

<div class="hero" class:dimmed>
  {#each layers as layer (layer.id)}
    <img
      class="art"
      src={layer.src}
      alt=""
      data-ready={layer.ready}
      decoding="async"
      fetchpriority="high"
      onload={(event) => {
        void loaded(layer.id, event.currentTarget);
      }}
      onerror={() => {
        layers = failLayer(layers, layer.id);
      }}
      ontransitionend={() => {
        layers = retireLayers(layers, layer.id);
      }}
    />
  {/each}
</div>

<style>
  .hero {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* What a track with no artwork shows, and what a fade starts from. */
    background: var(--joshify-surface);
    transition: background var(--jf-theme-fade) ease;
  }

  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--jf-theme-fade) ease;
    /* Static, so it is rasterised once with the image rather than per frame.
       Nudged darker so the plate and the rail have something to sit on even
       over a white sleeve; their own scrims do the rest. */
    filter: brightness(0.86);
  }

  .art[data-ready='true'] {
    opacity: 1;
  }

  /* Dimming is a scrim over both layers, not a filter on them: animating
     `opacity` on a black rectangle is a composite, while animating
     `brightness()` re-rasterises a 720×1280 image. */
  .hero::after {
    content: '';
    position: absolute;
    inset: 0;
    background: #000;
    opacity: 0;
    transition: opacity var(--jf-theme-fade) ease;
    pointer-events: none;
  }

  .hero.dimmed::after {
    opacity: 0.55;
  }
</style>
