/**
 * The uniform contract — the seam between the reactivity provider and the GPU.
 *
 * Every shader in the engine, scene or post pass, reads the same block. What
 * fills it is somebody else's problem: Tier 0 makes it up from a clock, Tier 1
 * phase-locks it to a BPM lookup, Tier 2 gets it from a real FFT of the PCM
 * librespot is decoding (VISUALIZER.md). The shaders never know which, and
 * nothing in this directory imports the provider — it hands us plain numbers.
 *
 * The block, as GLSL:
 *
 * ```glsl
 * uniform float     uTime;        // seconds, monotonic
 * uniform float     uBeat;        // 0..1, decaying spike on each beat
 * uniform float     uEnergy;      // 0..1, overall intensity
 * uniform float     uBands[16];   // 0..1, bass -> treble
 * uniform float     uIntensity;   // 0..1, the user's effect-strength dial
 * uniform vec3      uAccent;      // from the album art
 * uniform vec3      uForeground;
 * uniform vec2      uResolution;  // the size being rendered, not the panel
 * uniform vec2      uTexel;       // 1.0 / uResolution
 * uniform sampler2D uTexture;     // what the previous stage drew
 * uniform sampler2D uArt;         // the album cover
 * uniform sampler2D uPrev;        // last frame's output, for feedback
 * ```
 *
 * Pass parameters arrive alongside as `uName` — a preset's `{"amount": 0.4}`
 * becomes `uAmount`. That mapping is what lets a preset be data: adding an
 * effect adds a shader and a JSON entry, never a branch (VISUALIZER.md).
 */
import { float, floats, sampler, vec2, vec3, type UniformValue } from './gl-context.js';

/** Sixteen buckets, because that is what the contract in VISUALIZER.md says. */
export const BAND_COUNT = 16;

/**
 * Texture units are fixed for the life of the engine. A shader declares only
 * the samplers it uses, and the pipeline binds all three every draw — one
 * `activeTexture` per unit is cheaper than tracking which pass wanted what.
 */
export const UNIT_TEXTURE = 0;
export const UNIT_ART = 1;
export const UNIT_PREV = 2;

export type Rgb = readonly [number, number, number];

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** What a reactivity provider produces. Plain numbers, no dependency. */
export interface Reactivity {
  readonly timeSeconds: number;
  readonly beat: number;
  readonly energy: number;
  readonly bands: readonly number[];
}

export interface FrameContext {
  readonly reactivity: Reactivity;
  readonly accent: Rgb;
  readonly foreground: Rgb;
  readonly intensity: number;
  /** The resolution *this stage* renders at — see `buildFrameUniforms`. */
  readonly resolution: Size;
}

export type UniformSet = Readonly<Record<string, UniformValue>>;

/**
 * A provider that hands us `NaN` — a division by a zero BPM, an FFT of
 * silence — would otherwise poison every uniform it touches, and NaN in a
 * shader is a black screen with no error anywhere. One bad sample should cost
 * one dull frame, not the session.
 */
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

export const clamp01 = (value: number): number => {
  const safe = finite(value);
  if (safe < 0) return 0;
  if (safe > 1) return 1;
  return safe;
};

/**
 * Exactly `BAND_COUNT` values, whatever the provider gave us.
 *
 * A short array is padded with silence rather than left ragged: `uniform1fv`
 * against a shorter array leaves the tail at whatever the last preset wrote,
 * so an eight-band provider would show a frozen top octave.
 */
export const normaliseBands = (bands: readonly number[]): readonly number[] =>
  Array.from({ length: BAND_COUNT }, (_unused, index) => clamp01(bands[index] ?? 0));

const rgb = (colour: Rgb): Rgb => [clamp01(colour[0]), clamp01(colour[1]), clamp01(colour[2])];

/** A preset parameter `amount` reaches its shader as `uAmount`. */
export const paramUniformName = (param: string): string =>
  `u${param.charAt(0).toUpperCase()}${param.slice(1)}`;

export const paramUniforms = (params: Readonly<Record<string, number>>): UniformSet => {
  const set: Record<string, UniformValue> = {};
  for (const [name, value] of Object.entries(params)) {
    set[paramUniformName(name)] = float(finite(value));
  }
  return set;
};

/**
 * The shared block for one stage of one frame.
 *
 * `uResolution` is the size of the surface being drawn *now*, not the panel:
 * a pass running at 0.5 scale that thinks it is full size samples half a texel
 * off, which is exactly the sort of wrongness that reads as "slightly blurry"
 * and never gets diagnosed. `uTexel` is shipped with it because every glitch
 * and blur pass needs `1.0 / resolution` and a reciprocal per fragment is real
 * money on a VideoCore VII.
 */
export const buildFrameUniforms = (context: FrameContext): UniformSet => {
  const { reactivity, resolution } = context;
  const width = Math.max(1, Math.round(finite(resolution.width)));
  const height = Math.max(1, Math.round(finite(resolution.height)));
  return {
    // Not clamped: time is monotonic and unbounded by design, and a shader
    // that wants it wrapped can wrap it.
    uTime: float(finite(reactivity.timeSeconds)),
    uBeat: float(clamp01(reactivity.beat)),
    uEnergy: float(clamp01(reactivity.energy)),
    uBands: floats(normaliseBands(reactivity.bands)),
    uIntensity: float(clamp01(context.intensity)),
    uAccent: vec3(rgb(context.accent)),
    uForeground: vec3(rgb(context.foreground)),
    uResolution: vec2(width, height),
    uTexel: vec2(1 / width, 1 / height),
    uTexture: sampler(UNIT_TEXTURE),
    uArt: sampler(UNIT_ART),
    uPrev: sampler(UNIT_PREV),
  };
};
