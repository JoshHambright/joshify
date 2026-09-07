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
    /**
     * False while the visualiser has the panel. The stage stays — SCREENS.md
     * is explicit that the album does not go anywhere — so this hides the rail
     * and the plate and nothing else.
     */
    chromeVisible?: boolean;
  }

  const { rail, stage, plate, chromeVisible = true }: Props = $props();
</script>

<div class="frame">
  <div class="panel">
    <div class="stage">
      {@render stage?.()}
    </div>
    <div class="rail" data-chrome={chromeVisible}>
      {@render rail?.()}
    </div>
    <div class="plate" data-chrome={chromeVisible}>
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

  /*
   * Hidden, and unclickable while hidden. `pointer-events` is the load-bearing
   * half: a faded-out plate that still takes touches means the tap meant to
   * bring the controls back also lands on whatever control it was over — the
   * same mistake D-067 avoids in the mode machine, made again in CSS.
   */
  .rail[data-chrome='false'],
  .plate[data-chrome='false'] {
    opacity: 0;
    pointer-events: none;
  }

  .rail,
  .plate {
    transition: opacity var(--jf-theme-fade) ease;
  }
</style>
