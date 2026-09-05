import { describe, expect, it } from 'vitest';
import { IDLE_PLAYBACK, type PlaybackDevice, type PlaybackState } from '@joshify/core';
import { controlsDisabled, noticeFor, type NoticeInput } from './notices.js';

const kitchen: PlaybackDevice = {
  id: 'dev-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: true,
  volumePercent: 55,
  supportsVolume: true,
};

const playing: PlaybackState = {
  ...IDLE_PLAYBACK,
  isPlaying: true,
  device: kitchen,
  item: {
    kind: 'track',
    id: 'track-1',
    uri: 'spotify:track:track-1',
    title: 'Velocity Division',
    subtitle: 'Nitrous Cartel',
    durationMs: 211_000,
    images: [],
    isLocal: false,
  },
};

const input = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  link: 'live',
  state: playing,
  ...over,
});

describe('noticeFor', () => {
  it('says nothing at all while a track is playing on a device', () => {
    expect(noticeFor(input())).toBeNull();
  });

  // Nothing playing is a state, not a failure. It gets a sentence and keeps
  // the transport, because play is still a thing you can do.
  it('names the idle state and leaves play available', () => {
    const notice = noticeFor(input({ state: { ...playing, item: null } }));

    expect(notice?.kind).toBe('idle');
    expect(notice?.title).toBe('Nothing playing');
    expect(notice?.controlsDisabled).toBe(false);
  });

  it('tells the viewer which speaker it is idle on', () => {
    const notice = noticeFor(input({ state: { ...playing, item: null } }));
    expect(notice?.body).toBe('Ready on Kitchen.');
  });

  // An offer, not an error — and the only notice with an action, because it is
  // the only one the viewer can do something about from here.
  it('offers a device rather than reporting a fault when there is none', () => {
    const notice = noticeFor(input({ state: IDLE_PLAYBACK }));

    expect(notice?.kind).toBe('no-device');
    expect(notice?.action).toBe('choose-device');
  });

  // Spotify refuses every /me/player write on a free account, so a live-looking
  // control would be a button guaranteed to fail.
  it('explains a free account plainly and switches every control off', () => {
    const notice = noticeFor(input({ isPremium: false }));

    expect(notice?.kind).toBe('not-premium');
    expect(notice?.controlsDisabled).toBe(true);
    expect(notice?.action).toBeNull();
  });

  // It is a permanent fact about the account that explains every other failure
  // the viewer would otherwise be left guessing about.
  it('lets Premium outrank a dropped link, since it explains the rest', () => {
    const notice = noticeFor(input({ isPremium: false, link: 'reconnecting', state: null }));
    expect(notice?.kind).toBe('not-premium');
  });

  // The single most important rule on the panel: a dropped socket changes the
  // lamp and nothing else. There is a last known truth, so it stays on screen.
  it.each<NoticeInput['link']>(['reconnecting', 'connecting'])(
    'says nothing when the %s link still has a last known state',
    (link) => {
      expect(noticeFor(input({ link }))).toBeNull();
    },
  );

  // Only a panel that has never seen a state has nothing better to show.
  it('admits it is reconnecting only when it holds no state at all', () => {
    const notice = noticeFor(input({ link: 'reconnecting', state: null }));

    expect(notice?.kind).toBe('offline');
    expect(notice?.controlsDisabled).toBe(true);
  });

  // Connected, but the first snapshot has not landed. Never a spinner: the
  // calm sentence is the honest thing to show for the one frame it lasts.
  it('shows the idle sentence rather than a spinner before the first snapshot', () => {
    const notice = noticeFor(input({ link: 'live', state: null }));

    expect(notice?.kind).toBe('idle');
    expect(notice?.body).toBe('Ready when you are.');
  });

  // "Nothing playing" with nothing to play on is a dead end; "choose a device"
  // is the way out of it, so it wins.
  it('prefers the offer over the idle sentence when both apply', () => {
    expect(noticeFor(input({ state: IDLE_PLAYBACK }))?.kind).toBe('no-device');
  });

  // Unknown is treated as Premium: accusing an account of being free before we
  // know is exactly the confident lie D-022 is about.
  it('does not accuse an account it has not read yet', () => {
    expect(noticeFor(input({ isPremium: undefined }))).toBeNull();
  });

  it('never writes the word error or asks for patience', () => {
    for (const over of [
      { isPremium: false },
      { state: null, link: 'reconnecting' as const },
      { state: IDLE_PLAYBACK },
      { state: { ...playing, item: null } },
    ]) {
      const notice = noticeFor(input(over));
      expect(`${notice?.title ?? ''} ${notice?.body ?? ''}`).not.toMatch(
        /error|failed|loading|please wait/i,
      );
    }
  });
});

describe('controlsDisabled', () => {
  it('leaves everything live when there is no notice', () => {
    expect(controlsDisabled(null)).toBe(false);
  });

  it('follows the notice when there is one', () => {
    expect(controlsDisabled(noticeFor(input({ isPremium: false })))).toBe(true);
  });
});
