/**
 * @vitest-environment jsdom
 */
/**
 * P3-12's states, rendered. Which notice applies is decided in
 * `lib/notices.ts` and asserted there; what these check is the rule that
 * cannot be checked in Node — that whatever ends up on the plate reads as a
 * sentence somebody wrote, and never as a fault or a spinner.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { IDLE_PLAYBACK, type PlaybackState } from '@joshify/core';
import PlaybackNotice from './PlaybackNotice.svelte';
import { noticeFor } from '../lib/notices.js';

const idleOnKitchen: PlaybackState = {
  ...IDLE_PLAYBACK,
  device: {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    isActive: true,
    volumePercent: 55,
    supportsVolume: true,
  },
};

afterEach(cleanup);

describe('the plate notice', () => {
  it('renders nothing at all when there is a track to show instead', () => {
    const { container } = render(PlaybackNotice, { notice: null });
    expect(container.textContent).toBe('');
  });

  it('says nothing is playing, and on which speaker', () => {
    const notice = noticeFor({ link: 'live', state: idleOnKitchen });
    render(PlaybackNotice, { notice });

    expect(screen.getByText('Nothing playing')).toBeDefined();
    expect(screen.getByText('Ready on Kitchen.')).toBeDefined();
  });

  // An offer, not an error: choosing a speaker is the action, and while it is
  // up it is the primary control on the plate.
  it('offers a device as a real button when there is no active one', async () => {
    const notice = noticeFor({ link: 'live', state: IDLE_PLAYBACK });
    let chosen = 0;
    render(PlaybackNotice, {
      notice,
      onChooseDevice: () => {
        chosen += 1;
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Choose a device' }));
    expect(chosen).toBe(1);
  });

  it('survives having nobody listening for the choice', async () => {
    const notice = noticeFor({ link: 'live', state: IDLE_PLAYBACK });
    render(PlaybackNotice, { notice });

    await fireEvent.click(screen.getByRole('button', { name: 'Choose a device' }));
    expect(screen.getByText('No active device')).toBeDefined();
  });

  // Spotify refuses every write on a free account, so there is no action to
  // offer — a button here would be one guaranteed to fail.
  it('explains a free account plainly, with nothing to press', () => {
    const notice = noticeFor({ link: 'live', state: idleOnKitchen, isPremium: false });
    render(PlaybackNotice, { notice });

    expect(screen.getByText('Premium required')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('marks which state it is showing, so the plate can dress itself', () => {
    const notice = noticeFor({ link: 'reconnecting', state: null });
    const { container } = render(PlaybackNotice, { notice });

    expect(container.querySelector('[data-notice]')?.getAttribute('data-notice')).toBe(
      'offline',
    );
  });

  it.each([
    ['idle', { link: 'live' as const, state: idleOnKitchen }],
    ['no device', { link: 'live' as const, state: IDLE_PLAYBACK }],
    ['offline', { link: 'reconnecting' as const, state: null }],
    ['not premium', { link: 'live' as const, state: idleOnKitchen, isPremium: false }],
  ])('never shows a raw error or a spinner for %s', (_name, input) => {
    const { container } = render(PlaybackNotice, { notice: noticeFor(input) });
    expect(container.textContent).not.toMatch(/error|failed|loading|please wait/i);
  });
});
