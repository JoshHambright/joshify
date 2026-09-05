import { describe, expect, it } from 'vitest';
import type { PlaybackDevice } from '@joshify/core';
import {
  beginDrag,
  canTransferTo,
  clampVolume,
  deviceKey,
  deviceKind,
  deviceTypeLabel,
  dragTo,
  endDrag,
  holdVolume,
  IDLE_VOLUME_GESTURE,
  settleVolume,
  showsVolume,
  shownVolume,
  sortDevices,
  transferTargetId,
} from './devices.js';

const device = (over: Partial<PlaybackDevice> = {}): PlaybackDevice => ({
  id: 'dev-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: false,
  volumePercent: 55,
  supportsVolume: true,
  ...over,
});

describe('deviceKind', () => {
  it.each([
    ['Speaker', 'speaker'],
    ['AVR', 'speaker'],
    ['AudioDongle', 'speaker'],
    ['Smartphone', 'phone'],
    ['Tablet', 'tablet'],
    ['Computer', 'computer'],
    ['TV', 'tv'],
    ['STB', 'tv'],
    ['GameConsole', 'console'],
    ['CastAudio', 'cast'],
    ['CastVideo', 'cast'],
    ['Automobile', 'car'],
  ])('folds %s onto the %s glyph', (type, expected) => {
    expect(deviceKind(type)).toBe(expected);
  });

  // Spotify's type list grows without notice. An unrecognised value is an
  // ordinary device, not a reason for the row to break.
  it.each(['Unknown', 'HomeThing', ''])('falls back to unknown for %s', (type) => {
    expect(deviceKind(type)).toBe('unknown');
  });

  it('ignores the casing and spacing Spotify happens to use', () => {
    expect(deviceKind('cast_audio')).toBe('cast');
    expect(deviceKind('game console')).toBe('console');
  });
});

describe('deviceTypeLabel', () => {
  // The row says our word, not the wire value: "CastAudio" on a panel in a
  // kitchen is showing the viewer our plumbing.
  it('prints a human word rather than the wire value', () => {
    expect(deviceTypeLabel('CastAudio')).toBe('Cast');
    expect(deviceTypeLabel('Smartphone')).toBe('Phone');
    expect(deviceTypeLabel('WhateverNext')).toBe('Device');
  });
});

describe('deviceKey', () => {
  // More than one restricted device can be on the list, and they all have a
  // null id — keying on the id alone would make Svelte reuse one row for the
  // other and show the wrong name.
  it('stays unique across two devices with no id', () => {
    const a = device({ id: null, name: 'Living Room TV', type: 'TV' });
    const b = device({ id: null, name: 'Garage', type: 'Speaker' });
    expect(deviceKey(a)).not.toBe(deviceKey(b));
  });
});

describe('canTransferTo', () => {
  // A restricted device will not accept a transfer, so its row must not be a
  // button: an affordance that cannot work is worse than a missing one.
  it('refuses a restricted device with no id', () => {
    expect(canTransferTo(device({ id: null }))).toBe(false);
    expect(transferTargetId(device({ id: null }))).toBeNull();
  });

  // Moving playback to where it already is achieves nothing, and a control
  // that visibly does nothing reads as broken.
  it('refuses the device that is already active', () => {
    expect(canTransferTo(device({ isActive: true }))).toBe(false);
    expect(transferTargetId(device({ isActive: true }))).toBeNull();
  });

  it('accepts an idle device with an id', () => {
    expect(canTransferTo(device())).toBe(true);
    expect(transferTargetId(device())).toBe('dev-1');
  });
});

describe('showsVolume', () => {
  // D-022: a slider drawn at 0 for a device playing at full blast is a
  // confident lie, and worse than no slider.
  it('is false when the device reports no volume', () => {
    expect(showsVolume(device({ volumePercent: null }))).toBe(false);
  });

  it('is false when the device will not accept a volume command', () => {
    expect(showsVolume(device({ supportsVolume: false }))).toBe(false);
  });

  it('is true only when the device both reports and accepts a volume', () => {
    expect(showsVolume(device({ volumePercent: 0 }))).toBe(true);
  });
});

describe('sortDevices', () => {
  it('puts the active device first, whatever its name', () => {
    const ordered = sortDevices([
      device({ id: 'a', name: 'Attic' }),
      device({ id: 'z', name: 'Zebra', isActive: true }),
    ]);
    expect(ordered.map((d) => d.name)).toEqual(['Zebra', 'Attic']);
  });

  // A dead row in the middle of the list is a worse surprise than one at the
  // end, so the untappable devices sink.
  it('sinks restricted devices below the ones you can move music to', () => {
    const ordered = sortDevices([
      device({ id: null, name: 'AAA Restricted' }),
      device({ id: 'b', name: 'Bedroom' }),
    ]);
    expect(ordered.map((d) => d.name)).toEqual(['Bedroom', 'AAA Restricted']);
  });

  it('orders the rest by name, ignoring case', () => {
    const ordered = sortDevices([
      device({ id: '1', name: 'kitchen' }),
      device({ id: '2', name: 'Bedroom' }),
      device({ id: '3', name: 'attic' }),
    ]);
    expect(ordered.map((d) => d.name)).toEqual(['attic', 'Bedroom', 'kitchen']);
  });

  // A list that reshuffles between polls is how you transfer to the wrong
  // speaker: two devices sharing a name still need one settled order.
  it('breaks a name tie deterministically', () => {
    const first = device({ id: 'b', name: 'Echo' });
    const second = device({ id: 'a', name: 'Echo' });
    expect(sortDevices([first, second]).map((d) => d.id)).toEqual(['a', 'b']);
    expect(sortDevices([second, first]).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it("does not reorder the caller's array in place", () => {
    const devices = [
      device({ id: 'a', name: 'Attic' }),
      device({ id: 'z', isActive: true }),
    ];
    sortDevices(devices);
    expect(devices[0]?.id).toBe('a');
  });

  it('has nothing to say about an empty list', () => {
    expect(sortDevices([])).toEqual([]);
  });
});

describe('clampVolume', () => {
  it.each([
    [-20, 0],
    [0, 0],
    [55.4, 55],
    [100, 100],
    [140, 100],
  ])('clamps %s to %s, the only range Spotify accepts', (raw, expected) => {
    expect(clampVolume(raw)).toBe(expected);
  });

  // A NaN reaching a CSS width is not an error, it is a silently unstyled bar.
  it('turns a non-number into zero rather than NaN', () => {
    expect(clampVolume(Number.NaN)).toBe(0);
  });
});

describe('the volume gesture', () => {
  it('trusts the polled value while nothing is being touched', () => {
    expect(shownVolume(IDLE_VOLUME_GESTURE, 42)).toBe(42);
  });

  it('shows zero when neither the poll nor the panel knows anything', () => {
    expect(shownVolume(IDLE_VOLUME_GESTURE, null)).toBe(0);
  });

  // The whole point of the gesture: the thumb must not jump out from under a
  // finger because a poll landed mid-drag.
  it('ignores incoming polls entirely while a finger is down', () => {
    let gesture = beginDrag(IDLE_VOLUME_GESTURE, 40);
    gesture = dragTo(gesture, 70);
    gesture = settleVolume(gesture, 40);
    gesture = settleVolume(gesture, 12);

    expect(gesture.dragging).toBe(true);
    expect(shownVolume(gesture, 12)).toBe(70);
  });

  // After release the write is in flight; a poll still reporting the value we
  // replaced is stale truth, not a correction (D-028's first axis).
  it('keeps the released value while the poll still reports the old one', () => {
    const gesture = endDrag(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 70));
    const settled = settleVolume(gesture, 40);

    expect(settled.local).toBe(70);
    expect(shownVolume(settled, 40)).toBe(70);
  });

  // D-028's second axis: a value we never set and were not replacing cannot be
  // our write landing, so it is somebody else's change and is adopted at once.
  it('adopts a third value the moment one arrives', () => {
    const gesture = endDrag(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 70));
    expect(settleVolume(gesture, 15)).toEqual(IDLE_VOLUME_GESTURE);
  });

  it('adopts the polled value once it confirms the write', () => {
    const gesture = endDrag(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 70));
    expect(settleVolume(gesture, 70)).toEqual(IDLE_VOLUME_GESTURE);
  });

  it('has nothing to reconcile when a device stops reporting a volume', () => {
    const gesture = endDrag(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 70));
    expect(settleVolume(gesture, null)).toBe(gesture);
  });

  // A stray tap that ends where it started must not fire a command at the
  // speaker, so it collapses back to trusting the poll with nothing to send.
  it('collapses a drag that ended where it started', () => {
    const gesture = endDrag(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 40));
    expect(gesture).toEqual(IDLE_VOLUME_GESTURE);
  });

  it('collapses a release that never moved at all', () => {
    expect(endDrag(IDLE_VOLUME_GESTURE)).toEqual(IDLE_VOLUME_GESTURE);
  });

  // A keyboard step is a whole gesture with no press and no release, and it
  // needs the same protection from a stale poll that a drag gets.
  it('holds a value without claiming a pointer is down', () => {
    const held = dragTo(holdVolume(IDLE_VOLUME_GESTURE, 40), 45);

    expect(held.dragging).toBe(false);
    expect(held.replaced).toBe(40);
    expect(settleVolume(held, 40).local).toBe(45);
  });

  it('keeps the first replaced value across a second drag', () => {
    const first = dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 70);
    const second = beginDrag(first, 40);
    expect(second.replaced).toBe(40);
    expect(second.local).toBe(70);
  });

  it('starts from zero when the device has never reported a volume', () => {
    expect(beginDrag(IDLE_VOLUME_GESTURE, null).local).toBe(0);
  });

  it('clamps a drag to the range Spotify accepts', () => {
    expect(dragTo(beginDrag(IDLE_VOLUME_GESTURE, 40), 190).local).toBe(100);
  });
});
