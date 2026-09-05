<script lang="ts">
  /**
   * Queue — the plate, grown (P4-04, P4-05).
   *
   * The same glass plate as Now Playing, taller: the current item pinned at the
   * top with a mark, and what follows in a scrolling list of 76px rows. Nothing
   * navigates away from the album to get here.
   *
   * ## Nothing on this screen can be touched, and the screen says so
   *
   * SCREENS.md says a tap "skips forward to it". That endpoint does not exist.
   * Spotify's whole queue surface is a read and an append: **no reorder, no
   * remove, no jump-to-position** (D-007, PRODUCT.md §6). The only forward
   * command the panel owns is `next`, which advances exactly one track.
   *
   * Firing `next` n times to reach row n was considered and rejected: it is n
   * unrelated writes with no transaction around them, any of which can be
   * refused or rate-limited (D-025) while the queue refills from the play
   * context underneath, and `previous` cannot walk the burst back. Asking for
   * row seven and landing on row four with no way home is worse than a tap that
   * does nothing.
   *
   * Making *only* the first upcoming row tappable was rejected too, and this is
   * the less obvious half of P4-05. One `next` genuinely reaches it, so the tap
   * would be honest — but a list whose top row responds to touch has promised
   * that the rest do, and every tap after the first then reads as a broken
   * panel. It also adds nothing: the skip glyph on the plate already sends that
   * command.
   *
   * So the rows are inert and {@link QUEUE_VIEW_ONLY_NOTE} explains why, in one
   * line, in terms of Spotify rather than of Joshify — because the viewer is
   * not being told a feature is missing, they are being told the thing they
   * were about to try is impossible from any client. An affordance that cannot
   * work is worse than a missing one (D-007, D-047); a missing one with no
   * explanation is a close second.
   *
   * The queue arrives as a prop. Fetching it belongs to `lib/queue-source.ts`
   * and every decision it makes about numbering, identity and which sentence to
   * show belongs to `lib/queue.ts` — this renders what it is told.
   */
  import type { JoshifyError, PlaybackQueue } from '@joshify/core';
  import QueueRow from './QueueRow.svelte';
  import VirtualList from './VirtualList.svelte';
  import {
    currentEntry,
    QUEUE_ROW_HEIGHT,
    queueLength,
    queueListHeight,
    queueStatus,
    queueStatusMessage,
    queueViewOnlyNote,
    upcomingEntries,
    type QueueEntry,
  } from '../lib/queue.js';

  interface Props {
    queue: PlaybackQueue;
    /** True until the first answer lands, so "reading" is said once. */
    pending?: boolean | undefined;
    /** The last failure, or null. Rows already on screen survive it. */
    problem?: JoshifyError | null | undefined;
    /** Height of the scrolling box. A prop because it is arithmetic the
     *  caller already did (D-039), and because jsdom measures every element
     *  as 0×0 — a measured height is one no test can check. */
    height?: number | undefined;
  }

  const { queue, pending = false, problem = null, height }: Props = $props();

  const current = $derived(currentEntry(queue));
  const upcoming = $derived(upcomingEntries(queue));
  const count = $derived(queueLength(queue));

  const message = $derived(
    queueStatusMessage(
      queueStatus({
        hasCurrent: current !== null,
        upcomingCount: upcoming.length,
        pending,
        problem,
      }),
    ),
  );

  const note = $derived(queueViewOnlyNote(upcoming.length));
  const listHeight = $derived(height ?? queueListHeight(upcoming.length));
</script>

<section class="queue" aria-label="Queue">
  <header class="head">
    <p class="jf-label heading">Queue</p>
    {#if count > 0}
      <p class="jf-data count">{count}</p>
    {/if}
  </header>

  {#if current !== null}
    <!-- Pinned outside the scroller: what is playing stays on screen however
         far down the list a finger has pushed it. -->
    <div class="now">
      <QueueRow entry={current} />
    </div>
  {/if}

  {#if upcoming.length > 0}
    <!-- A real queue can be hundreds of items and this device has a fixed
         memory budget, so only the rows in view exist (P6-04). -->
    <VirtualList
      items={upcoming}
      height={listHeight}
      rowHeight={QUEUE_ROW_HEIGHT}
      keyOf={(entry: QueueEntry) => entry.key}
      label="Up next"
    >
      {#snippet row(entry: QueueEntry)}
        <QueueRow {entry} />
      {/snippet}
    </VirtualList>
  {/if}

  {#if message !== null}
    <!-- A sentence, not a blank panel and not a spinner. An empty queue is a
         state; a queue we could not re-read is last-known truth plus a caveat. -->
    <p class="message">{message}</p>
  {/if}

  {#if note !== null}
    <p class="note">{note}</p>
  {/if}
</section>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    gap: var(--jf-gap);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--jf-gap);
  }

  .heading {
    margin: 0;
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .count {
    margin: 0;
    color: var(--jf-ink-faint);
  }

  .now {
    /* The pinned row is separated by a rule rather than by colour: the album
       behind the plate decides what any tint would look like, and the rule
       does not. */
    padding-bottom: var(--jf-gap-tight);
    border-bottom: 1px solid var(--jf-plate-edge);
  }

  .message {
    margin: 0;
    font-size: var(--jf-size-body);
    color: var(--jf-ink-dim);
  }

  /* Quieter than the rows it explains — it is a standing fact about Spotify,
     not news, and it should not compete with the titles. */
  .note {
    margin: 0;
    font-family: var(--jf-face-label);
    font-size: var(--jf-size-label);
    line-height: 1.35;
    color: var(--jf-ink-faint);
  }
</style>
