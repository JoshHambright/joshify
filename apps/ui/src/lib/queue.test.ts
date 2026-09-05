import { describe, expect, it } from 'vitest';
import type { JoshifyError, PlaybackQueue, PlayingItem } from '@joshify/core';
import {
  currentEntry,
  positionLabel,
  QUEUE_ROW_HEIGHT,
  QUEUE_VIEW_ONLY_NOTE,
  queueLength,
  queueListHeight,
  queueStatus,
  queueStatusMessage,
  queueViewOnlyNote,
  upcomingEntries,
  type QueueStatus,
} from './queue.js';

const track = (over: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Xtal',
  subtitle: 'Aphex Twin',
  durationMs: 293_000,
  images: [],
  isLocal: false,
  ...over,
});

const queue = (over: Partial<PlaybackQueue> = {}): PlaybackQueue => ({
  current: track(),
  upcoming: [],
  ...over,
});

const offline: JoshifyError = {
  kind: 'network',
  message: 'the panel could not reach the Joshify server',
  retryable: true,
};

describe('the queue rows', () => {
  it('numbers what is coming from one, in the order Spotify gave', () => {
    const rows = upcomingEntries(
      queue({
        upcoming: [
          track({ id: 'a', title: 'Tha' }),
          track({ id: 'b', title: 'Pulsewidth' }),
        ],
      }),
    );

    expect(rows.map((row) => row.position)).toEqual([1, 2]);
    expect(rows.map((row) => row.item.title)).toEqual(['Tha', 'Pulsewidth']);
  });

  // The current item is not somewhere in the order; it is the thing the order
  // is counted from, so it is pinned and marked rather than numbered.
  it('pins the current item with a mark instead of a number', () => {
    const row = currentEntry(queue({ current: track({ title: 'Xtal' }) }));

    expect(row?.isCurrent).toBe(true);
    expect(row?.position).toBeNull();
    expect(row === null ? '' : positionLabel(row)).toBe('NOW');
  });

  it('has no current row when nothing is playing', () => {
    expect(currentEntry(queue({ current: null }))).toBeNull();
  });

  it('numbers an upcoming row by its place in the list', () => {
    const rows = upcomingEntries(queue({ upcoming: [track({ id: 'a' })] }));
    expect(rows[0] === undefined ? '' : positionLabel(rows[0])).toBe('1');
  });

  // A queue legitimately holds the same track twice. Keyed on identity alone,
  // Svelte would reuse one row's DOM for the other and the list would show one
  // of them twice as it scrolled.
  it('keeps two copies of the same track apart', () => {
    const rows = upcomingEntries(
      queue({ upcoming: [track({ id: 'a' }), track({ id: 'a' })] }),
    );

    expect(rows[0]?.key).not.toBe(rows[1]?.key);
  });

  // Local files have neither an id nor a uri, so an identity built from those
  // alone would make every one of them the same row.
  it('still identifies a local file, which has no id and no uri', () => {
    const rows = upcomingEntries(
      queue({
        upcoming: [
          track({ id: null, uri: null, title: 'Demo A', isLocal: true }),
          track({ id: null, uri: null, title: 'Demo B', isLocal: true }),
        ],
      }),
    );

    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(rows[0]?.key).toContain('Demo A');
  });

  it('counts the current item as part of the queue length', () => {
    expect(queueLength(queue({ upcoming: [track({ id: 'a' })] }))).toBe(2);
    expect(queueLength(queue({ current: null, upcoming: [] }))).toBe(0);
  });
});

describe('which sentence the queue screen is in', () => {
  const view = (over: Partial<Parameters<typeof queueStatus>[0]> = {}) =>
    queueStatus({
      hasCurrent: false,
      upcomingCount: 0,
      pending: false,
      problem: null,
      ...over,
    });

  it('reads as ready once there is anything coming', () => {
    expect(view({ hasCurrent: true, upcomingCount: 3 })).toBe('ready');
  });

  // D-049's failure rule on this screen: a refresh we could not confirm is no
  // reason to replace a list somebody is reading with an apology.
  it('stays ready when a refresh failed but the rows are still there', () => {
    expect(view({ upcomingCount: 3, problem: offline })).toBe('ready');
  });

  // Two genuinely different facts that "empty" would blur into one: a track
  // playing with nothing after it is an account behaving normally.
  it('tells "nothing after this" apart from "nothing at all"', () => {
    expect(view({ hasCurrent: true })).toBe('nothing-next');
    expect(view()).toBe('empty');
  });

  it('says it is reading only before the first answer lands', () => {
    expect(view({ pending: true })).toBe('loading');
    expect(view({ pending: false })).toBe('empty');
  });

  it('reports a queue it could not read as unreachable, not as empty', () => {
    expect(view({ problem: offline })).toBe('unreachable');
  });
});

describe('what the screen says', () => {
  const states: readonly QueueStatus[] = [
    'loading',
    'unreachable',
    'empty',
    'nothing-next',
  ];

  it('has a sentence for every state that has no rows', () => {
    for (const status of states) {
      expect(queueStatusMessage(status)?.length).toBeGreaterThan(0);
    }
  });

  it('says nothing at all once there are rows to read', () => {
    expect(queueStatusMessage('ready')).toBeNull();
  });

  // Never a raw error, never a spinner: an empty queue is a state, and a queue
  // we could not re-read is last-known truth plus a caveat.
  it('phrases none of them as a fault', () => {
    for (const status of states) {
      expect(queueStatusMessage(status)).not.toMatch(/error|failed|loading\b/i);
    }
  });

  // P4-05. The rows cannot be tapped, and the screen has to say why — a
  // missing affordance with no explanation reads as a panel that is broken.
  it('explains the view-only queue whenever there is a list to explain', () => {
    expect(queueViewOnlyNote(3)).toBe(QUEUE_VIEW_ONLY_NOTE);
    expect(QUEUE_VIEW_ONLY_NOTE).toMatch(/reorder/i);
    expect(QUEUE_VIEW_ONLY_NOTE).toMatch(/jump/i);
  });

  it('drops the explanation when there is nothing to explain', () => {
    expect(queueViewOnlyNote(0)).toBeNull();
  });
});

describe('the height of the scrolling box', () => {
  // Arithmetic rather than a measurement: the panel is fixed at 720×1280
  // (D-039) and jsdom reports every element as 0×0 anyway.
  it('is exactly as tall as a short queue', () => {
    expect(queueListHeight(3)).toBe(3 * QUEUE_ROW_HEIGHT);
  });

  it('stops growing at the rows the grown plate can show', () => {
    expect(queueListHeight(400)).toBe(8 * QUEUE_ROW_HEIGHT);
    expect(queueListHeight(400, 4)).toBe(4 * QUEUE_ROW_HEIGHT);
  });

  it('is zero when there is nothing coming', () => {
    expect(queueListHeight(0)).toBe(0);
    expect(queueListHeight(-2)).toBe(0);
  });
});
