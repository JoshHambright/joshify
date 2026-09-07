/**
 * The fractal scene — a Julia orbit that draws itself **in the album cover**.
 *
 * Not on the tracker: it comes from the theme backlog line in THEMES.md
 * ("orbit-trap fractal — the strongest of the new ones"), and it is here
 * because it is the most literal statement this library can make of the thesis
 * family E was written around — **the artwork is the source material, not a
 * backdrop** (`effects/art.ts`). A plain escape-time fractal coloured by
 * iteration count is a 1993 screensaver: it would look identical over a flat
 * colour, which is the exact test family E says a pass has to pass. This one
 * fails that test as hard as it is possible to fail it — with no cover bound
 * to `uArt` there is no picture at all, only a two-tone accent wash.
 *
 * ## The trap
 *
 * Iterate `z -> z^2 + c` from the pixel's own point on the complex plane.
 * Remember the single orbit point that came **closest to the origin**, and its
 * distance. Then:
 *
 *  - the *position* of that closest approach, scaled by the trap radius,
 *    is the UV the album cover is sampled at;
 *  - the *distance* of it is how strongly that sample is shown.
 *
 * So the trap is a **textured disc of radius `trap` centred on the origin**,
 * and every pixel is painted with whichever texel of the cover its orbit flew
 * nearest to. The disc is sampled once per fragment and never drawn, but it
 * appears everywhere the dynamics send an orbit through it — which, for a
 * Julia set, is everywhere at every scale. The cover comes out warped,
 * mirrored, wrapped around the filaments and repeated down into them, because
 * that is what the map does to the neighbourhood of the origin. Points whose
 * orbit leaves immediately never reach the disc and fall to the background.
 *
 * At the defaults, between a third and a half of the screen carries a cover
 * sample at meaningful weight — measured, in `fractal.test.ts`, over the
 * parameter walk rather than guessed.
 *
 * ## The parameter walk, and why it is the motion
 *
 * Julia sets have a free parameter `c`, and walking it morphs the set
 * continuously. That is much cheaper and much more interesting than zooming:
 * **a deep zoom is not available on this hardware.** Zooming multiplies the
 * screen span by a small number every frame, and the orbit needs to resolve
 * differences between neighbouring pixels; fp32 runs out of mantissa at a
 * span of about 1e-6, which is around twenty seconds of a gentle zoom. After
 * that the picture quantises into blocks. There is no fp64 on a VideoCore VII,
 * and no double-float emulation that fits in this budget. So the window is a
 * fixed parameter and the *shape* is what moves.
 *
 * The walk is the **boundary of the main cardioid, walked just inside it**:
 *
 *     c(theta, r) = r.e^(i.theta)/2 - r^2.e^(2i.theta)/4
 *
 * with `r = 1 - inset`. That is the standard interior parameterisation, and
 * choosing it rather than any hand-drawn loop buys a guarantee: for every `c`
 * strictly inside the main cardioid the map has an attracting fixed point, so
 * **the Julia set is a connected quasicircle at every point of the walk.** It
 * can never fall to dust, at any theta, for any inset in range — which is the
 * failure a hand-picked path finds the moment somebody nudges a number. The
 * test asserts membership over the whole revolution rather than at a few
 * spot values.
 *
 * Just inside the boundary (`inset` defaults to 0.012) is where the sets are
 * most filamentary; as theta passes each rational internal angle the set grows
 * the corresponding pinch points, so one revolution of the walk is a tour of
 * every bulb tangency. It takes about 140 seconds at the default rate.
 *
 * `uBeat` moves **rotation and trap radius**, never brightness. D-071 caps
 * beat-driven luminance globally, so an effect that reaches for brightness is
 * reaching for the one channel already spoken for; a spin kick and a swelling
 * trap are geometry, and they read on the beat without adding a flash. `uPhase`
 * nudges the walk itself, as `sin(2.pi.phase)` rather than as the raw sawtooth
 * — the sawtooth's wrap would snap the set back at every beat.
 *
 * ## The iteration budget
 *
 * The loop bound is a literal **48**, and the escape test is a `break`.
 *
 * 48 is not a round number picked for looks; it is where the picture stops
 * changing. Over a 200x200 grid of the default window, the trap distance at 48
 * iterations differs from the same field at 192 iterations on **0.15%** of the
 * screen, while at 12 iterations it differs on 10%. Those two numbers are
 * asserted in the test, so the bound cannot be lowered "to save a bit" without
 * the suite reporting exactly how much picture that costs.
 *
 * `steps` then lets a preset stop earlier than 48. It is worth having as a
 * uniform rather than as a second shader because the branch is **uniform
 * across the whole draw**: every lane leaves the loop at the same iteration,
 * so on a SIMD tiler the saving is the full proportional one. At the default
 * of 32 the trap field differs from 48 on 1% of the screen for a third less
 * work, which is a trade a Pi is entitled to make.
 *
 * **What the escape `break` is actually worth** is a different question, and
 * the honest answer is less than it looks. V3D runs a block of fragments in
 * lockstep, so a block exits only when its deepest lane does. About 45% of the
 * screen at the default window never escapes at all, and mean scalar depth is
 * 24.5 of 48 — so 49% is the *ceiling* on the saving and the realised figure
 * is lower by whatever the block granularity costs. Escape is spatially
 * coherent (the exterior is large contiguous regions, not speckle), so it is
 * not nothing.
 *
 * It stays in regardless, because it is also **load-bearing for correctness**.
 * Past |z| = 2 the orbit squares every step: from a bailout of |z|^2 = 4, the
 * magnitude reaches fp32's ceiling of 3.4e38 after seven more iterations, and
 * then `x2 + y2` is `inf` and the trap comparison is a NaN. Without the break
 * the alternative is a clamp in the hot loop, which costs more than the branch.
 *
 * A bailout of |z|^2 = 4 rather than the more usual 16 is exact here, not an
 * approximation: |c| never exceeds 0.74 on the walk (asserted), and for
 * |c| < 2 an orbit past |z| = 2 grows monotonically forever. It can therefore
 * never approach the trap again, so the iterations a larger bailout would buy
 * cannot change a single pixel.
 *
 * ## Precision
 *
 * `precision mediump float;` for the file, as everywhere else in the engine —
 * and then **the orbit is `highp` locally**, which is the one place in this
 * library where that is not a nicety.
 *
 * Two independent reasons. First, resolution: neighbouring pixels are
 * `scale / height` apart, about 0.0047 at the default window on a 640-row
 * half-res target, while `mediump` is fp16 on V3D and its spacing near 1.5 is
 * about 0.001. The starting points of five adjacent pixels would collapse onto
 * three distinct values and the image would quantise into visible blocks.
 * Second, amplification: the map doubles angles, so a relative error grows by
 * roughly 2^n. fp16's 5e-4 is larger than the whole picture within about
 * eleven iterations; fp32's 6e-8 survives the full 48 near enough. And fp16
 * overflows at 65504, which |z|^2 passes two iterations after bailout.
 *
 * Colour stays `mediump`: it is a texture sample and three mixes, and none of
 * it is iterated.
 *
 * **Every uniform is left at the file default** except `uTime`, which is
 * `highp` deliberately. `uTime` is unbounded seconds, and at fp16 its spacing
 * is a full second after about 17 minutes of uptime — on an appliance that
 * runs for days, the walk would stop. Qualifying it is safe *here* and would
 * not be safe in most shaders: a uniform must carry the same precision in both
 * stages of a program or the program fails to **link** (`precision.test.ts`,
 * and it cost a black screen once already), and this scene's vertex shader
 * declares no uniforms at all, so there is nothing for it to disagree with.
 * The test pins that fact rather than trusting it.
 *
 * ## Cost, per fragment
 *
 * This is the most expensive thing in the library by a wide margin, and the
 * point of writing that down is so nobody has to find out on the device.
 *
 * | | |
 * |---|---|
 * | Texture fetches | **1** — `uArt`, at the trap point |
 * | Transcendentals | 5 (three `sin`, two `cos`) + one `sqrt` |
 * | Loop, per iteration | 3 multiplies, 4 adds, 2 compares, 3 selects |
 * | Loop, mean | ~24.5 iterations => ~290 scalar ops |
 * | Loop, worst | 48 iterations => ~560 scalar ops |
 *
 * Call it **300 ops in the typical fragment**. An ordinary post pass in this
 * engine is twenty ops and a few fetches, so the scene is worth fifteen of
 * them — and unlike a pass it cannot be dropped by the degrader (P5-14 never
 * drops the scene).
 *
 * **Is it affordable on a Pi 5?** At the 0.5 render scale that is the default
 * (D-011), 360x640 is 230k fragments, so 60fps is about 14M fragments and
 * ~4 Gop/s of scalar ALU for the scene alone. Against a VideoCore VII in the
 * tens of Gflops that is a believable fraction, and it should hold 60fps with
 * a short chain behind it — one or two cheap passes, not `bloom` and not
 * `edge`. At 1.0 scale it is four times that, 16-17 Gop/s, competing with the
 * chain for the same ALU, and the honest expectation is **that it will not
 * hold 60fps at full resolution** and will need the degrader to walk it back
 * down. Nothing here is measured on hardware; P5-30 is where that happens, and
 * `steps` is the dial to reach for first.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { ParamSpec, SceneDefinition } from '../passes.js';

/* ------------------------------------------------------------------ */
/* The numbers, in TypeScript, where they can be argued with           */
/* ------------------------------------------------------------------ */

/**
 * The literal bound on the iteration loop.
 *
 * GLSL needs a constant here — a data-dependent bound is the one thing a
 * fragment shader on a tiler must not have — so this is the number compiled
 * in, and `steps` may only stop short of it.
 */
export const MAX_ITERATIONS = 48;

/**
 * Bailout, as a squared modulus: |z| > 2.
 *
 * Exact rather than conservative, because `juliaParameter` keeps |c| well
 * under 2 and an orbit past |z| = 2 with |c| < 2 grows without bound forever.
 * Iterating further cannot bring it back to the trap.
 */
export const BAILOUT_SQUARED = 4;

/** How far inside the main cardioid the parameter walk sits, by default. */
export const CARDIOID_INSET = 0.012;

/** Half-height of the window on the complex plane, by default. */
export const PLANE_SCALE = 3;

/** Radius of the textured trap disc, by default. */
export const TRAP_RADIUS = 0.5;

/**
 * Where the loop stops by default, short of the compiled bound.
 *
 * A third less work than 48 for a trap field that differs from it on about 1%
 * of the screen — the test measures both figures rather than asserting the
 * choice was reasonable.
 */
export const DEFAULT_STEPS = 32;

/**
 * A point on the complex plane, as a pair. Deliberately a tuple rather than a
 * `{ re, im }` record: it is what a `vec2` is, and it is what the tests
 * compare.
 */
export type Complex = readonly [number, number];

/**
 * The parameter walk: the main cardioid's interior parameterisation.
 *
 * `inset` of 0 lands exactly on the cardioid boundary (parabolic parameters —
 * beautiful, and numerically the worst case, since the orbit converges only
 * logarithmically and 48 iterations resolve nothing). Anything above 0 is
 * strictly inside, where the Julia set is a connected quasicircle.
 */
export const juliaParameter = (theta: number, inset: number): Complex => {
  const r = 1 - inset;
  return [
    0.5 * r * Math.cos(theta) - 0.25 * r * r * Math.cos(2 * theta),
    0.5 * r * Math.sin(theta) - 0.25 * r * r * Math.sin(2 * theta),
  ];
};

/**
 * The standard membership test for the main cardioid.
 *
 * `q(q + (x - 1/4)) < y^2/4`, where `q = (x - 1/4)^2 + y^2`. Strict, so a
 * point exactly on the boundary reports `false` — which is what makes the
 * inset test meaningful in both directions.
 */
export const insideMainCardioid = (re: number, im: number): boolean => {
  const q = (re - 0.25) * (re - 0.25) + im * im;
  return q * (q + (re - 0.25)) < 0.25 * im * im;
};

/** What one pixel's orbit found. */
export interface OrbitTrapResult {
  /** Distance of the closest approach to the origin. */
  readonly nearest: number;
  /** Where that closest approach happened — the point the cover is read at. */
  readonly trap: Complex;
  /** Iterations run: the escape index, or `steps` for an orbit that stayed. */
  readonly iterations: number;
}

/**
 * The reference implementation of the shader's loop, in TypeScript.
 *
 * It exists so the iteration bound is a *measurement* rather than an opinion:
 * the test sweeps a grid through this and reports how much of the screen
 * changes between one bound and another. It mirrors the GLSL statement for
 * statement — including carrying `x2`/`y2` forward so the squared modulus is
 * free — and any edit to one belongs in the other.
 */
export const orbitTrap = (point: Complex, c: Complex, steps: number): OrbitTrapResult => {
  const [cx, cy] = c;
  let [zx, zy] = point;
  let x2 = zx * zx;
  let y2 = zy * zy;
  // The starting point counts as an approach: without it a pixel sitting on
  // the origin would trap at wherever its first iterate landed instead.
  let nearest = x2 + y2;
  let trapX = zx;
  let trapY = zy;
  let i = 0;
  for (; i < steps; i += 1) {
    const nextY = 2 * zx * zy + cy;
    zx = x2 - y2 + cx;
    zy = nextY;
    x2 = zx * zx;
    y2 = zy * zy;
    const d = x2 + y2;
    if (d < nearest) {
      nearest = d;
      trapX = zx;
      trapY = zy;
    }
    if (d > BAILOUT_SQUARED) break;
  }
  return { nearest: Math.sqrt(nearest), trap: [trapX, trapY], iterations: i };
};

/* ------------------------------------------------------------------ */
/* The shaders                                                         */
/* ------------------------------------------------------------------ */

/** Attribute 0: the clip-space corner of the fullscreen triangle. */
export const ATTRIBUTE_POSITION = 0;

/**
 * The fullscreen triangle, and the pass-through vertex shader over it.
 *
 * Both are character-identical to `FULLSCREEN_TRIANGLE` and `POST_VERTEX` in
 * `passes.ts`, and they are copied rather than imported **on purpose**:
 * `passes.ts` imports every scene in order to assemble the catalogue, so a
 * scene importing a runtime value back out of it closes a cycle. ES modules
 * resolve that cycle by evaluating this file first against a half-built
 * `passes.js`, and the constant would be in its temporal dead zone — a
 * `ReferenceError` at import time, before any test runs. Type-only imports are
 * erased and stay safe, which is why `SceneDefinition` above is fine and
 * `POST_VERTEX` would not be. `scenes/tunnel.ts` avoids the same cycle by
 * building its own geometry.
 */
export const FRACTAL_GEOMETRY: GeometrySpec = {
  attributes: [
    {
      location: ATTRIBUTE_POSITION,
      size: 2,
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    },
  ],
  count: 3,
};

const FRACTAL_VERTEX = `#version 300 es
layout(location = ${String(ATTRIBUTE_POSITION)}) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRACTAL_FRAGMENT = `#version 300 es
precision mediump float;

// highp, matching the vertex stage's default. The plane coordinate is derived
// straight from this and the orbit cannot start at mediump - see the docblock.
in highp vec2 vUv;

// highp on uTime alone. It is unbounded seconds and mediump is fp16 on V3D,
// where the spacing reaches a whole second after about 17 minutes of uptime
// and the walk simply stops. Safe here and nowhere else: a uniform must agree
// on precision across both stages of a program or the link fails, and the
// vertex shader above declares no uniforms at all.
uniform highp float uTime;
uniform sampler2D uArt;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform vec2 uResolution;
uniform float uBeat;
uniform float uPhase;
uniform float uIntensity;
uniform float uScale;
uniform float uSteps;
uniform float uTrap;
uniform float uSwell;
uniform float uSpin;
uniform float uKick;
uniform float uWalk;
uniform float uSwing;
uniform float uInset;

out vec4 fragColour;

const int kMaxSteps = ${String(MAX_ITERATIONS)};
const float kBailout = ${BAILOUT_SQUARED.toFixed(1)};
const float kTau = 6.28318531;

void main() {
  // -- the parameter walk --------------------------------------------------
  //
  // mod() before anything else: uTime is a session-length number and every
  // trig identity below only wants it modulo a turn. sin(uPhase) rather than
  // uPhase itself because uPhase is a sawtooth, and its wrap would snap the
  // whole set back into place on every beat.
  highp float theta =
    mod(uTime * uWalk, kTau) + sin(uPhase * kTau) * uSwing * uIntensity;
  highp float r = 1.0 - clamp(uInset, 0.0, 0.5);
  highp float ct = cos(theta);
  highp float st = sin(theta);
  // Double angle rather than a second sin/cos pair: cos2t = 2ct^2 - 1 and
  // sin2t = 2.st.ct, which is three multiplies against two transcendentals.
  highp vec2 c = vec2(
    0.5 * r * ct - 0.25 * r * r * (2.0 * ct * ct - 1.0),
    0.5 * r * st - 0.25 * r * r * (2.0 * st * ct));

  // -- the window on the plane ---------------------------------------------
  //
  // The panel is portrait, so the aspect goes on x to keep the set circular
  // rather than stretching it to fill. Rotation is of the sampling window, so
  // the picture turns without the set itself being touched.
  highp float aspect = uResolution.x / max(uResolution.y, 1.0);
  highp vec2 p = (vUv - 0.5) * uScale * vec2(aspect, 1.0);
  highp float spin = mod(uTime * uSpin, kTau) + uBeat * uIntensity * uKick;
  highp float cs = cos(spin);
  highp float sn = sin(spin);
  p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);

  // -- the orbit -----------------------------------------------------------
  //
  // x2 and y2 are carried forward so the squared modulus is already computed
  // when the trap test wants it: three multiplies an iteration, not five.
  highp vec2 z = p;
  highp float x2 = z.x * z.x;
  highp float y2 = z.y * z.y;
  highp float nearest = x2 + y2;
  highp vec2 trap = z;
  int limit = int(uSteps);
  int i = 0;
  for (i = 0; i < kMaxSteps; i++) {
    // Uniform across the draw, so every lane leaves together and the saving
    // is the whole proportional one - unlike the escape break below.
    if (i >= limit) break;
    z = vec2(x2 - y2 + c.x, 2.0 * z.x * z.y + c.y);
    x2 = z.x * z.x;
    y2 = z.y * z.y;
    highp float d = x2 + y2;
    if (d < nearest) {
      nearest = d;
      trap = z;
    }
    // Load-bearing, not just an optimisation: past the bailout the magnitude
    // squares every step and reaches fp32's ceiling seven iterations later,
    // after which d is inf and the comparison above is a NaN.
    if (d > kBailout) break;
  }

  // -- the trap, as a picture ----------------------------------------------
  //
  // The beat opens the disc rather than raising the brightness: D-071 caps
  // beat-driven luminance centrally, so the pulse is spent on geometry.
  float radius = uTrap * (1.0 + uBeat * uIntensity * uSwell);
  // Named "closest" rather than "near": near and far are reserved in the HLSL
  // an ANGLE-backed browser cross-compiles to, and while ANGLE renames user
  // identifiers to avoid exactly that, the prototype page has no reason to
  // depend on it.
  float closest = sqrt(nearest);
  float weight = 1.0 - smoothstep(radius * 0.25, radius, closest);

  // The position of the closest approach is the UV. clamp() rather than a
  // wrap mode: the pipeline creates the album texture clamped and a shader
  // that leans on that is a shader that breaks when the sampler changes.
  vec2 trapUv = clamp(trap / (2.0 * radius) + 0.5, 0.0, 1.0);
  vec3 cover = texture(uArt, trapUv).rgb;

  // Everything the trap did not catch: an accent wash that deepens with how
  // long the orbit survived, so the set still has an edge where the cover
  // does not reach.
  float reach = max(float(limit), 1.0);
  float held = float(i) / reach;
  vec3 depths = mix(uAccent * 0.09, uAccent * 0.30 + uForeground * 0.05, held);

  // Brightest exactly at the closest approach, which is what makes the
  // filaments read as lit rather than as a flat stencil of the cover.
  vec3 lit = cover * (0.5 + 0.65 * weight);
  vec3 colour = mix(depths, lit, weight);
  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* The scene                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every parameter, and why its default is where it is.
 *
 * Split out from the scene so the test can walk it without reaching through
 * the definition, and so the four defaults that also exist as TypeScript
 * constants are visibly the same numbers on both sides.
 */
export const FRACTAL_PARAMS: ParamSpec = {
  /**
   * Half-height of the window on the complex plane. 3 frames a
   * cardioid-boundary Julia set with a margin; below ~1.5 the set overflows
   * the panel and the structure stops reading.
   */
  scale: { default: PLANE_SCALE, min: 1, max: 8 },
  /**
   * Where the loop stops, at or under the compiled bound. 32 costs a third
   * less than 48 and differs from it on 1% of the screen; 8 is the floor
   * where the set is still recognisably itself.
   */
  steps: { default: DEFAULT_STEPS, min: 8, max: MAX_ITERATIONS },
  /** Radius of the textured disc. Larger shows more cover, less structure. */
  trap: { default: TRAP_RADIUS, min: 0.05, max: 1.5 },
  /** How far the beat opens the trap, as a fraction of its radius. */
  swell: { default: 0.35, min: 0, max: 1 },
  /** Base rotation of the window, in radians a second. ~126s a turn. */
  spin: { default: 0.05, min: 0, max: 1 },
  /** Radians of rotation a full beat adds on top. */
  kick: { default: 0.25, min: 0, max: 2 },
  /** Internal angle travelled per second. ~140s for the full tour. */
  walk: { default: 0.045, min: 0, max: 0.5 },
  /** Radians the within-beat wobble moves the internal angle. */
  swing: { default: 0.05, min: 0, max: 0.5 },
  /**
   * How far inside the cardioid the walk sits. At 0 it is exactly on the
   * boundary, where the dynamics are parabolic and 48 iterations resolve
   * almost nothing — so the default sits just inside, where the sets are
   * filamentary and the orbit still converges.
   */
  inset: { default: CARDIOID_INSET, min: 0, max: 0.4 },
};

/**
 * The scene.
 *
 * Nothing here would want a depth test even if the engine had one: a single
 * triangle covering the viewport has nothing to sort against itself.
 */
export const FRACTAL_SCENE: SceneDefinition = {
  id: 'fractal',
  vertex: FRACTAL_VERTEX,
  fragment: FRACTAL_FRAGMENT,
  geometry: FRACTAL_GEOMETRY,
  params: FRACTAL_PARAMS,
};
