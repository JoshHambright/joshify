/**
 * The Queue screen's decisions, as pure functions.
 *
 * The screen itself is markup; everything that could be *wrong* about it lives
 * here, in Node-testable functions: how the rows are numbered, what identifies
 * a row when the same track is queued twice, how tall the scrolling box is,
 * and — the part that took the most thought — which of "loading", "empty",
 * "nothing after this" and "could not read it" the panel is actually in.
 *
 * ## What a queue row can do: nothing, and the UI says so (P4-05)
 *
 * SCREENS.md says "tapping a row skips forward to it". That sentence describes
 * an endpoint Spotify does not have. The Web API's entire queue surface is
 * `GET /me/player/queue` and add-to-queue: **no reorder, no remove, and no
 * jump-to-position** (D-007, PRODUCT.md §6). The only forward motion the panel
 * owns is `next`, one track at a time.
 *
 * So the honest options for a tap on row *n* are:
 *
 * 1. **Fire `next` n times.** Rejected. It is not one action: it is n separate
 *    writes with no transaction around them. Any one of them can be refused or
 *    rate-limited (D-025), the queue itself refills from the play context while
 *    the burst is in flight, and there is no undo — `previous` does not walk
 *    back through a skip run. Asking for track seven and landing on track four
 *    with no way home is worse than the tap doing nothing at all.
 * 2. **Make only the first upcoming row tappable**, since exactly one `next`
 *    genuinely reaches it. Rejected too, for a subtler reason: it is honest but
 *    it teaches a lie. A list in which the top row responds to touch is a list
 *    that has promised the other rows respond, and every tap after the first is
 *    a panel that appears broken. It also buys nothing — the skip glyph on the
 *    plate already sends that exact command.
 *
 * Which leaves: **rows are inert, and the screen says why in one line.** That
 * line is {@link QUEUE_VIEW_ONLY_NOTE}, it lives here so it is asserted in
 * Node rather than eyeballed, and it is the whole of P4-05. An affordance that
 * cannot work is worse than a missing one; a missing affordance with no
 * explanation is a close second, which is why the sentence is not optional.
 */
import { playingItemKey } from '@joshify/core';
import type { JoshifyError, PlaybackQueue, PlayingItem } from '@joshify/core';

/** 76px rows: position, title, artist (SCREENS.md). */
export const QUEUE_ROW_HEIGHT = 76;

/**
 * How many upcoming rows the grown plate shows before the list scrolls inside
 * itself. Eight is what fits under the pinned current row without pushing the
 * album off the panel — and the panel itself never scrolls (D-039).
 */
export const QUEUE_VISIBLE_ROWS = 8;

export interface QueueEntry {
  readonly item: PlayingItem;
  /** Stable per row, so a poll that shifts the queue reuses the right node. */
  readonly key: string;
  /** 1-based place in the upcoming list; null on the pinned current row. */
  readonly position: number | null;
  readonly isCurrent: boolean;
}

/**
 * Position *and* identity, because neither alone is enough.
 *
 * A queue legitimately holds the same track twice — added twice, or repeated by
 * the context — so keying on identity would make Svelte reuse one row's DOM for
 * the other. Keying on position alone would hold a row still while the track
 * inside it changed, which is how a list appears to update everything except
 * the row you were reading.
 */
const entryKey = (item: PlayingItem, position: number | null): string =>
  `${position === null ? 'now' : String(position)}:${playingItemKey(item)}`;

/** The item playing right now, pinned above the list, or null if nothing is. */
export const currentEntry = (queue: PlaybackQueue): QueueEntry | null =>
  queue.current === null
    ? null
    : {
        item: queue.current,
        key: entryKey(queue.current, null),
        position: null,
        isCurrent: true,
      };

/** What follows, numbered from one. */
export const upcomingEntries = (queue: PlaybackQueue): readonly QueueEntry[] =>
  queue.upcoming.map((item, index) => ({
    item,
    key: entryKey(item, index + 1),
    position: index + 1,
    isCurrent: false,
  }));

/** Everything the screen draws as a row, current included — the chip's count. */
export const queueLength = (queue: PlaybackQueue): number =>
  queue.upcoming.length + (queue.current === null ? 0 : 1);

/**
 * The number in the row's left column, or `NOW`.
 *
 * The current row is deliberately not numbered `0` or `1`: it is not somewhere
 * in the order, it is the thing the order is counted from.
 */
export const positionLabel = (entry: QueueEntry): string =>
  entry.position === null ? 'NOW' : String(entry.position);

/**
 * Which sentence the screen is in.
 *
 * Four states rather than two, because "empty" hides two genuinely different
 * facts. A queue with a track playing and nothing after it is a full account
 * behaving normally — the context simply keeps going — while a queue with
 * nothing at all in it means nothing is playing anywhere. Telling the viewer
 * the same thing in both cases would be wrong in one of them.
 */
export type QueueStatus = 'loading' | 'unreachable' | 'empty' | 'nothing-next' | 'ready';

export interface QueueView {
  readonly hasCurrent: boolean;
  readonly upcomingCount: number;
  /** True until the first answer lands, so the screen can say "reading" once. */
  readonly pending: boolean;
  /** The last failure, or null. Rows already on screen survive it. */
  readonly problem: JoshifyError | null;
}

export const queueStatus = (view: QueueView): QueueStatus => {
  // Rows beat everything, a failure included: a refresh that could not be
  // confirmed is no reason to replace a list somebody is reading with an
  // apology (D-049's failure rule, applied to this screen).
  if (view.upcomingCount > 0) return 'ready';
  if (view.hasCurrent) return 'nothing-next';
  if (view.pending) return 'loading';
  return view.problem === null ? 'empty' : 'unreachable';
};

/**
 * What the screen says in that state. Null once there are rows to read.
 *
 * None of these is an error and none of them is a spinner: an empty queue is a
 * state, and a queue we could not re-read is last-known truth plus a caveat.
 */
export const queueStatusMessage = (status: QueueStatus): string | null => {
  switch (status) {
    case 'ready':
      return null;
    case 'loading':
      return 'Reading the queue.';
    case 'nothing-next':
      return 'Nothing queued after this one. What follows comes from the album or playlist it is playing from.';
    case 'empty':
      return 'Nothing queued. Start something playing and what comes next shows up here.';
    case 'unreachable':
      return 'The queue could not be read just now. It fills in as soon as the panel reaches the server again.';
  }
};

/**
 * The one line that explains why nothing on this screen can be touched.
 *
 * Reasoned out at the top of this file. It is deliberately about Spotify's API
 * rather than about Joshify: the viewer is not being told a feature is missing,
 * they are being told the thing they are about to try is not possible from any
 * client, which is the only version of this sentence that is true.
 */
export const QUEUE_VIEW_ONLY_NOTE =
  'View only. Spotify offers no way to reorder, remove or jump to a queued track — skip plays the next one.';

/** Shown only when there is a list to explain; on an empty screen it is noise. */
export const queueViewOnlyNote = (upcomingCount: number): string | null =>
  upcomingCount > 0 ? QUEUE_VIEW_ONLY_NOTE : null;

/**
 * How tall the scrolling box is, in px.
 *
 * Arithmetic, not a measurement: the panel is a fixed 720×1280 (D-039), so the
 * height is a number the caller already knows — and a measured one would be
 * unassertable anyway, since jsdom reports every element as 0×0. A short queue
 * gets a short box rather than a tall one with a hole in it.
 */
export const queueListHeight = (
  upcomingCount: number,
  visibleRows = QUEUE_VISIBLE_ROWS,
): number => Math.max(0, Math.min(upcomingCount, visibleRows)) * QUEUE_ROW_HEIGHT;
