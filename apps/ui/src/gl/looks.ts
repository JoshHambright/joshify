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
    // The thing that was actually asked for: flat bands from the quantiser,
    // plus the cover's own line work. `edge` takes its gradient from `uArt`
    // rather than the chain, so it finds the artwork's contours instead of
    // whatever the pass before it did to them.
    id: 'cel',
    name: 'Cel',
    scene: 'flat',
    chain: [
      ['posterize', { levels: 4, tint: 0.4 }],
      ['edge', { width: 1, threshold: 0.1, ink: 0, amount: 0.9 }],
      ['grain', { amount: 0.06 }],
    ],
  },
  {
    // Indexed palette cycling under an ordered dither: the most
    // period-correct pairing in the library, and nearly free.
    id: 'cascade',
    name: 'Cascade',
    scene: 'flat',
    chain: [
      ['cycle', { levels: 8, speed: 1, tone: 0.4, amount: 1 }],
      ['dither', { levels: 6, amount: 1 }],
      ['crt', { curve: 0.25, scan: 0.35, mask: 0.15, vignette: 0.35 }],
    ],
  },
  {
    // The 2m look. A coarse emissive grid reads at distance where fine detail
    // does not — this one is a legibility argument that happens to look period.
    id: 'wall',
    name: 'Wall',
    scene: 'flat',
    chain: [
      ['matrix', { pitch: 12, fill: 0.8, gain: 0.8, pulse: 0.5 }],
      ['bloom', { threshold: 0.55, radius: 1, amount: 0.5 }],
      ['bars', { gain: 1, tilt: 0.6, gap: 0.26, height: 0.26, cap: 0.01 }],
    ],
  },
  {
    // P5-33. Two stops per channel is eight colours; the ordered dither is what
    // makes eight look like more, which is the whole technique of the era. The
    // posterize in front of it does the remap through the album's (or the
    // theme's pinned) palette, so the eight stops are *that* palette's.
    //
    // One real pass and a cheap one: deliberately the least expensive look in
    // the library, and the one to fall back to if the Pi cannot hold a budget.
    id: 'vga',
    name: 'VGA',
    scene: 'flat',
    chain: [
      ['posterize', { levels: 4, tint: 0.9 }],
      ['dither', { levels: 2, amount: 0.9 }],
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
  {
    // The orbit-trap fractal, with almost nothing behind it. The scene costs
    // roughly fifteen ordinary passes a fragment and the degrader is not
    // allowed to drop a scene (P5-14), so the chain is where the budget has to
    // come from: one cheap pass, no bloom and no edge. `steps` is the first
    // dial to reach for if a real Pi cannot hold it.
    id: 'orbit',
    name: 'Orbit',
    scene: 'fractal',
    sceneParams: { scale: 3, steps: 32, trap: 0.5, swell: 0.35 },
    chain: [['grain', { amount: 0.08 }]],
  },
  {
    // P5-37, the calm mode (D-018). Everything here is chosen against the
    // brief rather than for impact: the bloom is low so the caustic filaments
    // bleed like light in water, the grain is silt, and the CRT is present
    // only for its vignette — corners darkened, not a television.
    //
    // No `bars`. A spectrum bar is the single most anti-calm element in the
    // library and would undo the thing the scene exists for.
    id: 'reef',
    name: 'Reef',
    scene: 'reef',
    sceneParams: { drift: 1, sway: 0.3, flow: 0.8, caustics: 0.7, rays: 0.5, murk: 0.75 },
    chain: [
      ['bloom', { threshold: 0.5, radius: 1, amount: 0.35 }],
      ['grain', { amount: 0.05 }],
      ['crt', { curve: 0.15, scan: 0.12, mask: 0.05, vignette: 0.45 }],
    ],
  },
  {
    // P5-35. Five solids drifting over the cover, each facet a crop of that
    // same cover — the wallpaper and the screensaver at once, which is what
    // the 1995 desktop-theme idiom actually was.
    //
    // The chain is the era's colour depth and nothing else. No `crt`: this is
    // a desktop, not a console. Nothing that softens an edge either — the
    // whole appeal is clean hard facets, and bloom or blur throws that away.
    id: 'solids',
    name: 'Solids',
    scene: 'ambient',
    sceneParams: {
      spin: 1,
      drift: 1,
      size: 1,
      swell: 0.12,
      light: 0.75,
      tint: 0.3,
      backdrop: 0.22,
      haze: 0.7,
    },
    chain: [
      ['posterize', { levels: 6, tint: 0.25 }],
      ['dither', { levels: 6, amount: 0.35 }],
      ['grain', { amount: 0.05 }],
    ],
  },
  {
    // The cover as a heightfield, flown over. The scene is already doing the
    // geometry work, so the chain is two nearly-free PS1 passes to put it in
    // the right decade, and the bars overlay because this one is meant to be
    // watched rather than left running.
    id: 'relief',
    name: 'Relief',
    scene: 'terrain',
    sceneParams: {
      speed: 6,
      height: 6.5,
      contrast: 0.75,
      relief: 0.4,
      grid: 0.3,
      pulse: 0.25,
    },
    chain: [
      ['fifteenbit', {}],
      ['twoforty', {}],
      ['bars', { gain: 1, tilt: 0.6, gap: 0.3, height: 0.22, cap: 0.01 }],
    ],
  },
  {
    // The other one you can leave running. Feedback over a mostly-black frame
    // is motion trails for almost nothing, and there is deliberately no `bars`
    // overlay: a spectrum bar fights a look whose whole job is to be ignorable.
    id: 'drift',
    name: 'Drift',
    scene: 'starfield',
    sceneParams: {
      speed: 0.06,
      spread: 5,
      size: 0.2,
      parallax: 0.7,
      warp: 0.4,
      glow: 0.45,
    },
    chain: [
      ['feedback', { zoom: 0.004, decay: 0.82 }],
      ['bloom', { threshold: 0.5, radius: 1, amount: 0.5 }],
      ['grain', { amount: 0.05 }],
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
