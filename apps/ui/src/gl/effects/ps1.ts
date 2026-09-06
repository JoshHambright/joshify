/**
 * The PS1 artefacts that belong in the post chain (P5-24).
 *
 * PS1_MODE.md lists six real behaviours of the PSX GPU. Four of them are not
 * post-processing and cannot be made into passes without either doing nothing
 * or becoming untoggleable, so they live in the scene (`scenes/tunnel.ts`):
 *
 * - **Vertex snap** moves vertices. There are no vertices in a post pass.
 * - **Affine texture mapping** is a property of the interpolation between a
 *   vertex shader and a fragment shader. By the time the chain runs, the
 *   texturing has already happened, correctly.
 * - **No z-buffer** is `depthTest: false` plus a back-to-front index order —
 *   pipeline state and geometry, not a shader at all.
 * - **Distance fog** needs distance. The chain's targets are RGBA8 colour with
 *   no depth attachment and nothing carrying a per-fragment z, so a "fog" pass
 *   could only fake it from screen position — which would come apart the
 *   moment the tunnel bends, and would lie about the tunnel being fogged when
 *   the scene is `flat`.
 *
 * The two that genuinely are post-processing are here, one pass each, so a
 * preset turns them on and off by naming them (or not) in its chain. They are
 * deliberately scene-agnostic: 15-bit dither over the album quad or over a
 * datamoshed feedback trail is just as period-correct as it is over the tube.
 *
 * The catalogue-level answer to "all six, individually toggleable" is
 * `PS1_ARTEFACTS` below, which names where each one's switch is.
 */
import type { PassDefinition } from '../passes.js';

/**
 * Artefact 03 — 15-bit colour with ordered dither.
 *
 * The PSX framebuffer stored five bits per channel, and its hardware dither
 * hid the banding that produces. Both halves are here in one pass because
 * either alone is wrong: quantising without dithering gives flat posterised
 * bands, and dithering without quantising is just noise.
 *
 * The dither amplitude is one quantisation step (`uAmount / uLevels`) rather
 * than a free-floating constant. That is the amount that actually trades
 * banding for texture — less leaves the bands, more is grain on top of them —
 * and expressing it against `uLevels` keeps that true when a preset changes
 * the depth.
 */
export const FIFTEEN_BIT_PASS: PassDefinition = {
  id: 'fifteenbit',
  fragment: `#version 300 es
precision mediump float;

in vec2 vUv;

uniform sampler2D uTexture;
uniform float uAmount;
uniform float uLevels;

out vec4 fragColour;

// The 4x4 ordered (Bayer) matrix. Held as a mat4 constant because that is one
// register of uniform-free lookup; the transpose of a Bayer matrix is also a
// Bayer matrix, so the column-major fill order does not matter.
const mat4 kBayer = mat4(
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

void main() {
  vec3 colour = texture(uTexture, vUv).rgb;

  // gl_FragCoord, not vUv: the pattern has to be locked to the pixel grid of
  // the surface being drawn, or it swims when the render scale changes.
  int x = int(mod(gl_FragCoord.x, 4.0));
  int y = int(mod(gl_FragCoord.y, 4.0));
  float threshold = kBayer[x][y] / 16.0 - 0.5;

  float levels = max(uLevels, 1.0);
  colour += threshold * uAmount / levels;
  colour = floor(colour * levels + 0.5) / levels;

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`,
  params: {
    /** In quantisation steps. 0 is banding, 1 is the console's own dither. */
    amount: { default: 1, min: 0, max: 2 },
    /** Steps per channel. 31 is 32 levels, five bits, 15-bit colour. */
    levels: { default: 31, min: 1, max: 255 },
  },
};

/**
 * Artefact 06 — 240p-class output.
 *
 * This overlaps the render-scale ladder (D-011, P5-13) on purpose. The ladder
 * is a *performance* dial the user drives with the grain slider and the
 * degrader walks under them; it is not part of a preset and cannot be, which
 * means a look that depends on chunky pixels would be at the mercy of how busy
 * the Pi was. This pass pins the pixel size to a line count the preset asks
 * for, so `N2O` looks like `N2O` at any render scale, and the artefact has an
 * off switch like the other five.
 *
 * Cells are square rather than stretched to the panel: a 16:9 240-line frame
 * is 427 columns, not 320, and rectangular pixels read as a broken aspect
 * ratio rather than as a console.
 */
export const TWO_FORTY_PASS: PassDefinition = {
  id: 'twoforty',
  fragment: `#version 300 es
precision mediump float;

// highp: vUv * cells reaches a few hundred, and at mediump neighbouring
// fragments would disagree about which cell they are in — a ragged grid, on
// hardware only.
in highp vec2 vUv;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uLines;

out vec4 fragColour;

void main() {
  // Never finer than the surface we are sampling: asking for 720 lines from a
  // 360-line chain would resample noise into the picture for nothing.
  highp float rows = clamp(uLines, 1.0, max(uResolution.y, 1.0));
  highp float aspect = uResolution.x / max(uResolution.y, 1.0);
  highp vec2 cells = vec2(max(floor(rows * aspect), 1.0), floor(rows));

  // Cell centres, so the result is a true point sample of one texel rather
  // than a blur of the four the cell corner sits between.
  highp vec2 uv = (floor(vUv * cells) + 0.5) / cells;
  fragColour = vec4(texture(uTexture, uv).rgb, 1.0);
}
`,
  params: {
    /** Scanlines in the output. 240 is the console; 480 is barely there. */
    lines: { default: 240, min: 60, max: 720 },
  },
};

/** The chain half of P5-24. The scene half is in `scenes/tunnel.ts`. */
export const PS1_PASSES: readonly PassDefinition[] = [FIFTEEN_BIT_PASS, TWO_FORTY_PASS];

/**
 * Where each artefact's switch is.
 *
 * This exists so "all six, individually toggleable" is a fact something checks
 * rather than a claim in a document — `ps1.test.ts` resolves every `toggle`
 * against the real scene and the real passes, so moving one and forgetting the
 * other fails in CI instead of on the Pi.
 */
export type Ps1Stage = 'scene-vertex' | 'scene-fragment' | 'scene-state' | 'post';

export interface Ps1Artefact {
  /** Its number in the PS1_MODE.md table. */
  readonly index: number;
  readonly name: string;
  readonly stage: Ps1Stage;
  /**
   * A scene parameter name, a pass id, or — for the one artefact that is
   * neither — the `SceneDefinition` field that carries it.
   */
  readonly toggle: string;
}

export const PS1_ARTEFACTS: readonly Ps1Artefact[] = [
  { index: 1, name: 'vertex snap', stage: 'scene-vertex', toggle: 'snap' },
  { index: 2, name: 'affine texture mapping', stage: 'scene-vertex', toggle: 'affine' },
  { index: 3, name: '15-bit colour + dither', stage: 'post', toggle: 'fifteenbit' },
  { index: 4, name: 'no z-buffer', stage: 'scene-state', toggle: 'depthTest' },
  { index: 5, name: 'distance fog', stage: 'scene-fragment', toggle: 'fog' },
  { index: 6, name: '240p output', stage: 'post', toggle: 'twoforty' },
];
