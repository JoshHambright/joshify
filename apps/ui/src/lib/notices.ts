/**
 * Which sentence the plate says when it is not saying a track title (P3-12).
 *
 * SCREENS.md's rule for this screen is one line long — **never a raw error,
 * never a spinner where last-known truth exists** — and every branch below is
 * an application of it:
 *
 * - Nothing playing is a *state*. It gets a sentence and a play button, not an
 *   empty plate.
 * - No active device is an *offer*, not a failure. The action is "choose a
 *   device", and it is the primary control on the plate while it is up.
 * - Not Premium is a plain explanation. Every control goes off, because
 *   Spotify refuses every `/me/player` write on a free account and a button
 *   that is guaranteed to fail is a lie with a nice hover state.
 * - Offline says nothing at all *when there is a last known truth to keep*.
 *   The lamp on the status rail goes amber and the album, the title and the
 *   artist stay exactly where they were. Only a panel that has never seen a
 *   state has nothing better to show.
 *
 * The precedence between them is the part worth testing, so it lives in one
 * pure function rather than in a chain of `{#if}` blocks nobody can assert on.
 */
import type { PlaybackState } from '@joshify/core';
import type { LinkStatus } from './connection.js';

export type NoticeKind = 'idle' | 'no-device' | 'not-premium' | 'offline';

export interface Notice {
  readonly kind: NoticeKind;
  /** The small silkscreen label above the sentence. */
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  /** The one action that can work from here, if there is one. */
  readonly action: 'choose-device' | null;
  /**
   * Whether the transport should be dead while this notice is up. True only
   * where Spotify would refuse the command anyway — a disabled control the
   * viewer could have used is its own kind of lie.
   */
  readonly controlsDisabled: boolean;
}

export interface NoticeInput {
  readonly link: LinkStatus;
  /** Null until the first snapshot lands, and never cleared after that. */
  readonly state: PlaybackState | null;
  /**
   * Undefined until the account has been read. Unknown is treated as Premium:
   * accusing someone's account of being free before we know is exactly the
   * kind of confident lie D-022 is about.
   */
  readonly isPremium?: boolean | undefined;
}

const NOT_PREMIUM: Notice = {
  kind: 'not-premium',
  eyebrow: 'Joshify',
  title: 'Premium required',
  body: 'Spotify only lets Premium accounts control playback, so the controls are switched off here.',
  action: null,
  controlsDisabled: true,
};

const OFFLINE: Notice = {
  kind: 'offline',
  eyebrow: 'Joshify',
  title: 'Reconnecting',
  body: 'The panel has lost the Joshify server. It picks itself back up on its own.',
  action: null,
  controlsDisabled: true,
};

const NO_DEVICE: Notice = {
  kind: 'no-device',
  eyebrow: 'Joshify',
  title: 'No active device',
  body: 'Pick a speaker and the music goes there.',
  action: 'choose-device',
  controlsDisabled: true,
};

const idleNotice = (deviceName: string | null): Notice => ({
  kind: 'idle',
  eyebrow: 'Joshify',
  title: 'Nothing playing',
  body: deviceName === null ? 'Ready when you are.' : `Ready on ${deviceName}.`,
  action: null,
  // Play is the one thing that still makes sense here, so the transport stays
  // live and shows play only.
  controlsDisabled: false,
});

/**
 * The notice for a state, or null when the plate should just show the track.
 *
 * Order matters and is deliberate:
 *
 * 1. **Not Premium wins over everything**, including offline. It is a
 *    permanent fact about the account that explains every other failure the
 *    viewer would otherwise see, so it is worth saying even mid-reconnect.
 * 2. **Offline only speaks when there is no last known state.** With a state
 *    in hand the whole point is that nothing changes on screen.
 * 3. **No device outranks nothing playing**, because it is the one that has an
 *    action attached. "Nothing playing" with no device to play *on* is a dead
 *    end; "choose a device" is the way out of it.
 */
export const noticeFor = (input: NoticeInput): Notice | null => {
  if (input.isPremium === false) return NOT_PREMIUM;
  if (input.state === null) return input.link === 'live' ? idleNotice(null) : OFFLINE;
  if (input.state.device === null) return NO_DEVICE;
  if (input.state.item === null) return idleNotice(input.state.device.name);
  return null;
};

/** Convenience for the controls: no notice means nothing is switched off. */
export const controlsDisabled = (notice: Notice | null): boolean =>
  notice?.controlsDisabled ?? false;
