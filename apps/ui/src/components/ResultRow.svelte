<script lang="ts">
  /**
   * One result: artwork, two lines of text, one fact on the right (P6-03).
   *
   * The whole row is a single button. Unlike a device row, there is nothing
   * else on it to touch — Spotify has no reorder and no remove (D-007), so
   * "play this" is the only thing a search result can do, and an affordance
   * that cannot work is worse than a missing one.
   *
   * The row height is a prop rather than a style, because the virtual list
   * divides by it. If the two ever disagree the list scrolls to the wrong
   * place, so there is exactly one number and it is passed in.
   */
  import Thumbnail from './Thumbnail.svelte';
  import { rowMeta, type LibraryItem, type ThumbnailCache } from '../lib/thumbnails.js';
  import { DEFAULT_ROW_HEIGHT } from '../lib/virtual.js';

  interface Props {
    item: LibraryItem;
    cache: ThumbnailCache;
    onPlay: (item: LibraryItem) => void;
    height?: number | undefined;
  }

  const { item, cache, onPlay, height = DEFAULT_ROW_HEIGHT }: Props = $props();

  const meta = $derived(rowMeta(item));
  // A track with no artist and a playlist with no owner both legitimately have
  // an empty second line. The line is dropped rather than drawn empty, so the
  // title centres itself instead of sitting high in the row.
  const subtitle = $derived(item.subtitle === '' ? null : item.subtitle);
</script>

<button
  class="row"
  type="button"
  style="height: {height}px"
  data-kind={item.kind}
  onclick={() => {
    onPlay(item);
  }}
>
  <Thumbnail
    images={item.images}
    cacheKey={item.uri}
    {cache}
    round={item.kind === 'artist'}
  />

  <span class="text">
    <span class="title">{item.title}</span>
    {#if subtitle !== null}
      <span class="jf-label subtitle">{subtitle}</span>
    {/if}
  </span>

  {#if meta !== ''}
    <span class="jf-data meta">{meta}</span>
  {/if}
</button>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--jf-gap);
    box-sizing: border-box;
    width: 100%;
    padding: 0 var(--jf-gap);
    border: none;
    border-radius: 14px;
    background: transparent;
    color: var(--jf-ink);
    text-align: left;
    /* No hover state anywhere on this device. `:active` is the only feedback,
       and it has to be instant because the network is not (SCREENS.md). */
    transition: background var(--jf-press) ease;
  }

  .row:active {
    background: rgb(255 255 255 / 0.09);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* Without this the flex item refuses to shrink and the ellipsis below
       never engages — the meta column gets pushed off the panel instead. */
    min-width: 0;
    flex: 1;
  }

  .title {
    font-family: var(--jf-face-display);
    font-size: var(--jf-size-body);
    font-weight: 700;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .subtitle {
    color: var(--jf-ink-dim);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .meta {
    flex: none;
    color: var(--jf-ink-faint);
  }
</style>
