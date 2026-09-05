<script lang="ts">
  /**
   * The glass plate (D-040, D-041).
   *
   * One surface, floating over the album, that grows to hold whatever you are
   * doing. Nothing ever navigates away from the artwork; the plate simply
   * covers more of it.
   *
   * `backdrop-filter` is real here — the Pi 5's VideoCore VII accelerates it
   * (D-041), and it is the one effect a pre-rendered blur genuinely cannot
   * fake, because what it blurs changes with what is behind it. The
   * `@supports` fallback is an opaque tint of the same hue, so a browser
   * without it looks plainer rather than illegible.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
  }

  const { children }: Props = $props();
</script>

<section class="plate">
  {@render children?.()}
</section>

<style>
  .plate {
    box-sizing: border-box;
    padding: var(--jf-pad-plate);
    border: 1px solid var(--jf-plate-edge);
    border-radius: var(--jf-plate-radius);
    background: var(--jf-plate-solid);
  }

  @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
    .plate {
      background: var(--jf-plate);
      -webkit-backdrop-filter: blur(var(--jf-plate-blur)) saturate(1.4);
      backdrop-filter: blur(var(--jf-plate-blur)) saturate(1.4);
    }
  }
</style>
