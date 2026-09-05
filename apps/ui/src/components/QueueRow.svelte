<script lang="ts">
  /**
   * One queue row: 76px of position, title, artist and length (SCREENS.md).
   *
   * **It is not a button, and it has no press state, because there is nothing
   * for a press to do.** Spotify has no reorder, no remove and no
   * jump-to-position endpoint — the reasoning is worked through in full at the
   * top of `lib/queue.ts`, and the short version is that the only forward
   * command the panel owns is `next`, one track at a time. A row that lit up
   * under a finger and then did nothing would teach the viewer that the panel
   * is broken, which is worse than a row that never claimed to be touchable
   * (D-007, D-047). `QueueList` carries the sentence that says so.
   *
   * The current item is marked rather than numbered: it is not a place in the
   * order, it is where the order is counted from.
   */
  import { positionLabel, type QueueEntry } from '../lib/queue.js';
  import { formatTime } from '../lib/format.js';

  interface Props {
    entry: QueueEntry;
  }

  const { entry }: Props = $props();

  // A local file with no artist tag legitimately has an empty second line. The
  // line is dropped rather than drawn empty, so the title centres itself in the
  // row instead of sitting high in it.
  const subtitle = $derived(entry.item.subtitle === '' ? null : entry.item.subtitle);
</script>

<div class="queue-row" class:current={entry.isCurrent}>
  <span class="jf-data position">{positionLabel(entry)}</span>

  <span class="text">
    <span class="title">{entry.item.title}</span>
    {#if subtitle !== null}
      <span class="jf-label subtitle">{subtitle}</span>
    {/if}
  </span>

  <span class="jf-data length">{formatTime(entry.item.durationMs)}</span>
</div>

<style>
  .queue-row {
    display: flex;
    align-items: center;
    gap: var(--jf-gap);
    box-sizing: border-box;
    width: 100%;
    /* 76px per SCREENS.md. Not a touch target — nothing here is touchable —
       but the same rhythm as the rest of the panel's lists. */
    height: 76px;
    padding: 0 var(--jf-gap);
    border-radius: 14px;
    color: var(--jf-ink);
  }

  /* Deliberately no `:active` and no hover: those are press feedback, and a
     row that flashes under a finger has promised something it cannot deliver. */

  .position {
    flex: none;
    /* Wide enough for "NOW" and for a three-digit position, so the titles line
       up down the list instead of stepping right at row 10. */
    width: 46px;
    color: var(--jf-ink-faint);
    text-align: right;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* Without this the flex item refuses to shrink and the ellipsis below never
       engages — the length column gets pushed off the panel instead. */
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

  .length {
    flex: none;
    color: var(--jf-ink-faint);
  }

  /* The mark on the pinned row, and the only accent in the list: which item the
     queue is counted from is the one fact a glance at this screen should give. */
  .queue-row.current .position {
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }
</style>
