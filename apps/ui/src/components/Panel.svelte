<script lang="ts">
  /**
   * The panel: 720 × 1280, portrait, fullscreen, and nothing scrolls it.
   *
   * The stage holds the artwork full-bleed; the rail floats over the top of it
   * on its own scrim; the plate floats over the bottom and grows to hold
   * whatever you are doing. That is the whole navigation model (SCREENS.md) —
   * there is no tab bar, no back button and no page transition to design.
   *
   * On a development machine the panel is letterboxed and scaled to fit the
   * window rather than stretched, so what you see is what the device shows.
   * Scaling is on `zoom` rather than `transform`, because `transform` scales
   * the paint but not the layout box, which is exactly the bug that made the
   * first prototype overflow.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    rail?: Snippet;
    stage?: Snippet;
    plate?: Snippet;
  }

  const { rail, stage, plate }: Props = $props();
</script>

<div class="frame">
  <div class="panel">
    <div class="stage">
      {@render stage?.()}
    </div>
    <div class="rail">
      {@render rail?.()}
    </div>
    <div class="plate">
      {@render plate?.()}
    </div>
  </div>
</div>

<style>
  .frame {
    display: grid;
    place-items: center;
    width: 100vw;
    height: 100vh;
    background: #000;
  }

  .panel {
    position: relative;
    width: 720px;
    height: 1280px;
    overflow: hidden;
    background: var(--joshify-surface);
    transition: background var(--jf-theme-fade) ease;
  }

  /* The device is exactly the panel; only a desktop window needs fitting. */
  @media (min-width: 721px), (min-height: 1281px) {
    .panel {
      zoom: min(calc(100vw / 720), calc(100vh / 1280));
    }
  }

  .stage {
    position: absolute;
    inset: 0;
  }

  .rail {
    position: absolute;
    inset: 0 0 auto 0;
    height: var(--jf-rail-height);
    display: flex;
    align-items: center;
    padding: 0 var(--jf-pad-plate);
    /* Artwork up here is as unpredictable as anywhere else, so the rail brings
       its own gradient rather than trusting the image behind it. */
    background: var(--jf-scrim);
  }

  .plate {
    position: absolute;
    inset: auto var(--jf-gap) var(--jf-gap) var(--jf-gap);
  }
</style>
