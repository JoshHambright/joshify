import { describe, expect, it } from 'vitest';
import { createPresetPicker, hashKey, shuffledFor, stepPreset } from './presets.js';
import type { Preset } from './passes.js';

const preset = (id: string): Preset => ({
  id,
  name: id.toUpperCase(),
  scene: 'flat',
  sceneParams: {},
  chain: [],
});

const PRESETS = ['vhs', 'tunnel', 'datamosh', 'ghost'].map(preset);

describe('hashing a track key', () => {
  it('gives the same answer every time', () => {
    expect(hashKey('spotify:track:abc')).toBe(hashKey('spotify:track:abc'));
  });

  it('separates keys that differ only slightly', () => {
    expect(hashKey('track-1')).not.toBe(hashKey('track-2'));
    expect(hashKey('ab')).not.toBe(hashKey('ba'));
  });

  it('stays a 32-bit unsigned integer', () => {
    for (const key of ['', 'a', 'spotify:track:'.repeat(20), '🎵']) {
      const hash = hashKey(key);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  // Every preset should be reachable — a hash that only ever lands on two of
  // four would be deterministic and useless.
  it('spreads across the whole list', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(shuffledFor(PRESETS, `spotify:track:${String(index)}`)?.id ?? '');
    }
    expect(seen.size).toBe(PRESETS.length);
  });
});

describe('stepping', () => {
  it('goes forward and wraps', () => {
    expect(stepPreset(PRESETS, 'vhs', 1)?.id).toBe('tunnel');
    expect(stepPreset(PRESETS, 'ghost', 1)?.id).toBe('vhs');
  });

  it('goes back and wraps', () => {
    expect(stepPreset(PRESETS, 'tunnel', -1)?.id).toBe('vhs');
    expect(stepPreset(PRESETS, 'vhs', -1)?.id).toBe('ghost');
  });

  // `findIndex` answers -1, and stepping from there lands on the *last*
  // preset — so the first tap would appear to go backwards.
  it('starts from the beginning for an id it does not know', () => {
    expect(stepPreset(PRESETS, 'nosuchpreset', 1)?.id).toBe('tunnel');
    expect(stepPreset(PRESETS, null, 1)?.id).toBe('tunnel');
  });

  it('answers null rather than throwing on an empty list', () => {
    expect(stepPreset([], 'vhs', 1)).toBeNull();
    expect(shuffledFor([], 'track')).toBeNull();
  });
});

describe('the picker', () => {
  it('starts on the first preset, or a named one', () => {
    expect(createPresetPicker({ presets: PRESETS }).current()?.preset.id).toBe('vhs');
    expect(
      createPresetPicker({ presets: PRESETS, initialId: 'ghost' }).current()?.preset.id,
    ).toBe('ghost');
  });

  it('falls back to the first when the named one is gone', () => {
    const picker = createPresetPicker({ presets: PRESETS, initialId: 'removed' });
    expect(picker.current()?.preset.id).toBe('vhs');
  });

  it('has nothing to show when there are no presets', () => {
    const picker = createPresetPicker({ presets: [] });
    picker.next();
    picker.select('vhs');
    expect(picker.current()).toBeNull();
  });

  it('steps exactly once per tap', () => {
    const picker = createPresetPicker({ presets: PRESETS });
    picker.next();
    picker.next();
    expect(picker.current()?.preset.id).toBe('datamosh');
    picker.previous();
    expect(picker.current()?.preset.id).toBe('tunnel');
  });
});

/**
 * The reason this module exists.
 *
 * Playback state arrives every couple of seconds, so "the track changed" is
 * re-decided on every poll. Picking randomly each time reshuffles the
 * visualiser two or three times a second — a bug that only appears against a
 * live poll, never against a fixture.
 */
describe('shuffling on track change', () => {
  it('does nothing at all while the track is the same', () => {
    const picker = createPresetPicker({ presets: PRESETS, shuffle: true });
    picker.trackChanged('track-a');
    const first = picker.current()?.preset.id;

    for (let poll = 0; poll < 100; poll += 1) picker.trackChanged('track-a');

    expect(picker.current()?.preset.id).toBe(first);
  });

  it('gives the same track the same preset, always', () => {
    const one = createPresetPicker({ presets: PRESETS, shuffle: true });
    const two = createPresetPicker({ presets: PRESETS, shuffle: true });
    one.trackChanged('spotify:track:xyz');
    two.trackChanged('spotify:track:xyz');

    expect(one.current()?.preset.id).toBe(two.current()?.preset.id);
  });

  it('changes when the track does', () => {
    const picker = createPresetPicker({ presets: PRESETS, shuffle: true });
    const seen = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      picker.trackChanged(`track-${String(index)}`);
      seen.add(picker.current()?.preset.id ?? '');
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(picker.current()?.reason).toBe('shuffled');
  });

  it('leaves the preset alone when shuffle is off', () => {
    const picker = createPresetPicker({ presets: PRESETS });
    picker.trackChanged('track-a');
    picker.trackChanged('track-b');

    expect(picker.current()?.preset.id).toBe('vhs');
    expect(picker.current()?.reason).toBe('default');
  });

  // Continuing to shuffle after someone has picked takes their choice away
  // within seconds, which reads as the panel ignoring them.
  it('keeps a deliberate choice until the track actually changes', () => {
    const picker = createPresetPicker({ presets: PRESETS, shuffle: true });
    picker.trackChanged('track-a');

    picker.select('ghost');
    for (let poll = 0; poll < 50; poll += 1) picker.trackChanged('track-a');

    expect(picker.current()?.preset.id).toBe('ghost');
    expect(picker.current()?.reason).toBe('chosen');
  });

  it('shuffles again on the next track, after a choice', () => {
    const picker = createPresetPicker({ presets: PRESETS, shuffle: true });
    picker.trackChanged('track-a');
    picker.select('ghost');

    picker.trackChanged('track-b');

    expect(picker.current()?.reason).toBe('shuffled');
  });

  // Nothing playing is not a track, and shuffling to a random look because the
  // music stopped would be motion nobody asked for.
  it('does not shuffle when nothing is playing', () => {
    const picker = createPresetPicker({ presets: PRESETS, shuffle: true });
    picker.trackChanged('track-a');
    const before = picker.current()?.preset.id;

    picker.trackChanged(null);

    expect(picker.current()?.preset.id).toBe(before);
  });

  it('can be switched on and off', () => {
    const picker = createPresetPicker({ presets: PRESETS });
    expect(picker.shuffling()).toBe(false);

    picker.setShuffle(true);
    picker.trackChanged('track-a');

    expect(picker.shuffling()).toBe(true);
    expect(picker.current()?.reason).toBe('shuffled');
  });
});
