/**
 * The Devices screen's decisions, as pure functions.
 *
 * The screen itself is markup; everything that could be *wrong* about it lives
 * here, in Node-testable functions: what order the rows come in, whether a row
 * can be tapped at all, whether a row is allowed to draw a volume slider, and
 * what the slider shows while a finger is on it.
 *
 * Two rules from the decision log drive most of this:
 *
 * - **D-022 — absence is modelled, not defaulted.** A device reporting
 *   `volumePercent: null` gets *no slider*. Drawing one at 0 would tell the
 *   viewer that a device playing at full blast is muted, and a confident lie
 *   is worse than a missing control. `supportsVolume: false` is the same
 *   story from the other end: a control that cannot work should not be drawn.
 * - **D-007's principle, applied here — no affordance that cannot work.** A
 *   restricted device (`id: null`) will not accept a transfer, so its row is
 *   not a button. The active device is not a transfer target either: sending
 *   playback where it already is achieves nothing, and a control that does
 *   nothing reads as broken rather than as a no-op.
 */
import type { PlaybackDevice } from '@joshify/core';

/**
 * The glyph families the rows draw. Spotify's `type` string is an open set of
 * CamelCase values (`CastAudio`, `AudioDongle`, `GameConsole`, …) that grows
 * without notice, so it is folded into a handful of shapes we actually have
 * artwork for, with `unknown` as the honest catch-all rather than a guess.
 */
export type DeviceKind =
  | 'speaker'
  | 'phone'
  | 'tablet'
  | 'computer'
  | 'tv'
  | 'car'
  | 'console'
  | 'cast'
  | 'unknown';

const KIND_BY_TYPE: Record<string, DeviceKind> = {
  speaker: 'speaker',
  avr: 'speaker',
  audiodongle: 'speaker',
  smartphone: 'phone',
  tablet: 'tablet',
  computer: 'computer',
  tv: 'tv',
  stb: 'tv',
  gameconsole: 'console',
  castaudio: 'cast',
  castvideo: 'cast',
  automobile: 'car',
};

const KIND_LABELS: Record<DeviceKind, string> = {
  speaker: 'Speaker',
  phone: 'Phone',
  tablet: 'Tablet',
  computer: 'Computer',
  tv: 'TV',
  car: 'Car',
  console: 'Console',
  cast: 'Cast',
  unknown: 'Device',
};

/** Fold Spotify's device type onto a glyph family. Case- and space-insensitive. */
export const deviceKind = (type: string): DeviceKind =>
  KIND_BY_TYPE[type.toLowerCase().replace(/[\s_-]/g, '')] ?? 'unknown';

/**
 * What the row says under the name. Deliberately *our* word rather than
 * Spotify's: "CastAudio" is a wire value, and printing it on a 7" panel in a
 * kitchen is showing the viewer our plumbing.
 */
export const deviceTypeLabel = (type: string): string => KIND_LABELS[deviceKind(type)];

/**
 * A stable key for a row.
 *
 * `id` is null for restricted devices — more than one of them can be on the
 * list at once, so the id alone is not unique and keying by it would make
 * Svelte reuse one row's DOM for another device.
 */
export const deviceKey = (device: PlaybackDevice): string =>
  `${device.id ?? 'restricted'}:${device.name}:${device.type}`;

/**
 * Can playback be moved here?
 *
 * Null id means Spotify will not accept the device as a transfer target, and
 * the device that is already active is not somewhere to move *to*.
 */
export const canTransferTo = (device: PlaybackDevice): boolean =>
  device.id !== null && !device.isActive;

/** The id to aim a transfer at, or null when this row is not a target. */
export const transferTargetId = (device: PlaybackDevice): string | null =>
  canTransferTo(device) ? device.id : null;

/** The row's slider is drawn only when the device actually reports one (D-022). */
export const showsVolume = (device: PlaybackDevice): boolean =>
  device.supportsVolume && device.volumePercent !== null;

/**
 * Active first, then anything you can move music to, then the restricted ones.
 *
 * The active device sorts first because it is the one fact the screen exists
 * to state; restricted devices sink because tapping them does nothing, and a
 * dead row in the middle of a list is a worse surprise than one at the end.
 * Ties break on name so the order is stable between polls — a list that
 * reshuffles under a finger is how you transfer to the wrong speaker.
 */
const rank = (device: PlaybackDevice): number => {
  if (device.isActive) return 0;
  return device.id === null ? 2 : 1;
};

export const sortDevices = (
  devices: readonly PlaybackDevice[],
): readonly PlaybackDevice[] =>
  [...devices].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      deviceKey(a).localeCompare(deviceKey(b)),
  );

/** Spotify's volume range, and the only values it will accept. */
export const clampVolume = (percent: number): number => {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
};

/**
 * What a volume slider is showing, and why it is allowed to disagree with the
 * poll.
 *
 * The polled value arrives every second or so. If it were applied blindly the
 * thumb would jump out from under a finger mid-drag, and would snap back to
 * the old value for one poll after release — the write has not landed on the
 * speaker yet, so the poll is *correctly* reporting stale truth.
 *
 * So the gesture holds its own value and reconciles on the two axes from
 * D-028: while `dragging`, polls are ignored outright; after release the sent
 * value stands until a poll reports something **other than the value it
 * replaced**. A poll still showing the old value is consistent with a write in
 * flight; any third value is news from another phone and is adopted at once.
 */
export interface VolumeGesture {
  /** A finger (or pointer) is down: the poll is ignored entirely. */
  readonly dragging: boolean;
  /** The value the panel is showing on its own, or null to trust the poll. */
  readonly local: number | null;
  /** The polled value `local` replaced — the second reconcile axis. */
  readonly replaced: number | null;
}

/** Trusting the poll completely, which is the resting state. */
export const IDLE_VOLUME_GESTURE: VolumeGesture = {
  dragging: false,
  local: null,
  replaced: null,
};

/**
 * Start holding a value locally without claiming a pointer is down. A keyboard
 * step is a whole gesture with no press and no release, and it needs the same
 * reconcile protection as a drag.
 */
export const holdVolume = (
  gesture: VolumeGesture,
  polled: number | null,
): VolumeGesture => ({
  dragging: gesture.dragging,
  local: gesture.local ?? polled ?? 0,
  replaced: gesture.replaced ?? polled,
});

export const beginDrag = (
  gesture: VolumeGesture,
  polled: number | null,
): VolumeGesture => ({ ...holdVolume(gesture, polled), dragging: true });

export const dragTo = (gesture: VolumeGesture, percent: number): VolumeGesture => ({
  ...gesture,
  local: clampVolume(percent),
});

/**
 * The finger came up. A gesture that ended exactly where it started is not a
 * change — it collapses back to trusting the poll, and the caller has nothing
 * to send. That matters: a stray tap on the slider must not fire a volume
 * command at the speaker.
 */
export const endDrag = (gesture: VolumeGesture): VolumeGesture => {
  if (gesture.local === null || gesture.local === gesture.replaced) {
    return IDLE_VOLUME_GESTURE;
  }
  return { ...gesture, dragging: false };
};

/** Apply an incoming polled value, per the two axes above. */
export const settleVolume = (
  gesture: VolumeGesture,
  polled: number | null,
): VolumeGesture => {
  if (gesture.dragging || gesture.local === null) return gesture;
  if (polled === null || polled === gesture.replaced) return gesture;
  return IDLE_VOLUME_GESTURE;
};

/** The number to draw. Zero only when nothing at all is known. */
export const shownVolume = (gesture: VolumeGesture, polled: number | null): number =>
  clampVolume(gesture.local ?? polled ?? 0);
