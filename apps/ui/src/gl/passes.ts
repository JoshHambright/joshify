/**
 * Scenes and passes as data, and the parser that turns a preset into them.
 *
 * The rule from VISUALIZER.md, which this file exists to keep: **a preset is a
 * JSON list of passes with parameters, not a code path.** Adding an effect is
 * adding a fragment shader and an entry in a catalogue; nothing in the
 * pipeline learns its name, and nothing anywhere branches on it. The same goes
 * for scenes after D-014 — `flat` and `tunnel` are two rows in a table, not an
 * `if` in the renderer.
 *
 * A preset that names something we do not have is a *data* error, not a bug,
 * so it comes back as a `Result` for the caller to show or fall back from
 * rather than throwing into a render loop.
 */
import { err, ok, type Result } from '@joshify/core';
import type { GeometrySpec } from './gl-context.js';

/** A tunable a preset may set. Bounds are enforced at parse, not in GLSL. */
import { GLITCH_PASSES } from './effects/glitch.js';
import { LOFI_PASSES } from './effects/lofi.js';
import { CLASSIC_PASSES } from './effects/classics.js';
import { PS1_PASSES } from './effects/ps1.js';
import { ART_PASSES } from './effects/art.js';
import { TUNNEL_SCENE } from './scenes/tunnel.js';
import { FRACTAL_SCENE } from './scenes/fractal.js';
import { REEF_SCENE } from './scenes/reef.js';

export interface PassParam {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export type ParamSpec = Readonly<Record<string, PassParam>>;

export interface PassDefinition {
  readonly id: string;
  readonly fragment: string;
  readonly params: ParamSpec;
  /**
   * Draws over the finished, full-resolution frame instead of inside the
   * scaled chain. Spectrum bars and text need real pixels — a half-resolution
   * upscale of a 1px bar edge is mush (VISUALIZER.md, "effects that need
   * sharpness"). An overlay gets no `uTexture`: it composites, it does not
   * filter.
   */
  readonly overlay?: boolean | undefined;
}

export interface SceneDefinition {
  readonly id: string;
  readonly vertex: string;
  readonly fragment: string;
  readonly geometry: GeometrySpec;
  /**
   * The tunnel deliberately runs without one (PS1 artefact 04), and a flat
   * quad has no use for one, so this is per scene rather than global.
   */
  readonly depthTest: boolean;
  readonly params: ParamSpec;
}

export interface Catalogue {
  readonly scenes: readonly SceneDefinition[];
  readonly passes: readonly PassDefinition[];
}

export interface PresetPass {
  readonly pass: string;
  readonly params: Readonly<Record<string, number>>;
}

export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly scene: string;
  readonly sceneParams: Readonly<Record<string, number>>;
  readonly chain: readonly PresetPass[];
}

export type PresetProblemReason =
  'malformed' | 'unknown-scene' | 'unknown-pass' | 'chain-too-long';

export interface PresetProblem {
  readonly reason: PresetProblemReason;
  readonly detail: string;
}

/**
 * The budget in VISUALIZER.md is six passes a frame. It is enforced here, at
 * the door, because a preset with nine passes is a mistake somebody made in a
 * text editor — the degrader (budget.ts) exists for a Pi having a bad second,
 * not to paper over a preset that was never going to fit.
 */
export const MAX_CHAIN_LENGTH = 6;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const clampTo = (param: PassParam, value: number): number =>
  Math.min(param.max, Math.max(param.min, value));

/**
 * Defaults for everything the shader declares, overridden by whatever the
 * preset set and could set.
 *
 * Unknown keys are dropped rather than rejected: presets outlive shaders, and
 * a preset carrying `uWobble` for a pass that stopped wobbling should still
 * load. Out-of-range values are clamped for the same reason — a `0..1` mix
 * fed `4` is a preset written against a different version, not a reason to
 * refuse to draw.
 */
export const resolveParams = (
  spec: ParamSpec,
  given: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> => {
  const resolved: Record<string, number> = {};
  for (const [name, param] of Object.entries(spec)) {
    const raw = given[name];
    resolved[name] =
      typeof raw === 'number' && Number.isFinite(raw)
        ? clampTo(param, raw)
        : param.default;
  }
  return resolved;
};

export const findScene = (
  catalogue: Catalogue,
  id: string,
): SceneDefinition | undefined => catalogue.scenes.find((scene) => scene.id === id);

export const findPass = (catalogue: Catalogue, id: string): PassDefinition | undefined =>
  catalogue.passes.find((pass) => pass.id === id);

/**
 * Validate a preset against a catalogue.
 *
 * Overlays are hoisted to the end of the chain, keeping their order among
 * themselves. An overlay in the middle would mean upscaling to draw it and
 * downscaling to carry on, which costs more than the whole chain it sits in;
 * moving it is the only sane reading of what the preset meant.
 */
export const parsePreset = (
  raw: unknown,
  catalogue: Catalogue,
): Result<Preset, PresetProblem> => {
  const body = asRecord(raw);
  if (body === null) return err({ reason: 'malformed', detail: 'not an object' });

  const id = asString(body['id']);
  if (id === null) return err({ reason: 'malformed', detail: 'missing id' });

  const sceneId = asString(body['scene']);
  if (sceneId === null) return err({ reason: 'malformed', detail: 'missing scene' });

  const scene = findScene(catalogue, sceneId);
  if (scene === undefined) {
    return err({ reason: 'unknown-scene', detail: sceneId });
  }

  const rawChain = body['chain'];
  if (rawChain !== undefined && !Array.isArray(rawChain)) {
    return err({ reason: 'malformed', detail: 'chain is not a list' });
  }
  const entries: readonly unknown[] = Array.isArray(rawChain) ? rawChain : [];
  if (entries.length > MAX_CHAIN_LENGTH) {
    return err({
      reason: 'chain-too-long',
      detail: `${String(entries.length)} passes, limit ${String(MAX_CHAIN_LENGTH)}`,
    });
  }

  const scaled: PresetPass[] = [];
  const overlays: PresetPass[] = [];
  for (const entry of entries) {
    const step = asRecord(entry);
    const passId = step === null ? null : asString(step['pass']);
    if (step === null || passId === null) {
      return err({ reason: 'malformed', detail: 'chain entry has no pass' });
    }
    const definition = findPass(catalogue, passId);
    if (definition === undefined) {
      return err({ reason: 'unknown-pass', detail: passId });
    }
    const resolved: PresetPass = {
      pass: passId,
      params: resolveParams(definition.params, asRecord(step['params']) ?? {}),
    };
    if (definition.overlay === true) overlays.push(resolved);
    else scaled.push(resolved);
  }

  return ok({
    id,
    name: asString(body['name']) ?? id,
    scene: sceneId,
    sceneParams: resolveParams(scene.params, asRecord(body['sceneParams']) ?? {}),
    chain: [...scaled, ...overlays],
  });
};

/** The same, from the text a preset file actually is. */
export const parsePresetJson = (
  text: string,
  catalogue: Catalogue,
): Result<Preset, PresetProblem> => {
  try {
    return parsePreset(JSON.parse(text), catalogue);
  } catch {
    return err({ reason: 'malformed', detail: 'not JSON' });
  }
};

/* ------------------------------------------------------------------ */
/* The built-in catalogue                                              */
/* ------------------------------------------------------------------ */

/**
 * One triangle, not two — it covers the viewport with a single primitive and
 * no diagonal seam, so a tile-based GPU rasterises each tile once. On a Pi 5
 * the whole chain is fragment-bound; anything that halves the vertex work and
 * removes an edge is free money.
 */
export const FULLSCREEN_TRIANGLE: GeometrySpec = {
  attributes: [{ location: 0, size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) }],
  count: 3,
};

/** Shared by every post pass and by the flat scene. */
export const POST_VERTEX = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * The album cover as a full-screen quad — the scene families A-E assumed
 * before D-014 gave them a stage to sit on. `tunnel` lands beside it as data
 * in P5-23; the pipeline will not need editing to accept it.
 */
export const FLAT_SCENE: SceneDefinition = {
  id: 'flat',
  vertex: POST_VERTEX,
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uArt;
uniform vec3 uAccent;
uniform float uBeat;
uniform float uFlash;
out vec4 fragColour;
void main() {
  vec3 art = texture(uArt, vUv).rgb;
  fragColour = vec4(mix(art, uAccent, uBeat * uFlash), 1.0);
}
`,
  geometry: FULLSCREEN_TRIANGLE,
  // A single quad has nothing to sort against itself.
  depthTest: false,
  params: { flash: { default: 0.15, min: 0, max: 1 } },
};

/**
 * The Milkdrop core: last frame, scaled up a hair, mixed back in. It ships
 * with the pipeline rather than with effect family A (P5-06) because it is the
 * one pass that reads `uPrev`, and without it the ping-pong wiring would have
 * nothing exercising it end to end.
 */
export const FEEDBACK_PASS: PassDefinition = {
  id: 'feedback',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform sampler2D uPrev;
uniform float uZoom;
uniform float uDecay;
uniform float uBeat;
out vec4 fragColour;
void main() {
  vec2 centred = (vUv - 0.5) / (1.0 + uZoom * (1.0 + uBeat)) + 0.5;
  vec3 trail = texture(uPrev, centred).rgb * uDecay;
  vec3 here = texture(uTexture, vUv).rgb;
  fragColour = vec4(max(here, trail), 1.0);
}
`,
  params: {
    zoom: { default: 0.02, min: 0, max: 0.25 },
    decay: { default: 0.9, min: 0, max: 0.995 },
  },
};

/**
 * Animated grain — cheap, and the thing the half-res upscale wants on top.
 *
 * Three things here are deliberate, and all three were wrong in the first
 * version (found while writing the lofi family, P5-08):
 *
 *  - **It reads `uIntensity`.** Without that the user's effect dial cannot
 *    reach it and neither can the legibility floor (P5-16) — a pass that
 *    ignores intensity is a pass that cannot be turned down.
 *  - **The noise field advances with `floor(uTime * 60.0)` rather than
 *    `fract(uTime)`.** `fract` returns to the same value every second, so the
 *    grain pattern repeated exactly once a second — slow enough to read as a
 *    pulse rather than as noise.
 *  - **The noise is applied as a gain, not an offset.** Flat additive noise
 *    clips against black, so half of it is discarded in the shadows and the
 *    mean luminance drifts down as the amount rises. Multiplying keeps the
 *    mean where it was, which is what lets the legibility floor treat this
 *    pass as neutral.
 */
export const GRAIN_PASS: PassDefinition = {
  id: 'grain',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uTime;
uniform float uAmount;
uniform float uIntensity;
out vec4 fragColour;
// highp: the seed is a pixel index times a frame counter, and mediump cannot
// hold either past a few thousand — the field collapses into bands.
float hash(highp vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  highp vec2 cell = floor(vUv * uResolution);
  float noise = hash(cell + floor(uTime * 60.0) * 71.0) - 0.5;
  // A gain around 1.0 rather than an offset around 0.0: additive noise clips
  // in the blacks and quietly darkens the frame.
  float gain = 1.0 + noise * uAmount * uIntensity;
  fragColour = vec4(here * gain, 1.0);
}
`,
  params: { amount: { default: 0.16, min: 0, max: 1 } },
};

/**
 * Everything a preset may name.
 *
 * Assembled here rather than in each family so that "what exists" has one
 * answer, and so a family can be written, tested and reviewed without also
 * editing a shared registry — which is what let four of these be built in
 * parallel without touching the same file.
 */
export const BUILT_IN_CATALOGUE: Catalogue = {
  scenes: [FLAT_SCENE, TUNNEL_SCENE, FRACTAL_SCENE, REEF_SCENE],
  passes: [
    FEEDBACK_PASS,
    GRAIN_PASS,
    ...GLITCH_PASSES,
    ...LOFI_PASSES,
    ...CLASSIC_PASSES,
    ...PS1_PASSES,
    ...ART_PASSES,
  ],
};

/** The floor: what the visualiser looks like before anyone chooses anything. */
export const DEFAULT_PRESET_JSON = {
  id: 'ghost',
  name: 'Ghost',
  scene: 'flat',
  sceneParams: { flash: 0.2 },
  chain: [
    { pass: 'feedback', params: { zoom: 0.03, decay: 0.88 } },
    { pass: 'grain', params: { amount: 0.06 } },
  ],
};
