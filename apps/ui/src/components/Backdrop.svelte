<script lang="ts">
  /**
   * The drifting wash (P3-09). The whole device glows in the colour of
   * whatever is playing (PRODUCT §5.1): the same artwork, blown up, blurred
   * past recognition and moving slowly enough to notice only if you look.
   *
   * **The source is the 64px variant, not the 640px one.** A heavily
   * downscaled image scaled back up *is* a blur — bilinear filtering does the
   * work on the GPU for free — so the CSS `blur()` here only has to erase the
   * upscaling grid rather than manufacture the whole effect (PRODUCT §8.1,
   * D-003). When the server-side pre-render lands (P3-05) it slots straight
   * into `src` and the `filter` below can go entirely; until then this works
   * from the artwork URL alone.
   *
   * **The motion is procedural and always will be.** There is no audio
   * analysis available to us — `audio-features` and `audio-analysis` are
   * deprecated for new apps (D-010) — so the drift is a time-based keyframe
   * with no input. That is a constraint, but it is also the right one for a
   * thing that runs for hours on a wall: nothing here reacts, spikes, or
   * pulses, so there is nothing to catch the eye of someone in the room.
   *
   * **Why the animation is on the wrapper and the blur is on the image:** a
   * `filter` is expensive to rasterise and cheap to re-composite. Keeping the
   * blur on a static element means it is computed once per track, while the
   * ancestor animates `transform` only — a compositor-thread property that
   * needs no layout, no paint and no re-blur per frame. Animating the blurred
   * element itself, or animating `inset`/`background-position` instead, would
   * put that work on every frame of a 96-second loop that never stops.
   *
   * The crossfade is the hero's, for the hero's reason: the wash must not
   * blink to black between tracks either.
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
    /**
     * The small artwork variant (`artworkSources().backdrop`), or `null` for a
     * track with no images — which shows the flat surface, since a wash with
     * no album to derive from would be an invention.
     */
    src: string | null;
    /** Injected for the same reason as `Hero`: jsdom decodes nothing. */
    decode?: ((image: DecodableImage) => Promise<void>) | undefined;
  }

  const { src, decode = decodeImage }: Props = $props();

  let sequence = 1;
  // svelte-ignore state_referenced_locally
  let layers = $state<readonly ArtworkLayer[]>(requestLayer([], src, sequence));

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
      layers = failLayer(layers, id);
      return;
    }
    layers = settleLayer(layers, id);
  };
</script>

<div class="backdrop" aria-hidden="true">
  <div class="drift">
    {#each layers as layer (layer.id)}
      <img
        class="wash"
        src={layer.src}
        alt=""
        data-ready={layer.ready}
        decoding="async"
        onload={(event) => {
          // Svelte types `onload`'s `currentTarget` as a bare `Element` — its
          // generic defaults, not a claim about this element, which is the
          // `<img>` the handler is attached to.
          void loaded(layer.id, event.currentTarget as HTMLImageElement);
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
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    /* The drift is deliberately larger than the panel; this is what keeps the
       overhang off the rest of the layout. */
    overflow: hidden;
    background: var(--joshify-surface);
    transition: background var(--jf-theme-fade) ease;
  }

  /* Oversized so that no amount of pan or zoom can bring an edge of the image
     into the panel: 124% wide before a scale that never drops below 1.12. */
  .drift {
    position: absolute;
    inset: -12%;
    animation: jf-drift 96s ease-in-out infinite alternate;
    will-change: transform;
  }

  @keyframes jf-drift {
    from {
      transform: translate3d(-2.5%, -1.5%, 0) scale(1.12);
    }
    to {
      transform: translate3d(2.5%, 2%, 0) scale(1.26);
    }
  }

  .wash {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--jf-theme-fade) ease;
    /* Most of the blur is the upscale; this only removes its grid. Saturation
       is lifted because blurring averages colour towards grey, and the wash is
       supposed to read as the album's colour. Brightness is held down because
       it sits behind the artwork and under the plate — it is a glow, not a
       second picture, and a bright one at 2am is a lamp (D-036). */
    filter: blur(28px) saturate(1.5) brightness(0.55);
  }

  .wash[data-ready='true'] {
    opacity: 1;
  }

  /* The drift stops entirely rather than slowing down. Reduced motion is a
     request for no motion, and the tokens already zero the crossfade to match
     (tokens.css). The scale is kept so the framing does not jump. */
  @media (prefers-reduced-motion: reduce) {
    .drift {
      animation: none;
      transform: scale(1.12);
    }
  }
</style>
