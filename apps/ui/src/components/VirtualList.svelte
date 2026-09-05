<script lang="ts" generics="T">
  /**
   * A long list that only draws what is on screen (P6-04).
   *
   * Three boxes: a scrolling viewport, a sizer as tall as the whole list so the
   * scrollbar and the flick physics tell the truth about its length, and a
   * window of real rows pushed down to where they belong. Everything above and
   * below is a number, not a DOM node.
   *
   * **The height is a prop, not a measurement.** The panel is a fixed 720×1280
   * (D-039), so the list's box is arithmetic the caller already did — and a
   * measured height would be unassertable anyway, since jsdom reports every
   * element as 0×0 (D-043's consequence: logic that needs a real layout is
   * logic no test can check). The window arithmetic itself lives in
   * `lib/virtual.ts` and is asserted in Node.
   *
   * `translate` rather than a spacer element for the offset: it moves the
   * window on the compositor instead of relaying out the list on every frame
   * of a flick, which is the difference between a scroll that keeps up on a Pi
   * and one that does not.
   */
  import type { Snippet } from 'svelte';
  import {
    DEFAULT_OVERSCAN,
    DEFAULT_ROW_HEIGHT,
    virtualWindow,
    type VirtualWindow,
  } from '../lib/virtual.js';

  interface Props {
    items: readonly T[];
    /** Height of the scrolling box in CSS px. Known, never measured. */
    height: number;
    rowHeight?: number | undefined;
    overscan?: number | undefined;
    /** Stable per row, so scrolling reuses the right DOM node. */
    keyOf: (item: T, index: number) => string;
    /** Rendered for each row, with its absolute index in the whole list. */
    row: Snippet<[T, number]>;
    /** Fired whenever the window moves — the hook a pager hangs off. */
    onWindowChange?: ((view: VirtualWindow) => void) | undefined;
    label?: string | undefined;
  }

  const {
    items,
    height,
    rowHeight = DEFAULT_ROW_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    keyOf,
    row,
    onWindowChange,
    label,
  }: Props = $props();

  let scrollTop = $state(0);

  const view = $derived(
    virtualWindow({
      itemCount: items.length,
      rowHeight,
      viewportHeight: height,
      scrollTop,
      overscan,
    }),
  );

  const windowed = $derived(items.slice(view.startIndex, view.endIndex));

  $effect(() => {
    onWindowChange?.(view);
  });
</script>

<div
  class="viewport"
  style="height: {height}px"
  role="list"
  aria-label={label}
  onscroll={(event) => {
    scrollTop = event.currentTarget.scrollTop;
  }}
>
  <div class="sizer" style="height: {view.totalHeight}px">
    <div class="window" style="transform: translateY({view.padTop}px)">
      {#each windowed as item, offset (keyOf(item, view.startIndex + offset))}
        <div class="row" role="listitem" style="height: {rowHeight}px">
          {@render row(item, view.startIndex + offset)}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .viewport {
    overflow-y: auto;
    /* The panel itself never scrolls (D-039). Without this, flicking past the
       end of the list hands the scroll to the page behind it and the whole
       layout moves — which on a kiosk is simply broken. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .sizer {
    position: relative;
  }

  .window {
    /* `will-change` is deliberate rather than habitual: this element is
       transformed on every scroll frame, which is exactly the case it is for. */
    will-change: transform;
  }

  .row {
    box-sizing: border-box;
  }
</style>
