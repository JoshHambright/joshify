<script lang="ts">
  /**
   * The album, full bleed. `object-fit: cover` — the art fills the device and
   * is cropped rather than letterboxed, because the whole design rests on the
   * album *being* the background (D-040).
   *
   * With no artwork — a local file, some podcasts, the moment before the first
   * fetch — this is a flat surface tint rather than a placeholder graphic. A
   * missing-image glyph on a 1280px screen reads as a fault; a plain dark
   * panel reads as a design.
   */
  interface Props {
    src: string | null;
    /** Used as the crossfade key: a new track fades in over the old one. */
    trackKey: string | null;
  }

  const { src, trackKey }: Props = $props();
</script>

<div class="stage">
  {#key trackKey}
    {#if src !== null}
      <img class="art" {src} alt="" decoding="async" />
    {/if}
  {/key}
</div>

<style>
  .stage {
    position: absolute;
    inset: 0;
    background: var(--joshify-surface);
    transition: background var(--jf-theme-fade) ease;
  }

  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Nudged darker so the plate and rail have something to sit on even over a
       white sleeve. The scrim does the rest where it matters. */
    filter: brightness(0.86);
  }
</style>
