import { describe, expect, it } from 'vitest';
import {
  createOptimisticPlayback,
  DEFAULT_SETTLE_WINDOW_MS,
  type OptimisticPlayback,
} from './optimistic.js';
import {
  IDLE_PLAYBACK,
  type PlaybackDevice,
  type PlaybackState,
  type PlayingItem,
} from './state.js';

const DURATION_MS = 200_000;
const T0 = 10_000;
/** Comfortably inside the settle window, and about one after-command poll. */
const SOON = 400;
const LATER = DEFAULT_SETTLE_WINDOW_MS + 1;

const track = (overrides: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Song',
  subtitle: 'Artist',
  durationMs: DURATION_MS,
  images: [],
  isLocal: false,
  ...overrides,
});

const device = (overrides: Partial<PlaybackDevice> = {}): PlaybackDevice => ({
  id: 'device-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: true,
  volumePercent: 40,
  supportsVolume: true,
  ...overrides,
});

const playback = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  isPlaying: true,
  item: track(),
  device: device(),
  progressMs: 30_000,
  shuffle: false,
  repeat: 'off',
  ...overrides,
});

const layer = (overrides: Partial<PlaybackState> = {}): OptimisticPlayback =>
  createOptimisticPlayback(playback(overrides));

describe('createOptimisticPlayback', () => {
  it('renders the state it was created with', () => {
    const initial = playback();
    expect(createOptimisticPlayback(initial).state).toBe(initial);
  });

  describe('apply', () => {
    // The whole point: the button must move under the finger, not after a
    // round trip to Stockholm and back.
    it('shows a pause immediately', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);
      expect(optimistic.state.isPlaying).toBe(false);
      expect(optimistic.pending).toEqual(['isPlaying']);
    });

    it('shows play, shuffle, repeat, volume and seek immediately', () => {
      const optimistic = layer({ isPlaying: false });
      optimistic.apply({ kind: 'play' }, T0);
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0);
      optimistic.apply({ kind: 'repeat', mode: 'track' }, T0);
      optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      expect(optimistic.state).toMatchObject({
        isPlaying: true,
        shuffle: true,
        repeat: 'track',
        progressMs: 120_000,
      });
      expect(optimistic.state.device?.volumePercent).toBe(80);
      expect(optimistic.pending).toEqual([
        'isPlaying',
        'shuffle',
        'repeat',
        'volumePercent',
        'progressMs',
      ]);
    });

    it('leaves the rest of the device untouched when only volume moves', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      expect(optimistic.state.device).toEqual(device({ volumePercent: 80 }));
    });

    // A TV or a receiver reports no volume because its volume lives outside
    // Spotify (D-022). Drawing a slider that moved would promise something the
    // command cannot deliver.
    it('ignores a volume change on a device that reports no volume', () => {
      const optimistic = layer({ device: device({ volumePercent: null }) });
      expect(optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0)).toBeNull();
      expect(optimistic.pending).toEqual([]);
    });

    it('records the command time even when nothing is applied', () => {
      const optimistic = layer({ device: null });
      expect(optimistic.lastCommandAtMs).toBeNull();
      optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      // The poll scheduler's reconciliation burst keys off this (D-025); a
      // command that moved no field still needs confirming.
      expect(optimistic.lastCommandAtMs).toBe(T0);
    });

    it('returns the same object until something changes', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);
      expect(optimistic.state).toBe(optimistic.state);
    });
  });

  describe('reconcile', () => {
    // Spotify Connect does not apply a write the instant it returns 204: the
    // poll 400ms later legitimately still says "playing". Believing it makes
    // the pause button bounce back and then forward again.
    it('holds an optimistic value against a stale poll inside the window', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);

      optimistic.reconcile(playback(), T0 + SOON);

      expect(optimistic.state.isPlaying).toBe(false);
      expect(optimistic.pending).toEqual(['isPlaying']);
    });

    // The command evidently did nothing — a device that dropped off wifi
    // between the write and the poll, say. Keeping the lie any longer just
    // makes the screen wrong for longer.
    it('yields to a stale poll once the window has passed', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);

      optimistic.reconcile(playback(), T0 + LATER);

      expect(optimistic.state.isPlaying).toBe(true);
      expect(optimistic.pending).toEqual([]);
    });

    it('clears the pending change once the poll agrees with it', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);

      const truth = playback({ isPlaying: false });
      optimistic.reconcile(truth, T0 + SOON);

      expect(optimistic.pending).toEqual([]);
      // Nothing pending, so the rendered state is the polled one outright.
      expect(optimistic.state).toBe(truth);
    });

    // Someone paused on their phone while our shuffle command was in flight.
    // The shuffle write is still unconfirmed, and must not be dropped just
    // because an unrelated field moved.
    it('adopts changes to fields nobody optimistically set', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0);

      optimistic.reconcile(playback({ isPlaying: false }), T0 + SOON);

      expect(optimistic.state.isPlaying).toBe(false);
      expect(optimistic.state.shuffle).toBe(true);
    });

    // The second axis: a value we never set and were not replacing cannot be a
    // lagging echo of our own command, so elapsed time is irrelevant — another
    // device wrote it, and one poll is enough to know.
    it('yields immediately to a third value, inside the window', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'repeat', mode: 'context' }, T0);

      optimistic.reconcile(playback({ repeat: 'track' }), T0 + SOON);

      expect(optimistic.state.repeat).toBe('track');
      expect(optimistic.pending).toEqual([]);
    });

    // A volume drag and a shuffle tap are separate writes to separate
    // endpoints. Reconciling one must not throw the other away.
    it('keeps pending changes per field', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0 + 10);

      // The shuffle landed first; volume is still in flight.
      optimistic.reconcile(playback({ shuffle: true }), T0 + SOON);

      expect(optimistic.pending).toEqual(['volumePercent']);
      expect(optimistic.state.device?.volumePercent).toBe(80);
      expect(optimistic.state.shuffle).toBe(true);
    });

    // The baseline is what was on screen when the command was issued, not the
    // last polled truth: with the pause still in flight, a poll reporting
    // "paused" is the pause landing, not the play failing.
    it('measures a second command against the value the first put on screen', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'pause' }, T0);
      optimistic.apply({ kind: 'play' }, T0 + 50);

      optimistic.reconcile(playback({ isPlaying: false }), T0 + SOON);

      expect(optimistic.state.isPlaying).toBe(true);
    });

    it('takes the polled item and truth even while a field is held', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0);

      const next = playback({ item: track({ id: 'track-2', title: 'Next' }) });
      optimistic.reconcile(next, T0 + SOON);

      expect(optimistic.state.item).toBe(next.item);
      expect(optimistic.state.shuffle).toBe(true);
    });

    // Nothing to compare a volume against, and no slider on screen either.
    // An absent reading is not evidence that the command failed.
    it('holds a volume when the device stops reporting one', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);

      optimistic.reconcile(playback({ device: null }), T0 + SOON);
      expect(optimistic.pending).toEqual(['volumePercent']);
      expect(optimistic.state.device).toBeNull();

      optimistic.reconcile(playback({ device: null }), T0 + LATER);
      expect(optimistic.pending).toEqual([]);
    });

    it('drops everything when playback stops entirely', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0);
      optimistic.reconcile(IDLE_PLAYBACK, T0 + LATER);
      expect(optimistic.state).toBe(IDLE_PLAYBACK);
    });
  });

  describe('seek', () => {
    // While the seek is in flight the device keeps playing the old position,
    // so the poll reports a moving target, not the value we replaced.
    it('holds the requested position against the old timeline still running', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      optimistic.reconcile(playback({ progressMs: 30_000 + SOON }), T0 + SOON);

      expect(optimistic.state.progressMs).toBe(120_000);
    });

    it('clears the pending seek once the poll lands near the new position', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      optimistic.reconcile(playback({ progressMs: 120_300 }), T0 + SOON);

      expect(optimistic.pending).toEqual([]);
      expect(optimistic.state.progressMs).toBe(120_300);
    });

    it('yields to a position that is neither the target nor the old timeline', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      // Someone else dragged the scrubber on their phone.
      optimistic.reconcile(playback({ progressMs: 5_000 }), T0 + SOON);

      expect(optimistic.state.progressMs).toBe(5_000);
      expect(optimistic.pending).toEqual([]);
    });

    it('yields to the old timeline once the window has passed', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      optimistic.reconcile(playback({ progressMs: 30_000 + LATER }), T0 + LATER);

      expect(optimistic.state.progressMs).toBe(30_000 + LATER);
    });

    // Nothing moves while paused, so neither expected position drifts.
    it('compares against a still position when playback is paused', () => {
      const optimistic = layer({ isPlaying: false });
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      optimistic.reconcile(playback({ isPlaying: false }), T0 + SOON);

      expect(optimistic.state.progressMs).toBe(120_000);
    });

    // A skip on another device: the position we asked for belongs to a track
    // that is no longer playing, so it means nothing here.
    it('drops a pending seek when the item changes underneath it', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      const next = playback({ item: track({ id: 'track-2' }), progressMs: 1_000 });
      optimistic.reconcile(next, T0 + SOON);

      expect(optimistic.state.progressMs).toBe(1_000);
      expect(optimistic.pending).toEqual([]);
    });

    // Nothing is playing when the tap lands — a stale screen, or a device
    // that just went away. There is no item on either side to key against.
    it('handles a seek with no item at all', () => {
      const optimistic = createOptimisticPlayback(IDLE_PLAYBACK);
      optimistic.apply({ kind: 'seek', positionMs: 10_000 }, T0);
      expect(optimistic.state.progressMs).toBe(10_000);

      // Held on the same terms as any other stale reading, then dropped: a
      // null item on both sides is not a change of item.
      optimistic.reconcile(IDLE_PLAYBACK, T0 + SOON);
      expect(optimistic.state.progressMs).toBe(10_000);

      optimistic.reconcile(IDLE_PLAYBACK, T0 + LATER);
      expect(optimistic.state.progressMs).toBe(0);
    });

    it('respects a custom seek tolerance and settle window', () => {
      const optimistic = createOptimisticPlayback(playback(), {
        settleWindowMs: 100,
        seekToleranceMs: 50,
      });
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      // 300ms off the target: near enough by default, a different position
      // under this tolerance — and past this window besides.
      optimistic.reconcile(playback({ progressMs: 120_300 }), T0 + SOON);
      expect(optimistic.state.progressMs).toBe(120_300);
    });

    it('identifies a local file by title and duration', () => {
      const local = track({ id: null, uri: null, isLocal: true });
      const optimistic = layer({ item: local });
      optimistic.apply({ kind: 'seek', positionMs: 120_000 }, T0);

      // Without the fallback key this poll looks like a different item and
      // the seek would be thrown away on every local file.
      optimistic.reconcile(playback({ item: local, progressMs: 30_400 }), T0 + SOON);

      expect(optimistic.state.progressMs).toBe(120_000);
    });
  });

  describe('next and previous', () => {
    // The item cannot be guessed — the queue is a separate request, shuffle
    // makes it non-deterministic, repeat-one makes it the current track — but
    // whatever arrives starts at the beginning, so the bar can snap now.
    it('snaps the position to zero without guessing the item', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'next' }, T0);

      expect(optimistic.state.progressMs).toBe(0);
      expect(optimistic.state.item).toEqual(track());
      expect(optimistic.pending).toEqual(['progressMs']);
    });

    it('holds the snap while the poll still shows the outgoing track', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'previous' }, T0);

      optimistic.reconcile(playback({ progressMs: 30_000 + SOON }), T0 + SOON);

      expect(optimistic.state.progressMs).toBe(0);
    });

    // Unlike a seek, this pending position is *waiting* for the item to
    // change, so the change must not invalidate it.
    it('survives the item change it was waiting for', () => {
      const optimistic = layer();
      optimistic.apply({ kind: 'next' }, T0);

      const next = playback({ item: track({ id: 'track-2' }), progressMs: 300 });
      optimistic.reconcile(next, T0 + SOON);

      expect(optimistic.state.progressMs).toBe(300);
      expect(optimistic.state.item).toBe(next.item);
      expect(optimistic.pending).toEqual([]);
    });
  });

  describe('fail', () => {
    // A 404 "no active device" comes back in well under the settle window.
    // Waiting it out would leave a paused button over playing audio.
    it('rolls back immediately without waiting for a poll', () => {
      const optimistic = layer();
      const pending = optimistic.apply({ kind: 'pause' }, T0);

      optimistic.fail(pending);

      expect(optimistic.state.isPlaying).toBe(true);
      expect(optimistic.pending).toEqual([]);
    });

    it('rolls back only the field that failed', () => {
      const optimistic = layer();
      const pending = optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      optimistic.apply({ kind: 'shuffle', enabled: true }, T0);

      optimistic.fail(pending);

      expect(optimistic.state.device?.volumePercent).toBe(40);
      expect(optimistic.state.shuffle).toBe(true);
    });

    // Double-tapping shuffle sends two writes; the first can fail after the
    // second has already been applied. Rolling back by field alone would
    // delete the change the user is looking at.
    it('ignores a failure for a change that was already superseded', () => {
      const optimistic = layer();
      const first = optimistic.apply({ kind: 'shuffle', enabled: true }, T0);
      optimistic.apply({ kind: 'shuffle', enabled: false }, T0 + 50);

      optimistic.fail(first);

      expect(optimistic.state.shuffle).toBe(false);
      expect(optimistic.pending).toEqual(['shuffle']);
    });

    it('ignores a failure for a change that already reconciled', () => {
      const optimistic = layer();
      const pending = optimistic.apply({ kind: 'shuffle', enabled: true }, T0);
      const truth = playback({ shuffle: true });
      optimistic.reconcile(truth, T0 + SOON);

      optimistic.fail(pending);

      expect(optimistic.state).toBe(truth);
    });

    it('accepts the null receipt from a command that applied nothing', () => {
      const optimistic = layer({ device: null });
      const pending = optimistic.apply({ kind: 'volume', volumePercent: 80 }, T0);
      expect(() => {
        optimistic.fail(pending);
      }).not.toThrow();
    });
  });

  // The property that matters more than any single case: a run of stale polls
  // never makes a control flicker, and the truth always wins in the end.
  it('never flickers a control across a burst of lagging polls', () => {
    const optimistic = layer();
    optimistic.apply({ kind: 'pause' }, T0);

    for (let at = T0 + 200; at <= T0 + 2_000; at += 200) {
      optimistic.reconcile(playback(), at);
      expect(optimistic.state.isPlaying).toBe(false);
    }

    optimistic.reconcile(playback({ isPlaying: false }), T0 + 2_200);
    expect(optimistic.state.isPlaying).toBe(false);
    expect(optimistic.pending).toEqual([]);
  });
});
