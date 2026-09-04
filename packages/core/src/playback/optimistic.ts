/**
 * The gap between tapping a control and Spotify agreeing that you did.
 *
 * A command is a network round trip, and the truth only arrives on the poll
 * after it (P2-03) — up to a few seconds later. So the change is applied
 * locally the moment the finger lands, and reconciled when reality catches up.
 *
 * What makes that more than a one-line overlay is that reality can disagree
 * for three different reasons, and only one of them means we were wrong:
 *
 *  1. **The command has not landed yet.** A Connect device does not apply a
 *     write the instant it returns 204 (D-025) — a speaker or a cast target
 *     takes a beat — so a poll that still reports the old value milliseconds
 *     later is stale and honest at the same time. Believing it makes the
 *     button visibly bounce back and then forward again a second later, which
 *     reads as a broken control rather than a slow one.
 *  2. **The command failed.** The change has to go, and immediately: there is
 *     nothing to wait for.
 *  3. **Somebody else changed it.** A phone hit pause, a laptop turned shuffle
 *     off. We are simply wrong, and holding on fights the other device.
 *
 * (1) and (3) are separated on two axes, not one. Time is the obvious axis: a
 * stale reading stays credible only for as long as a device plausibly takes to
 * obey. The second axis is *which* value came back. A poll reporting the value
 * we were trying to replace is consistent with a command still in flight; a
 * poll reporting a third value — one we never set and were not replacing —
 * cannot be, whatever the clock says, so it is adopted at once. That axis is
 * what catches the other-device case within a single poll instead of making
 * the user watch a wrong control for a whole settle window.
 *
 * Pending changes are held per field. Tapping shuffle must not disturb a
 * volume drag that is still in flight, and a poll confirming one says nothing
 * about the other — they are different writes to different endpoints that land
 * whenever they land.
 *
 * Pure, and with no clock of its own: every instant is a monotonic reading
 * passed in by the caller (D-023).
 */
import type { PlaybackState, PlayingItem, RepeatMode } from './state.js';
import { playingItemKey } from './item-key.js';

/** The fields of `PlaybackState` a command can move ahead of the truth. */
export type OptimisticField =
  'isPlaying' | 'shuffle' | 'repeat' | 'volumePercent' | 'progressMs';

/**
 * A command as the UI issues it, in the vocabulary of the buttons rather than
 * of the fields they move — `next` moves `progressMs`, which is not something
 * a caller should have to know.
 */
export type OptimisticChange =
  | { readonly kind: 'play' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'shuffle'; readonly enabled: boolean }
  | { readonly kind: 'repeat'; readonly mode: RepeatMode }
  | { readonly kind: 'volume'; readonly volumePercent: number }
  | { readonly kind: 'seek'; readonly positionMs: number }
  | { readonly kind: 'next' }
  | { readonly kind: 'previous' };

/**
 * A receipt for one applied change, handed back to `fail` if the command it
 * accompanied did not go through.
 *
 * It carries a sequence number because a second tap on the same control
 * supersedes the first, and the two commands then fail out of order as often
 * as not. Rolling back on the field alone would let a stale failure delete the
 * change the user is currently looking at.
 */
export interface PendingChange {
  readonly field: OptimisticField;
  readonly seq: number;
}

export interface OptimisticPlaybackOptions {
  /** How long a poll may keep reporting the pre-command value. See `apply`. */
  readonly settleWindowMs?: number | undefined;
  /** How far a reported position may sit from an expected one. See `apply`. */
  readonly seekToleranceMs?: number | undefined;
}

/**
 * Long enough to cover a slow round trip plus the delay a Connect device adds
 * before it obeys — a cast target or a receiver is much slower about this than
 * the desktop client, and the after-command poll burst (D-025) fires several
 * times inside this window. Short enough that a command which silently does
 * nothing is on screen for a moment rather than for a song. A command that
 * fails *loudly* never waits for this at all; `fail` rolls it back at once.
 */
export const DEFAULT_SETTLE_WINDOW_MS = 2_500;

/**
 * A reported position is never exactly the expected one: `progress_ms` is
 * sampled on the device and spends a round trip in flight, and Spotify reports
 * it coarsely (D-024). This is the same order as the interpolator's rewind
 * tolerance, with room for the error in our own estimate of how far playback
 * moved since the command.
 */
export const DEFAULT_SEEK_TOLERANCE_MS = 2_000;

export interface OptimisticPlayback {
  /** What the UI should draw: last polled truth with pending changes over it. */
  readonly state: PlaybackState;
  /** Fields currently showing an unconfirmed value, in a stable order. */
  readonly pending: readonly OptimisticField[];
  /**
   * Monotonic reading of the most recent command, or null if none has been
   * issued. Feeds `msSinceCommand` on the poll scheduler (P2-03), which is how
   * the reconciling polls this module needs actually get requested.
   */
  readonly lastCommandAtMs: number | null;
  /** Apply a change now. Returns the receipt to hand `fail`, if any. */
  apply(change: OptimisticChange, monotonicMs: number): PendingChange | null;
  /** Reconcile against a freshly polled state observed at `monotonicMs`. */
  reconcile(polled: PlaybackState, monotonicMs: number): void;
  /** Roll back the change a failed command applied. Null receipts are a no-op. */
  fail(pending: PendingChange | null): void;
}

interface PendingEntry<T> {
  readonly seq: number;
  readonly value: T;
  /**
   * What a poll still reports if this command has not landed — which is the
   * value that was *on screen* when it was issued, not the last polled truth.
   * With an earlier command still in flight the two differ, and it is the
   * on-screen one that a lagging poll echoes back.
   */
  readonly baseline: T;
  readonly appliedAt: number;
}

interface SeekEntry extends PendingEntry<number> {
  readonly itemKey: string | null;
  /** Whether a change of item invalidates this position. See `apply`. */
  readonly survivesItemChange: boolean;
}

interface PendingSet {
  isPlaying: PendingEntry<boolean> | null;
  shuffle: PendingEntry<boolean> | null;
  repeat: PendingEntry<RepeatMode> | null;
  volumePercent: PendingEntry<number> | null;
  progressMs: SeekEntry | null;
}

const FIELDS: readonly OptimisticField[] = [
  'isPlaying',
  'shuffle',
  'repeat',
  'volumePercent',
  'progressMs',
];

export const createOptimisticPlayback = (
  state: PlaybackState,
  options: OptimisticPlaybackOptions = {},
): OptimisticPlayback => {
  const settleWindowMs = options.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
  const seekToleranceMs = options.seekToleranceMs ?? DEFAULT_SEEK_TOLERANCE_MS;

  const slots: PendingSet = {
    isPlaying: null,
    shuffle: null,
    repeat: null,
    volumePercent: null,
    progressMs: null,
  };

  let base = state;
  let rendered = state;
  let lastCommandAtMs: number | null = null;
  let seq = 0;

  /**
   * Recomputed on every mutation rather than on every read, so that a screen
   * redrawing at refresh rate gets the same object back until something
   * actually changes — with nothing pending, that object *is* the polled
   * state, and downstream memoisation can compare by identity.
   */
  const refresh = (): void => {
    let next = base;

    const playing = slots.isPlaying;
    if (playing !== null) next = { ...next, isPlaying: playing.value };

    const shuffle = slots.shuffle;
    if (shuffle !== null) next = { ...next, shuffle: shuffle.value };

    const repeat = slots.repeat;
    if (repeat !== null) next = { ...next, repeat: repeat.value };

    // Held at the requested position rather than advanced: this module reports
    // a snapshot, and moving the bar between polls belongs to the interpolator
    // (P2-04), which anchors on whatever this reports.
    const seek = slots.progressMs;
    if (seek !== null) next = { ...next, progressMs: seek.value };

    const volume = slots.volumePercent;
    const device = next.device;
    if (volume !== null && device !== null) {
      next = { ...next, device: { ...device, volumePercent: volume.value } };
    }

    rendered = next;
  };

  const makeEntry = <T>(value: T, baseline: T, appliedAt: number): PendingEntry<T> => {
    seq += 1;
    return { seq, value, baseline, appliedAt };
  };

  const makeSeekEntry = (
    value: number,
    appliedAt: number,
    survivesItemChange: boolean,
  ): SeekEntry => ({
    ...makeEntry(value, rendered.progressMs, appliedAt),
    itemKey: playingItemKey(rendered.item),
    survivesItemChange,
  });

  const commit = (
    field: OptimisticField,
    entry: PendingEntry<unknown>,
  ): PendingChange => {
    refresh();
    return { field, seq: entry.seq };
  };

  /** Whether a pending change survives the reading a poll just brought back. */
  const holds = <T>(entry: PendingEntry<T>, observed: T | null, at: number): boolean => {
    if (at - entry.appliedAt > settleWindowMs) return false;
    // No reading at all — a device that went away, or one that reports no
    // volume — is not evidence against us. Wait for one that is.
    if (observed === null) return true;
    // The truth caught up: the pending change is now just the state.
    if (Object.is(observed, entry.value)) return false;
    return Object.is(observed, entry.baseline);
  };

  /**
   * The same decision for a position, where neither value being compared sits
   * still: while playback runs, both the position we asked for and the one we
   * replaced have moved on by the time the poll reports one of them.
   */
  const seekHolds = (seek: SeekEntry, polled: PlaybackState, at: number): boolean => {
    const elapsed = at - seek.appliedAt;
    if (elapsed > settleWindowMs) return false;
    // A different track means somebody skipped, and a position measured
    // against the previous one says nothing about this one.
    if (!seek.survivesItemChange && playingItemKey(polled.item) !== seek.itemKey)
      return false;

    const drift = polled.isPlaying ? elapsed : 0;
    const near = (expected: number): boolean =>
      Math.abs(polled.progressMs - (expected + drift)) <= seekToleranceMs;

    if (near(seek.value)) return false;
    return near(seek.baseline);
  };

  return {
    get state() {
      return rendered;
    },
    get pending() {
      return FIELDS.filter((field) => slots[field] !== null);
    },
    get lastCommandAtMs() {
      return lastCommandAtMs;
    },

    /**
     * Every command is worth recording even when it moves no field, because
     * the poll scheduler keys its reconciliation burst off `lastCommandAtMs`.
     *
     * `next` and `previous` are the interesting case. The *item* they produce
     * is unknowable from here — the queue is a separate request, shuffle makes
     * the choice non-deterministic, and repeat-one makes it the current track
     * — and drawing a guessed title and cover that a poll then replaces is a
     * worse experience than drawing the truth a second late. But the
     * *position* is knowable: whatever arrives, it starts at the beginning, so
     * the progress bar snaps to zero immediately and only the item lags. That
     * pending position is marked as surviving an item change, because the item
     * changing is precisely what it is waiting for.
     */
    apply: (change: OptimisticChange, monotonicMs: number): PendingChange | null => {
      lastCommandAtMs = monotonicMs;

      switch (change.kind) {
        case 'play':
        case 'pause': {
          const entry = makeEntry(
            change.kind === 'play',
            rendered.isPlaying,
            monotonicMs,
          );
          slots.isPlaying = entry;
          return commit('isPlaying', entry);
        }
        case 'shuffle': {
          const entry = makeEntry(change.enabled, rendered.shuffle, monotonicMs);
          slots.shuffle = entry;
          return commit('shuffle', entry);
        }
        case 'repeat': {
          const entry = makeEntry(change.mode, rendered.repeat, monotonicMs);
          slots.repeat = entry;
          return commit('repeat', entry);
        }
        case 'volume': {
          // A device reporting no volume is one whose volume lives outside
          // Spotify (D-022) — a TV, a receiver. There is nothing to move, and
          // no baseline to roll back to, so nothing is pending either.
          const current = rendered.device?.volumePercent ?? null;
          if (current === null) return null;
          const entry = makeEntry(change.volumePercent, current, monotonicMs);
          slots.volumePercent = entry;
          return commit('volumePercent', entry);
        }
        case 'seek': {
          const entry = makeSeekEntry(change.positionMs, monotonicMs, false);
          slots.progressMs = entry;
          return commit('progressMs', entry);
        }
        case 'next':
        case 'previous': {
          const entry = makeSeekEntry(0, monotonicMs, true);
          slots.progressMs = entry;
          return commit('progressMs', entry);
        }
      }
    },

    reconcile: (polled: PlaybackState, monotonicMs: number): void => {
      base = polled;

      const playing = slots.isPlaying;
      if (playing !== null && !holds(playing, polled.isPlaying, monotonicMs)) {
        slots.isPlaying = null;
      }

      const shuffle = slots.shuffle;
      if (shuffle !== null && !holds(shuffle, polled.shuffle, monotonicMs)) {
        slots.shuffle = null;
      }

      const repeat = slots.repeat;
      if (repeat !== null && !holds(repeat, polled.repeat, monotonicMs)) {
        slots.repeat = null;
      }

      const volume = slots.volumePercent;
      const observedVolume = polled.device?.volumePercent ?? null;
      if (volume !== null && !holds(volume, observedVolume, monotonicMs)) {
        slots.volumePercent = null;
      }

      const seek = slots.progressMs;
      if (seek !== null && !seekHolds(seek, polled, monotonicMs)) {
        slots.progressMs = null;
      }

      refresh();
    },

    fail: (pending: PendingChange | null): void => {
      if (pending === null) return;
      // A later tap on the same control already replaced this change; the
      // failure belongs to a command nobody is looking at any more.
      if (slots[pending.field]?.seq !== pending.seq) return;
      slots[pending.field] = null;
      refresh();
    },
  };
};
