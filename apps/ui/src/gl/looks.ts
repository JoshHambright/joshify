/**
 * The named looks, as data.
 *
 * This file is the payoff of P5-01's design: every entry below is a scene id,
 * an ordered list of pass ids, and some numbers. There is no code path per
 * look, no `switch`, and nothing here that a JSON file could not have said —
 * which is exactly the test of whether "presets are data" was true or just
 * asserted.
 *
 * The names come from VISUALIZER.md. The *combinations* come from the four
 * agents who wrote the families, each of whom reported which of their passes
 * layer well and which fight; where two of them disagreed about a pass, the
 * cheaper reading won, because the budget is six passes and a Pi.
 */
import {
  parsePreset,
  BUILT_IN_CATALOGUE,
  type Catalogue,
  type Preset,
} from './passes.js';
import { isOk } from '@joshify/core';

interface LookSpec {
  readonly id: string;
  readonly name: string;
  readonly scene: string;
  readonly sceneParams?: Readonly<Record<string, number>>;
  readonly chain: readonly (readonly [string, Readonly<Record<string, number>>?])[];
}

/**
 * Six looks, in the order they cycle.
 *
 * Deliberately ordered so that consecutive taps are visibly different rather
 * than shading into one another — two feedback-heavy looks side by side make
 * the button feel broken.
 */
const LOOKS: readonly LookSpec[] = [
  {
    // The default. Barely there: the album is the point, and this is the look
    // that runs while somebody is actually using the panel.
    id: 'ghost',
    name: 'Ghost',
    scene: 'flat',
    chain: [
      ['feedback', { zoom: 0.012, decay: 0.86 }],
      ['grain', { amount: 0.1 }],
    ],
  },
  {
    // Tape into tube. Wobble is geometric, CRT is tonal, so they do not fight.
    id: 'vhs',
    name: 'VHS',
    scene: 'flat',
    chain: [
      ['vhs', { wobble: 0.6, tracking: 0.7, chroma: 0.6 }],
      ['crt', { curve: 0.35, scan: 0.5, mask: 0.25, vignette: 0.4 }],
      ['grain', { amount: 0.14 }],
    ],
  },
  {
    // Displace, punch through, quantise. Five fetches, all beat-gated — the
    // cheapest full-strength look in the library.
    id: 'datamosh',
    name: 'Datamosh',
    scene: 'flat',
    chain: [
      ['blockshift', { block: 20, amount: 0.4, shift: 0.14, corrupt: 0.45 }],
      ['dropout', { block: 44, amount: 0.4, noise: 0.3 }],
      ['bitcrush', { levels: 6, crunch: 0.5, bias: 0.35 }],
    ],
  },
  {
    // Quantise to a small palette, then break the banding the quantiser just
    // made. Halftone last, at a low scale: two grids beat against each other
    // above about eight texels.
    id: 'newsprint',
    name: 'Newsprint',
    scene: 'flat',
    chain: [
      ['posterize', { levels: 4, tint: 0.5 }],
      ['halftone', { scale: 6, angle: 0.785, softness: 0.15 }],
      ['crt', { curve: 0.2, scan: 0.3, mask: 0.1, vignette: 0.35 }],
    ],
  },
  {
    // The Winamp window. Kaleido folds the art, particles sparkle in the
    // folded space, bars and scope sit sharp on top as overlays.
    id: 'vapor',
    name: 'Vapor',
    scene: 'flat',
    chain: [
      ['kaleido', { segments: 6, spin: 0.07, pulse: 0.16, mix: 0.9 }],
      ['particles', { density: 12, size: 0.16, rise: 0.6, life: 2.4 }],
      ['bloom', { threshold: 0.62, radius: 1, amount: 0.6 }],
      ['bars', { gain: 1.15, tilt: 0.6, gap: 0.22, height: 0.3, cap: 0.012 }],
    ],
  },
  {
    // P5-26. The tunnel with its era's artefacts, and nothing else — the scene
    // is already doing the work, and stacking post over it wastes budget the
    // geometry needs.
    id: 'tunnel',
    name: 'Tunnel',
    scene: 'tunnel',
    sceneParams: { speed: 1.1, radius: 1, pulse: 0.35, curve: 0.5, snap: 1, affine: 1 },
    chain: [
      ['fifteenbit', {}],
      ['twoforty', {}],
      ['bars', { gain: 1, tilt: 0.6, gap: 0.3, height: 0.22, cap: 0.01 }],
    ],
  },
];

/**
 * Build the looks against a catalogue, dropping any that will not parse.
 *
 * Dropping rather than throwing, and returning the problems alongside: a look
 * that names a pass somebody renamed should not take the visualiser down with
 * it, but it must not disappear silently either — the panel keeps working and
 * the problem is reportable.
 */
export interface BuiltLooks {
  readonly presets: readonly Preset[];
  readonly problems: readonly string[];
}

export const buildLooks = (catalogue: Catalogue = BUILT_IN_CATALOGUE): BuiltLooks => {
  const presets: Preset[] = [];
  const problems: string[] = [];

  for (const look of LOOKS) {
    const parsed = parsePreset(
      {
        id: look.id,
        name: look.name,
        scene: look.scene,
        sceneParams: look.sceneParams ?? {},
        chain: look.chain.map(([pass, params]) => ({ pass, params: params ?? {} })),
      },
      catalogue,
    );
    if (isOk(parsed)) presets.push(parsed.value);
    else problems.push(`${look.id}: ${parsed.error.reason} — ${parsed.error.detail}`);
  }

  return { presets, problems };
};

/** The ids, in cycle order. Exported so a test can assert the order is stable. */
export const LOOK_IDS: readonly string[] = LOOKS.map((look) => look.id);
