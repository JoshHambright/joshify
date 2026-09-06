/**
 * Which look is on screen, and how it changes.
 *
 * Three ways a preset changes, and they are genuinely different:
 *
 *  - **Touch**, which steps to the next one. Explicit, and the viewer expects
 *    exactly one step per tap.
 *  - **Shuffle on track change**, which picks one for the new track.
 *  - **Nothing**, which is most of the time.
 *
 * The trap is in the second one, and it is not obvious until it is on a wall.
 * Playback state arrives every couple of seconds, and "the track changed" is
 * something a naive implementation re-decides on every one of those. Pick
 * randomly each time and the visualiser reshuffles itself two or three times a
 * second — not a subtle bug, but one that only appears once the panel is
 * running against a live poll rather than a fixture.
 *
 * So the shuffle is a **pure function of the track key**: the same track always
 * yields the same preset, and the choice only moves when the key does. There is
 * no "did it change since last time" flag to get wrong, because there is no
 * state at all.
 */
import type { Preset } from './passes.js';

export interface PresetSelection {
  readonly preset: Preset;
  /** Why this one is showing. Surfaced so the UI can say so, and for tests. */
  readonly reason: 'default' | 'chosen' | 'shuffled';
}

/**
 * A stable 32-bit hash of a string.
 *
 * FNV-1a: small, no dependencies, and — the only property that matters here —
 * deterministic. `Math.random()` would reshuffle on every poll, and a counter
 * would depend on how many times the function happened to be called.
 */
export const hashKey = (key: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    // The FNV prime, as shifts: `hash * 16777619` overflows to a float and
    // loses the low bits, which is exactly the part carrying the entropy.
    hash =
      (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
};

/** The preset a given track shuffles to. Same track, same answer, always. */
export const shuffledFor = (
  presets: readonly Preset[],
  trackKey: string,
): Preset | null => {
  if (presets.length === 0) return null;
  return presets[hashKey(trackKey) % presets.length] ?? null;
};

/** Step by `delta`, wrapping. Touch steps by one; nothing else steps at all. */
export const stepPreset = (
  presets: readonly Preset[],
  currentId: string | null,
  delta: number,
): Preset | null => {
  if (presets.length === 0) return null;
  const at = presets.findIndex((preset) => preset.id === currentId);
  // An unknown current id starts from the beginning rather than from -1, which
  // would make the first tap land on the *last* preset.
  const from = at === -1 ? 0 : at;
  const next = (((from + delta) % presets.length) + presets.length) % presets.length;
  return presets[next] ?? null;
};

export interface PresetPickerConfig {
  readonly presets: readonly Preset[];
  /** Shown before anything else has been decided. Defaults to the first. */
  readonly initialId?: string | undefined;
  readonly shuffle?: boolean | undefined;
}

export interface PresetPicker {
  readonly current: () => PresetSelection | null;
  /** A tap. Steps one forward and *stops shuffling* — see below. */
  readonly next: () => void;
  readonly previous: () => void;
  readonly select: (id: string) => void;
  readonly setShuffle: (on: boolean) => void;
  readonly shuffling: () => boolean;
  /**
   * The track on screen. Safe to call on every poll — it does nothing unless
   * the key actually changed.
   */
  readonly trackChanged: (trackKey: string | null) => void;
}

export const createPresetPicker = (config: PresetPickerConfig): PresetPicker => {
  const { presets } = config;
  let shuffle = config.shuffle ?? false;
  let lastTrackKey: string | null = null;
  const initial =
    presets.find((preset) => preset.id === config.initialId) ?? presets[0] ?? null;
  let chosen: PresetSelection | null =
    initial === null ? null : { preset: initial, reason: 'default' };

  const step = (delta: number): void => {
    const preset = stepPreset(presets, chosen?.preset.id ?? null, delta);
    if (preset === null) return;
    // A deliberate choice outranks shuffle until the next track. Continuing to
    // shuffle after someone has picked would take their choice away within
    // seconds, which reads as the panel ignoring them.
    chosen = { preset, reason: 'chosen' };
  };

  return {
    current: () => chosen,
    next: () => {
      step(1);
    },
    previous: () => {
      step(-1);
    },
    select: (id) => {
      const preset = presets.find((candidate) => candidate.id === id);
      if (preset !== undefined) chosen = { preset, reason: 'chosen' };
    },
    setShuffle: (on) => {
      shuffle = on;
    },
    shuffling: () => shuffle,
    trackChanged: (trackKey) => {
      // The guard that makes this safe to call from the poll loop.
      if (trackKey === lastTrackKey) return;
      lastTrackKey = trackKey;
      if (!shuffle || trackKey === null) return;
      const preset = shuffledFor(presets, trackKey);
      if (preset !== null) chosen = { preset, reason: 'shuffled' };
    },
  };
};
