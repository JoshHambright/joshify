/**
 * Effect family C — analog / lofi degradation (P5-08).
 *
 * VHS wobble, CRT, ordered dither, posterize, bloom, halftone: the passes that
 * make a clean digital frame look like it came off tape, out of a tube, or off
 * a press. Every one is a `PassDefinition` and nothing here is a code path —
 * the catalogue in `passes.ts` names them, a preset lists them, and the
 * pipeline never learns what any of them is (VISUALIZER.md, "effects are
 * data").
 *
 * ## The rules this family is written to
 *
 * **`uIntensity = 0` is an exact no-op in every pass.** Not "nearly", not
 * "subtle": the fragment written is the fragment read, bit for bit. Where a
 * pass displaces its sample it scales the displacement by `uIntensity` rather
 * than cross-fading the result, because a cross-fade of a displaced image is a
 * ghost, not an absence. This is what makes the user's dial mean something and
 * it is the only reason the legibility floor (P5-16) can bisect on it.
 *
 * **These are the passes most likely to hurt legibility.** The plate and its
 * text sit over whatever this chain produced (D-040), so a pass that halves
 * mean luminance takes a 4.5:1 contrast ratio down to 2.2:1 and the title
 * stops being readable. Every docblock below states what its pass does to
 * contrast, in those terms, because P5-16 has to encode it. Two techniques
 * recur:
 *
 * - *Mean-preserving modulation.* The CRT scanline and phosphor mask multiply
 *   by a factor that averages to exactly `1.0` over the neighbourhood it
 *   repeats across (two rows, three columns) instead of by something `<= 1`.
 *   The naive `0.5 + 0.5 * sin(...)` scanline is a 50% luminance cut wearing a
 *   texture's clothes.
 * - *Tone preservation across a remap.* Posterize rescales its palette lookup
 *   back to the luminance it measured, so a theme whose two stops happen to sit
 *   close together cannot flatten the picture to a single value.
 *
 * **Precision.** `precision mediump float;` throughout — this is a VideoCore
 * VII and `highp` fragment work is a real cost. The one exception is raster
 * coordinates (`vUv * uResolution`), which are declared `highp` locally in
 * `crt`, `dither` and `halftone`: fp16 cannot represent `1280.5` exactly, and a
 * scanline phase or a Bayer cell index that rounds gives a pattern that beats
 * and crawls across the screen. That is three `highp` multiplies per fragment
 * in three passes, not a `highp` shader.
 *
 * **No loops and no `discard`.** There is not a single `for` or `while` in this
 * file — bloom's nine taps are written out. On a tile-based GPU a `discard`
 * forces the whole tile down a slow path, and a data-dependent loop bound
 * serialises the warp against its worst fragment. Where an effect needs a
 * table (the Bayer matrix) it is a fixed 16-entry constant array.
 *
 * **No `grain`.** `GRAIN_PASS` already ships in `passes.ts` and a second pass
 * with the same id would shadow it silently in `findPass`. Notes on what a
 * replacement would have to fix are at the bottom of this file.
 *
 * Homage, not reproduction (D-015): these are period *techniques* — composite
 * chroma bandwidth, aperture grilles, Bayer thresholding, AM halftone screens —
 * and none of them is anyone's trade dress.
 */
import type { PassDefinition } from '../passes.js';

/* ------------------------------------------------------------------ */
/* The Bayer matrix                                                    */
/* ------------------------------------------------------------------ */

/**
 * The standard ordered-dither threshold matrix, built rather than transcribed.
 *
 * `M(1) = [0]`, and each doubling replaces every cell with a 2x2 block:
 *
 * ```
 *   4v+0  4v+2
 *   4v+3  4v+1
 * ```
 *
 * Generating it means the 16 numbers cannot be mistyped, and the test can
 * assert the *properties* that make it a dither matrix — every threshold
 * distinct, covering `0..n²-1` exactly once — rather than checking a copy
 * against another copy.
 *
 * It is built by writing each parent cell out to its four children, never by
 * reading the parent back by index, which keeps it clean under
 * `noUncheckedIndexedAccess` with no unreachable `?? 0` fallback.
 */
export const bayerMatrix = (size: number): readonly number[] => {
  let matrix: readonly number[] = [0];
  let side = 1;
  while (side < size) {
    const wide = side * 2;
    const next = new Array<number>(wide * wide).fill(0);
    matrix.forEach((value, index) => {
      const x = index % side;
      const y = (index - x) / side;
      const base = value * 4;
      next[y * wide + x] = base;
      next[y * wide + x + side] = base + 2;
      next[(y + side) * wide + x] = base + 3;
      next[(y + side) * wide + x + side] = base + 1;
    });
    matrix = next;
    side = wide;
  }
  return matrix;
};

/**
 * 4x4, not 8x8.
 *
 * Sixteen thresholds is enough for the 2-to-32 level quantise this pass
 * offers, it is the size the PS1 used (PS1_MODE.md artefact 03) and the size
 * the Win3.1/VGA idiom this feeds (P5-33) was drawn against, and — the part
 * that actually decides it — a 64-entry array indexed by a computed value is
 * liable to land in scratch memory on V3D, where a 16-entry one stays in
 * registers. At half resolution the extra gradient smoothness of an 8x8 is
 * invisible.
 */
export const BAYER_4X4: readonly number[] = bayerMatrix(4);

/** GLSL has no integer literals in a `float[]` constructor. `0` is `0.0`. */
const glslFloatList = (values: readonly number[]): string =>
  values.map((value) => value.toFixed(1)).join(', ');

/* ------------------------------------------------------------------ */
/* The passes                                                          */
/* ------------------------------------------------------------------ */

/**
 * **VHS tracking wobble** — noise-driven horizontal warp, a crawling tracking
 * band, and composite chroma lag.
 *
 * Three things, all of which are what a helical-scan tape actually does. The
 * warble is two sines beating against each other rather than a hash: one sine
 * reads as a wave, and a hash reads as tearing (which is `glitch`'s job, not
 * this one's). The tracking band is a soft window that crawls up the frame
 * about once every eleven seconds, so a mistrack is an *event* you notice, not
 * a texture you stop seeing. Chroma lag comes from composite video carrying
 * colour at a fraction of luma bandwidth and a few hundred nanoseconds late:
 * red is pulled right, blue left, green left alone to stand in for luma.
 *
 * **Contrast:** neutral. Every effect here is geometric — the pass moves
 * samples horizontally, it never scales a value. Mean luminance over any row is
 * unchanged except where a shift walks off the edge and `CLAMP_TO_EDGE` repeats
 * the border column, which is also what a mistracked tape does. The chroma lag
 * can shift hue by up to `uChroma * 4` texels at a vertical edge; luminance
 * follows green and does not move. Safe under text at any intensity.
 *
 * **Cost:** 3 texture fetches (one per channel), 2 sines, no branches.
 */
export const VHS_PASS: PassDefinition = {
  id: 'vhs',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uTime;
uniform float uEnergy;
uniform float uIntensity;
uniform float uWobble;
uniform float uTracking;
uniform float uChroma;
out vec4 fragColour;

// Two frequencies, deliberately not harmonically related, so the sum never
// repeats within a frame's worth of rows.
float warble(float y, float t) {
  return sin(y * 91.0 + t * 3.1) * 0.6 + sin(y * 313.0 - t * 7.7) * 0.4;
}

void main() {
  // Everything is scaled by uIntensity before it reaches a UV, so at zero all
  // three fetches land on vUv and the pass is a copy.
  float shift = warble(vUv.y, uTime) * uWobble * 0.01;
  float band = fract(vUv.y + uTime * 0.09);
  float window = smoothstep(0.05, 0.0, abs(band - 0.5));
  shift += window * uTracking * 0.06 * (0.5 + uEnergy * 0.5);
  shift *= uIntensity;

  vec2 uv = vec2(vUv.x + shift, vUv.y);
  float lag = uChroma * uIntensity * 4.0 * uTexel.x;
  fragColour = vec4(
    texture(uTexture, uv + vec2(lag, 0.0)).r,
    texture(uTexture, uv).g,
    texture(uTexture, uv - vec2(lag * 0.5, 0.0)).b,
    1.0);
}
`,
  params: {
    wobble: { default: 0.5, min: 0, max: 2 },
    tracking: { default: 0.6, min: 0, max: 2 },
    chroma: { default: 0.5, min: 0, max: 3 },
  },
};

/**
 * **CRT** — barrel curvature, scanlines, an aperture-grille phosphor mask and
 * a vignette.
 *
 * The interesting part is what it refuses to do. The scanline everyone writes
 * is `colour *= 0.5 + 0.5 * sin(y)`, which is a **50% cut in mean luminance**
 * dressed up as a texture; behind a plate that turns 4.5:1 into roughly 2.2:1
 * and the track title stops passing. Here both the scanline and the mask are
 * modulations *about 1.0*:
 *
 * - The scanline is `1.0 + sin(pi * y_texels) * k`. At texel centres that sine
 *   is exactly `+1, -1, +1, ...`, so any two adjacent rows average to exactly
 *   `1.0`. Locking the period to two texels rather than to a fixed line count
 *   also means it cannot alias or beat against the render scale.
 * - The mask is `1.0 + (triad * 3.0 - 1.0) * k`, where `triad` is one of the
 *   three unit basis vectors by column. `triad * 3.0` averages to `(1,1,1)`
 *   across any three adjacent columns, so the `-1.0` and the `+1.0` cancel and
 *   the triad average is exactly `1.0` per channel.
 *
 * **Contrast:** locally neutral, radially negative. Scanline and mask leave the
 * mean luminance of any 2x3 texel neighbourhood exactly unchanged and only
 * raise its variance — a plate compositing over it sees the same average it
 * would have seen. The vignette and the bezel fade *are* real luminance cuts,
 * up to `0.35 * uVignette * uIntensity` at the extreme corner and falling as
 * `r²`; at the centre third of the screen, where the plate lives, that is under
 * 4%. `uMask` is capped at `0.8` so peak gain stays under `2.6x` and highlights
 * do not clip to a colour.
 *
 * Deliberately not reactive. This is a model of a display, and a display does
 * not pulse with the music; anything that should pulse belongs in the pass
 * before it.
 *
 * **Cost:** 1 texture fetch. Curvature is UV arithmetic, not a resample.
 */
export const CRT_PASS: PassDefinition = {
  id: 'crt',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uIntensity;
uniform float uCurve;
uniform float uScan;
uniform float uMask;
uniform float uVignette;
out vec4 fragColour;

void main() {
  vec2 centred = vUv * 2.0 - 1.0;
  // r^2 only. A full lens polynomial is invisible at this strength and costs
  // another multiply-add per axis for a curve nobody can see.
  float r2 = dot(centred, centred);
  vec2 uv = centred * (1.0 + r2 * uCurve * 0.25 * uIntensity) * 0.5 + 0.5;
  vec3 here = texture(uTexture, uv).rgb;

  // highp for the raster coordinate only: fp16 cannot hold 1280.5, and a
  // scanline phase that rounds is a pattern that crawls.
  highp vec2 raster = uv * uResolution;

  // Period exactly two texels, so at texel centres this is +1, -1, +1, ...
  // and any two adjacent rows average to a gain of exactly 1.0.
  float scan = 1.0 + sin(raster.y * 3.14159265) * uScan * 0.5 * uIntensity;

  // Aperture grille. triad * 3.0 averages to (1,1,1) over three columns, so
  // the mask is mean-preserving per channel for any strength.
  float column = floor(mod(raster.x, 3.0));
  vec3 triad = vec3(
    step(column, 0.5),
    step(0.5, column) * step(column, 1.5),
    step(1.5, column));
  vec3 mask = 1.0 + (triad * 3.0 - 1.0) * uMask * uIntensity;

  // Curvature pushes the corners off the source texture. Fade there instead of
  // discarding: a discard drags the whole tile down a slow path on a TBDR.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.004), uv)
            * smoothstep(vec2(0.0), vec2(0.004), 1.0 - uv);
  float bezel = mix(1.0, edge.x * edge.y, uIntensity);
  float vignette = mix(1.0, 1.0 - r2 * 0.35, uVignette * uIntensity);

  fragColour = vec4(here * scan * mask * vignette * bezel, 1.0);
}
`,
  params: {
    curve: { default: 0.35, min: 0, max: 1 },
    scan: { default: 0.5, min: 0, max: 1 },
    mask: { default: 0.25, min: 0, max: 0.8 },
    vignette: { default: 0.4, min: 0, max: 1 },
  },
};

/**
 * **Bayer dither** — ordered dithering to a reduced number of levels per
 * channel.
 *
 * Ordered, never random. Random dither redraws its noise field every frame, so
 * a still image crawls and the eye reads it as interference rather than as
 * texture; an ordered matrix is a function of position alone, so a still image
 * is still. It is also the actual period technique — the thing the PS1 did to
 * hide 15-bit banding (PS1_MODE.md artefact 03) and the thing a 16-colour VGA
 * driver did to fake a gradient. P5-33's `VGA` theme is this pass at a low
 * `levels` and nothing else.
 *
 * **Contrast:** neutral by construction, which is the entire point of
 * dithering. Adding a zero-mean threshold before rounding makes the
 * quantisation error zero-mean too, so the mean luminance over any 4x4 block is
 * the input's mean to within one part in `4 * (levels - 1)`. Per *pixel* the
 * worst-case luminance shift is half a step, `1 / (2 * (levels - 1))` — 10% at
 * the default 6 levels, 50% at the minimum of 2. P5-16 should test `levels = 2`
 * with `amount = 1`; that is this pass's worst case and it is a genuinely hard
 * one, because a two-level dither of a mid-grey backdrop is a checkerboard of
 * black and white under the text.
 *
 * **Cost:** 1 texture fetch, one 16-entry constant-array lookup, no branches.
 */
export const DITHER_PASS: PassDefinition = {
  id: 'dither',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uIntensity;
uniform float uLevels;
uniform float uAmount;
out vec4 fragColour;

// Generated from bayerMatrix(4) so the numbers cannot be mistyped, and asserted
// against the shader source in the tests.
const float kBayer[16] = float[16](${glslFloatList(BAYER_4X4)});

void main() {
  vec3 here = texture(uTexture, vUv).rgb;

  // highp for the cell index: at 1280 rows a mediump raster coordinate rounds,
  // and a Bayer index that rounds is a dither pattern with seams in it.
  highp vec2 raster = vUv * uResolution;
  int cell = int(mod(raster.y, 4.0)) * 4 + int(mod(raster.x, 4.0));

  // Thresholds land in [-0.5, 0.5) with zero mean, so the rounding error the
  // dither introduces is zero-mean and the block average is preserved.
  float threshold = (kBayer[cell] + 0.5) * 0.0625 - 0.5;
  float steps = max(uLevels - 1.0, 1.0);
  vec3 quantised = clamp(floor(here * steps + 0.5 + threshold) / steps, 0.0, 1.0);

  fragColour = vec4(mix(here, quantised, uAmount * uIntensity), 1.0);
}
`,
  params: {
    levels: { default: 6, min: 2, max: 32 },
    amount: { default: 1, min: 0, max: 1 },
  },
};

/**
 * **Posterize** — colour quantisation, then a remap through the theme palette.
 *
 * Two halves. The first is a plain per-channel quantise to `levels` steps. The
 * second remaps the quantised tone along a ramp from `uForeground` to
 * `uAccent`, both of which came out of the album art (D-012) — so the picture
 * is recoloured with the cover's own palette rather than an arbitrary one, and
 * a track change re-tints it for free.
 *
 * The remap then **rescales its result back to the luminance it measured.**
 * Without that, a cover whose extracted foreground and accent happen to sit at
 * similar luminance — a monochrome sleeve, which is not rare — collapses the
 * whole image to one flat value, and the plate sitting on it has nothing to
 * contrast against. With it, the ramp changes hue and leaves tone alone.
 *
 * **Contrast:** preserved in ordering, compressed by at most half a step. The
 * quantise is monotone in luminance, so nothing that was lighter becomes
 * darker; the worst per-pixel shift is `1 / (2 * (levels - 1))`, 12.5% at the
 * default 5 levels. The palette remap is tone-preserving to within the clamp
 * that a fully saturated accent forces, so it costs contrast only where the
 * rescale would have pushed a channel above 1.0. Unlike dither, this pass
 * produces flat bands rather than a texture, so it is the *safer* of the two
 * under text at equal levels.
 *
 * **Cost:** 1 texture fetch, no branches, no table.
 */
export const POSTERIZE_PASS: PassDefinition = {
  id: 'posterize',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform float uIntensity;
uniform float uLevels;
uniform float uTint;
out vec4 fragColour;

const vec3 kLuma = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  float steps = max(uLevels - 1.0, 1.0);
  vec3 banded = floor(here * steps + 0.5) / steps;

  float tone = dot(banded, kLuma);
  vec3 ramp = mix(uForeground, uAccent, tone);
  // Put back the luminance we measured. A theme whose two stops sit close
  // together would otherwise flatten the picture to a single value and take
  // the plate's contrast ratio with it.
  ramp *= tone / max(dot(ramp, kLuma), 0.001);

  vec3 tinted = mix(banded, clamp(ramp, 0.0, 1.0), uTint);
  fragColour = vec4(mix(here, tinted, uIntensity), 1.0);
}
`,
  params: {
    levels: { default: 5, min: 2, max: 24 },
    tint: { default: 0.6, min: 0, max: 1 },
  },
};

/**
 * **Bloom** — soft light bleed on highlights, in one pass.
 *
 * The expensive one, so here is the deal that was struck. A real bloom is a
 * threshold, a downsample chain, a separable Gaussian on the way back up, and a
 * composite — three or four extra passes and a pyramid of render targets. The
 * chain has a six-pass budget and exactly three full-size targets (D-061), with
 * no half-size scratch to build a pyramid in, so that shape was never
 * available.
 *
 * What is here instead is a **two-ring Kawase-style gather in a single pass**:
 * eight diagonal taps at 1.5 and 3.5 texels, plus the centre. Every offset is a
 * half-texel diagonal, so each bilinear fetch is the exact average of four
 * texels — nine fetches read 33 texels across a 9x9 neighbourhood. Radius
 * breathes with `uBeat`.
 *
 * **What that trades away, stated plainly:**
 * - *Reach.* Support tops out around 4-5 texels. There is no soft 40px halo
 *   here; at half resolution it reads as a glow, not as a haze.
 * - *Kernel shape.* Two weighted rings approximate a Gaussian and will show
 *   faint rectilinear structure on a single very bright point against black.
 * - *Threshold ordering.* Highlights are extracted *after* the bilinear fetch,
 *   not before, so a lone bright texel averaged with three dark neighbours can
 *   fall under the knee and not bloom at all. Correcting it means 33 point
 *   fetches instead of 9, which is the whole frame budget.
 * - *Energy.* Purely additive, not energy-conserving. Bloom here brightens; it
 *   never takes light out of the source to pay for the halo.
 *
 * **Contrast:** monotonically positive, and that asymmetry is the useful thing
 * to hand P5-16. This pass can only *add* luminance, never remove it, so
 * light-on-dark text can never lose contrast to it — the backdrop under the
 * text can only get closer to the text if the text is the dark one. The lift is
 * bounded by `uAmount * uIntensity` times the mean excess above `uThreshold` in
 * the neighbourhood, and mid and low tones contribute exactly zero because
 * `max(tone - uThreshold, 0.0)` is exactly zero there. The case to test is a
 * bright cover behind dark text at `amount = 2`.
 *
 * **Cost:** 9 texture fetches — by far the most expensive pass in this family
 * and the reason no chain should carry two of them. Budget it as roughly three
 * ordinary passes.
 */
export const BLOOM_PASS: PassDefinition = {
  id: 'bloom',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uIntensity;
uniform float uThreshold;
uniform float uRadius;
uniform float uAmount;
out vec4 fragColour;

const vec3 kLuma = vec3(0.2126, 0.7152, 0.0722);

// Hue-preserving highlight extraction: the colour is kept, its magnitude
// becomes however far its luminance sits above the knee. Below the knee this
// is exactly zero, so mid-tones cost nothing and bleed nothing.
vec3 highlight(vec2 uv, float knee) {
  vec3 c = texture(uTexture, uv).rgb;
  float tone = dot(c, kLuma);
  return c * (max(tone - knee, 0.0) / max(tone, 0.001));
}

void main() {
  vec3 here = texture(uTexture, vUv).rgb;

  // Half-texel diagonals: each bilinear fetch is the exact average of the four
  // texels it straddles, so 8 fetches cover 32 texels.
  float spread = uRadius * (1.0 + uBeat * 0.35);
  vec2 near = uTexel * spread * 1.5;
  vec2 far = uTexel * spread * 3.5;

  vec3 inner = highlight(vUv + vec2(near.x, near.y), uThreshold)
             + highlight(vUv + vec2(-near.x, near.y), uThreshold)
             + highlight(vUv + vec2(near.x, -near.y), uThreshold)
             + highlight(vUv + vec2(-near.x, -near.y), uThreshold);
  vec3 outer = highlight(vUv + vec2(far.x, far.y), uThreshold)
             + highlight(vUv + vec2(-far.x, far.y), uThreshold)
             + highlight(vUv + vec2(far.x, -far.y), uThreshold)
             + highlight(vUv + vec2(-far.x, -far.y), uThreshold);

  // 0.6 / 0.4 in favour of the near ring, then / 4 for the taps per ring.
  vec3 glow = (inner * 0.6 + outer * 0.4) * 0.25;
  fragColour = vec4(here + glow * uAmount * uIntensity, 1.0);
}
`,
  params: {
    threshold: { default: 0.6, min: 0, max: 1 },
    radius: { default: 1, min: 0, max: 4 },
    amount: { default: 0.7, min: 0, max: 2 },
  },
};

/**
 * **Halftone** — an AM dot screen, newsprint style.
 *
 * A rotated grid of cells; each cell is sampled once at its centre and grows a
 * dot whose *area* is the ink fraction `1 - tone`. Sampling the centre rather
 * than the fragment is what makes it a halftone rather than a texture: one cell
 * is one tone, flat, the way a screen actually prints. It also gives perfect
 * cache locality — every fragment in a cell fetches the same texel.
 *
 * The dot is not black ink on white paper, which would throw the cover's colour
 * away. It is a **mean-preserving modulation of the cell's own colour**: ink
 * gain `1 - k(1 - a)`, paper gain `1 + k a`, for ink area `a`. Area-weighting
 * those gives `a(1 - k(1 - a)) + (1 - a)(1 + k a) = 1` for every `a` and every
 * `k`, so the cell's average is the colour that was sampled, exactly, at any
 * strength. `k` is `uIntensity`, which is also what makes the pass vanish at
 * zero — together with the final `mix` back to the undisplaced fetch, so that
 * the cell quantisation vanishes too.
 *
 * **Contrast:** preserved per cell, destroyed within one. This is the most
 * dangerous pass in the family for legibility and it should be treated that
 * way. Averaged over a cell the luminance is exactly the input's, by the
 * identity above — but *inside* a cell it swings the full range, and the
 * cell-centre sampling throws away all detail finer than `uScale` texels. Any
 * text or edge smaller than a cell dissolves. `uScale` is capped at 24 texels
 * for that reason, and P5-16 should test this pass at `scale = 24` before it
 * tests anything else.
 *
 * **Cost:** 2 texture fetches (cell centre, plus the undisplaced fetch that
 * buys the exact no-op) and 2 transcendentals for the screen rotation. The
 * sine and cosine are of a uniform and identical for every fragment; GLSL has
 * nowhere to hoist them to, and two ALU ops is cheaper than the extra uniform
 * plumbing that would.
 */
export const HALFTONE_PASS: PassDefinition = {
  id: 'halftone',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uIntensity;
uniform float uScale;
uniform float uAngle;
uniform float uSoftness;
out vec4 fragColour;

const vec3 kLuma = vec3(0.2126, 0.7152, 0.0722);

void main() {
  // highp for the raster grid: a cell index that rounds at the bottom of a
  // 1280-row panel is a screen that visibly changes pitch down the frame.
  highp vec2 raster = vUv * uResolution;
  float c = cos(uAngle);
  float s = sin(uAngle);
  mat2 screenRot = mat2(c, -s, s, c);

  float pitch = max(uScale, 2.0);
  highp vec2 screen = (screenRot * raster) / pitch;
  highp vec2 centre = floor(screen) + 0.5;

  // vec * mat is mat-transpose * vec, and the rotation is orthonormal, so this
  // is the inverse rotation without building a second matrix.
  vec2 cellUv = vec2((centre * pitch) * screenRot) / uResolution;
  vec3 tint = texture(uTexture, clamp(cellUv, vec2(0.0), vec2(1.0))).rgb;
  float tone = dot(tint, kLuma);

  // Ink area = 1 - tone, so radius = sqrt(area / pi). At tone = 0 that is
  // 0.564 cells, past the 0.5 where neighbours touch — which is exactly how a
  // real screen reaches solid black.
  float area = clamp(1.0 - tone, 0.0, 1.0);
  float radius = sqrt(area * 0.3183);
  float edge = max(uSoftness, 0.01) * 0.5;
  float ink = 1.0 - smoothstep(radius - edge, radius + edge, length(screen - centre));

  // Area-weighted mean of these two gains is exactly 1.0 for any area and any
  // strength, so a cell never changes the average luminance it was given.
  float gain = mix(1.0 + uIntensity * area, 1.0 - uIntensity * (1.0 - area), ink);

  vec3 here = texture(uTexture, vUv).rgb;
  fragColour = vec4(mix(here, tint * gain, uIntensity), 1.0);
}
`,
  params: {
    scale: { default: 6, min: 2, max: 24 },
    angle: { default: 0.785, min: 0, max: 3.15 },
    softness: { default: 0.15, min: 0.02, max: 0.6 },
  },
};

/**
 * The family, in the order a chain usually wants them.
 *
 * `passes.ts` owns the catalogue and registers this; nothing here reaches into
 * it, so the two files can be edited independently.
 *
 * None of these is an overlay (D-062). Every one filters what the stage before
 * it drew, which is precisely what an overlay may not do, and all of them are
 * happier at half resolution anyway — that soft chunky upscale *is* the look
 * (VISUALIZER.md, "the performance trick that is also the aesthetic").
 */
export const LOFI_PASSES: readonly PassDefinition[] = [
  VHS_PASS,
  CRT_PASS,
  DITHER_PASS,
  POSTERIZE_PASS,
  BLOOM_PASS,
  HALFTONE_PASS,
];

/**
 * Why there is no `grain` here, and what would have to be true to add one.
 *
 * `GRAIN_PASS` in `passes.ts` already claims the id, and a duplicate would be
 * shadowed silently by `findPass` — a slider that moves and does nothing, which
 * is the exact failure mode the catalogue is meant to prevent. It is worth
 * writing down what a replacement would have to fix, because three of these are
 * real:
 *
 * 1. **It ignores `uIntensity`.** The user's dial does not reach it, so grain
 *    at intensity zero is grain at full strength — and the legibility floor
 *    cannot turn it down.
 * 2. **`fract(uTime)` repeats every second.** The noise field is identical at
 *    `t` and `t + 1`, giving a 1Hz stutter in something meant to be structureless.
 * 3. **The grain is flat across the tonal range.** Film grain is a property of
 *    the emulsion: strongest in the mid-tones, vanishing in the toe and the
 *    shoulder. Flat additive noise instead clips in the blacks, which biases the
 *    mean *down* — the one thing a pass under text must not do.
 *
 * Fixing those is a change to an existing pass rather than a new one, so it
 * belongs to whoever owns `passes.ts`, not to this file.
 */
