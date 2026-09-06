/**
 * Effect family B — glitch and datamosh (P5-07).
 *
 * Six post passes: `rgbsplit`, `blockshift`, `smear`, `tear`, `dropout`,
 * `bitcrush`. Each is a `PassDefinition` and nothing more — a preset names one
 * and sets its parameters, and the pipeline never learns any of their names
 * (VISUALIZER.md, "effects are data, not code paths"). `passes.ts` owns the
 * catalogue; this file only supplies the rows.
 *
 * ## What these are filtering
 *
 * The chain's input is the scene, and the scene is nearly always the album
 * cover — flat, or wrapped round the tunnel. So every pass here is written to
 * *deform the cover*, never to draw over it: the block displacement moves the
 * artwork's own pixels, the smear drags the artwork's own highlights, and the
 * dropout punches through to `uArt` — the raw, unfiltered cover — so that the
 * corruption reveals the source rather than replacing it with noise. A glitch
 * that would look the same over a black frame is a screensaver.
 *
 * ## Two rules every pass in here keeps
 *
 * **At `uIntensity == 0` each pass is an exact pass-through.** Not "almost";
 * the same bits out as in. That is what makes the user's dial mean something
 * and it is the only way the legibility floor (P5-16) can hold — a floor that
 * clamps intensity to zero has to actually recover the frame. Multiplicative
 * drives get it for free; the passes that gate on a hash get it from the
 * `on = step(0.0001, uIntensity)` guard, because a `step` against a mediump
 * hash cannot be trusted to stay off on its own (see `hash21`).
 *
 * **Motion is bound to the music, not to the clock.** `uBeat` gates every
 * firing, `uPhase` reseeds the corruption on the beat's subdivisions rather
 * than on a wall clock, and `uBands` decides *where* on the screen it lands.
 * `uTime` appears exactly once in this file, animating the noise inside an
 * event `uBeat` has already triggered.
 *
 * ## Cost, at the resolution the stage renders at
 *
 * | Pass | Texture fetches | Notes |
 * |---|---|---|
 * | `rgbsplit` | 3 | one per channel; green never moves |
 * | `blockshift` | 1 | hash and displace, no second sample |
 * | `smear` | 7 | the expensive one — see below |
 * | `tear` | 1 | |
 * | `dropout` | 3 | `uTexture` + `uPrev` + `uArt`, all unconditional |
 * | `bitcrush` | 1 | pure arithmetic on one sample |
 *
 * Sixteen fetches for the whole family, against a budget of six passes a
 * frame; `smear` is worth most of a preset's allowance on its own and should
 * not be stacked with the other multi-fetch passes on a Pi 5.
 *
 * ## "Pixel sort" is called `smear`, because that is what it is
 *
 * A real pixel sort permutes pixels along a row: it finds runs where luminance
 * crosses a threshold and reorders the pixels *within* each run. A fragment
 * shader cannot do that. It has no scatter, no cross-pixel state, and no way
 * to know a run's extent without walking it, which is the data-dependent loop
 * this hardware most dislikes.
 *
 * So `smear` does the honest neighbour of it: a **thresholded running maximum**
 * along an axis. Each fragment looks backwards a fixed number of taps and
 * takes the brightest sample it finds above the threshold. What that gives is
 * the visible signature of a sort — bright pixels dragged into long streaks
 * over the darker ones behind them, starting where the threshold bites.
 *
 * What it is not: nothing is permuted, so the histogram of a row changes; dark
 * pixels are not ordered among themselves; runs are not detected from the
 * data, so a streak stops after a fixed distance rather than at the end of its
 * run. It is named `smear` so that no preset author expects a sort.
 */
import type { PassDefinition } from '../passes.js';

/**
 * `highp` inside the hash and nowhere else, which is the whole reason it is a
 * function: a mediump `sin(n) * 43758.5453` on a VideoCore VII throws away the
 * low bits that *are* the noise, and the result is a visibly repeating lattice
 * rather than a hash. Everything downstream of it is colour and fits in
 * mediump.
 *
 * Note what this means for callers: the returned value is mediump, so it can
 * round up to exactly 1.0. Never rely on `step(1.0, hash21(...))` being zero —
 * gate with the `on` guard instead.
 */
const HASH = `float hash21(highp vec2 p) {
  highp float n = dot(p, vec2(127.1, 311.7));
  return fract(sin(n) * 43758.5453123);
}`;

/**
 * Three constant taps blended by position, rather than `uBands[int(t * 16.0)]`.
 * A dynamic index into a uniform array turns the array into an indexable
 * temporary on V3D, and this reads as a spectrum running across the screen
 * just as well for two `mix`es and a `step`.
 */
const SPECTRUM = `float spectrum(float t) {
  float low = mix(uBands[1], uBands[8], clamp(t * 2.0, 0.0, 1.0));
  float high = mix(uBands[8], uBands[14], clamp(t * 2.0 - 1.0, 0.0, 1.0));
  return mix(low, high, step(0.5, t));
}`;

const LUMA = `float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}`;

/**
 * Chromatic aberration: red and blue pulled apart, green left where it was.
 *
 * Green carries most of the luminance, so leaving it in place keeps the
 * cover's structure legible while the fringes move — which is the difference
 * between an aberration and a smudge, and it is what lets this run under text.
 *
 * `amount` is in UV rather than texels on purpose: an aberration is a property
 * of the lens, so it should cover the same fraction of the picture whatever
 * the grain slider is doing to the render scale.
 *
 * 3 fetches.
 */
export const RGBSPLIT_PASS: PassDefinition = {
  id: 'rgbsplit',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uBeat;
uniform float uIntensity;
uniform float uBands[16];
uniform float uAmount;
uniform float uRadial;
out vec4 fragColour;
void main() {
  // Bass, not overall energy: the split should pump with the kick, and a
  // loud sustained pad should not hold it open.
  float drive = uIntensity * (0.3 + 0.7 * uBeat) * (0.45 + 0.55 * uBands[1]);
  // uRadial 0 is a flat sideways split (the broken-cable look), 1 is radial
  // from the centre (the cheap-lens look). Anything between is both.
  vec2 shift = mix(vec2(1.0, 0.0), (vUv - 0.5) * 2.0, uRadial) * uAmount * drive;
  // At uIntensity 0 shift is exactly zero and all three fetches land on the
  // same texel, so this is a pass-through with no special case for it.
  float r = texture(uTexture, vUv + shift).r;
  vec3 mid = texture(uTexture, vUv).rgb;
  float b = texture(uTexture, vUv - shift).b;
  fragColour = vec4(r, mid.g, b, 1.0);
}
`,
  params: {
    amount: { default: 0.008, min: 0, max: 0.05 },
    radial: { default: 0.4, min: 0, max: 1 },
  },
};

/**
 * Block displacement — the corrupted-JPEG datamosh.
 *
 * The screen is cut into blocks of `block` pixels; a hash decides which of
 * them jump and how far, and some of the ones that jump also roll their colour
 * channels, which is what a half-decoded frame does and costs nothing because
 * the sample has already been taken.
 *
 * The seed steps four times a beat off `uPhase`, so the corruption changes on
 * the music's subdivisions instead of on a timer, and the row's own band
 * decides how likely that row is to break up — the picture comes apart where
 * the spectrum is loud.
 *
 * Blocks are sized in pixels of *this stage*, so they stay the same size on
 * screen when the degrader moves the render scale under them.
 *
 * 1 fetch.
 */
export const BLOCKSHIFT_PASS: PassDefinition = {
  id: 'blockshift',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uPhase;
uniform float uIntensity;
uniform float uBands[16];
uniform float uBlock;
uniform float uAmount;
uniform float uShift;
uniform float uCorrupt;
out vec4 fragColour;
${HASH}
${SPECTRUM}
void main() {
  // The exact-zero guard. hash21 comes back mediump and can round to 1.0, so
  // a step against it is not reliably off; this is.
  float on = step(0.0001, uIntensity);
  vec2 size = max(uBlock, 1.0) * uTexel;
  vec2 cell = floor(vUv / size);
  float seed = floor(uPhase * 4.0) * 37.0;
  float pick = hash21(cell + seed);
  float gate = clamp(uAmount * (0.25 + 0.75 * uBeat) *
    (0.4 + 0.6 * spectrum(vUv.y)), 0.0, 1.0);
  float fire = step(1.0 - gate, pick) * on;
  // Mostly sideways: a vertical jump of the same size reads as the whole
  // picture tearing, which is what tear is for.
  vec2 jump = vec2(hash21(cell + 11.3) - 0.5,
    (hash21(cell + 47.9) - 0.5) * 0.35) * uShift * fire;
  // fract, not the sampler's wrap mode: the chain's targets clamp, and a
  // clamped jump smears the edge row across the whole block instead of
  // wrapping. With fire at zero this is fract(vUv), and fragment centres
  // never land on exactly 1.0, so it is the identity.
  vec3 here = texture(uTexture, fract(vUv + jump)).rgb;
  float roll = fire * step(0.5, hash21(cell + 91.7)) * uCorrupt;
  fragColour = vec4(mix(here, here.gbr, roll), 1.0);
}
`,
  params: {
    block: { default: 16, min: 2, max: 128 },
    amount: { default: 0.35, min: 0, max: 1 },
    shift: { default: 0.12, min: 0, max: 0.5 },
    corrupt: { default: 0.4, min: 0, max: 1 },
  },
};

/**
 * The pixel-sort look, honestly: a thresholded running maximum along an axis.
 * See the file docblock for what this does and does not do — it streaks, it
 * does not sort.
 *
 * `axis` blends the direction from along-rows to down-columns, and the
 * in-between values are a legitimate diagonal rather than a mistake.
 *
 * 7 fetches: the source plus six taps. The taps are at doubling strides, so
 * they reach thirty-two times their own spacing — a linear walk would need
 * thirty-two fetches for the same streak length. The loop bound is a literal,
 * so it unrolls and there is nothing data-dependent for the tiler to stall on.
 */
export const SMEAR_PASS: PassDefinition = {
  id: 'smear',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uIntensity;
uniform float uBands[16];
uniform float uLength;
uniform float uThreshold;
uniform float uAxis;
out vec4 fragColour;
${LUMA}
${SPECTRUM}
void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  float drive = uIntensity * (0.35 + 0.65 * uBeat) * (0.45 + 0.55 * spectrum(vUv.y));
  // Texels of this stage, so the streak keeps its on-screen length when the
  // degrader changes the render scale.
  vec2 axisTexel = mix(vec2(uTexel.x, 0.0), vec2(0.0, uTexel.y), uAxis);
  vec2 reach = -axisTexel * uLength * drive * (1.0 / 32.0);
  vec3 best = here;
  float bestL = luma(here);
  for (int i = 0; i < 6; ++i) {
    // At drive 0 every tap lands on vUv, so best stays exactly here.
    vec3 s = texture(uTexture, vUv + reach * exp2(float(i))).rgb;
    float l = luma(s);
    // Arithmetic select rather than an if: both sides are already computed,
    // and a branch here would only cost divergence.
    float take = step(uThreshold, l) * step(bestL, l);
    best = mix(best, s, take);
    bestL = mix(bestL, l, take);
  }
  fragColour = vec4(best, 1.0);
}
`,
  params: {
    length: { default: 28, min: 0, max: 128 },
    threshold: { default: 0.5, min: 0, max: 1 },
    axis: { default: 0, min: 0, max: 1 },
  },
};

/**
 * Scanline tear — a broken signal rather than a corrupted file.
 *
 * Two things at once, which is what makes it read as a picture rather than as
 * an effect: strips of `height` pixels slide sideways, and the whole frame
 * slips vertically and wraps. The vertical slip is scaled by `uBeat` alone, so
 * it snaps on the transient and settles as the beat decays — a vertical hold
 * losing its grip once per bar and catching itself.
 *
 * 1 fetch.
 */
export const TEAR_PASS: PassDefinition = {
  id: 'tear',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uPhase;
uniform float uIntensity;
uniform float uHeight;
uniform float uAmount;
uniform float uShift;
uniform float uRoll;
out vec4 fragColour;
${HASH}
void main() {
  float on = step(0.0001, uIntensity);
  float roll = uRoll * uBeat * uIntensity;
  float y = fract(vUv.y + roll);
  // Strips are measured in this stage's pixels; the max keeps a zero height
  // from dividing the strip index to infinity.
  float strip = floor(y / max(uHeight * uTexel.y, uTexel.y));
  // Three reseeds a beat, off the beat grid rather than off the clock.
  float seed = floor(uPhase * 3.0) * 13.0;
  float pick = hash21(vec2(strip, seed));
  float gate = clamp(uAmount * (0.2 + 0.8 * uBeat), 0.0, 1.0);
  float fire = step(1.0 - gate, pick) * on;
  float offset = (hash21(vec2(strip, seed + 5.0)) - 0.5) * 2.0 * uShift * fire;
  // Both wraps are exact identities at zero: roll is 0 so y is vUv.y, and
  // offset is 0 so the x wrap is fract(vUv.x).
  fragColour = vec4(texture(uTexture, vec2(fract(vUv.x + offset), y)).rgb, 1.0);
}
`,
  params: {
    height: { default: 6, min: 1, max: 64 },
    amount: { default: 0.3, min: 0, max: 1 },
    shift: { default: 0.15, min: 0, max: 0.5 },
    roll: { default: 0.05, min: 0, max: 0.5 },
  },
};

/**
 * Dropout — blocks of the frame lose the chain and fall back to something
 * older or rawer.
 *
 * The fallback is deliberately not noise-first. A dropped block shows either
 * last frame (`uPrev`, so the block freezes while the rest moves) or the album
 * cover straight off the texture (`uArt`, so the corruption *reveals the
 * source* — after a feedback or tunnel pass that is the cover surfacing
 * through its own wreckage). `noise` mixes in a hash speckle tinted with
 * `uAccent`, so even the dead pixels come from the artwork's palette.
 *
 * `uBeat` is squared before it gates: dropouts should be transient events on
 * the hit, not a texture the whole track sits under.
 *
 * 3 fetches, all unconditional — on a tile-based GPU a branch that skips a
 * fetch costs more than the fetch.
 */
export const DROPOUT_PASS: PassDefinition = {
  id: 'dropout',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform sampler2D uArt;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uTime;
uniform float uBeat;
uniform float uPhase;
uniform float uEnergy;
uniform float uIntensity;
uniform vec3 uAccent;
uniform float uBlock;
uniform float uAmount;
uniform float uNoise;
out vec4 fragColour;
${HASH}
void main() {
  float on = step(0.0001, uIntensity);
  vec3 here = texture(uTexture, vUv).rgb;
  vec2 cell = floor(vUv / (max(uBlock, 1.0) * uTexel));
  float seed = floor(uPhase * 2.0) * 29.0;
  float gate = clamp(uAmount * uBeat * uBeat * (0.3 + 0.7 * uEnergy), 0.0, 1.0);
  float fire = step(1.0 - gate, hash21(cell + seed)) * on;
  vec3 stale = texture(uPrev, vUv).rgb;
  vec3 raw = texture(uArt, vUv).rgb;
  vec3 source = mix(stale, raw, step(0.5, hash21(cell + 3.7)));
  // uTime is the only clock in this file, and it is inside an event uBeat has
  // already decided to run: it animates the speckle so a held dropout does not
  // freeze into a still pattern.
  float grain = hash21(floor(vUv / uTexel) + fract(uTime) * 61.0);
  vec3 dropped = mix(source, uAccent * (0.35 + 0.65 * grain), uNoise);
  fragColour = vec4(mix(here, dropped, fire), 1.0);
}
`,
  params: {
    block: { default: 40, min: 4, max: 256 },
    amount: { default: 0.4, min: 0, max: 1 },
    noise: { default: 0.3, min: 0, max: 1 },
  },
};

/**
 * Bit crush — hard channel quantisation, banding as the point.
 *
 * `bias` gives red and blue fewer steps than green, in the spirit of 5:6:5.
 * That asymmetry is what makes a crushed gradient go magenta and green in
 * bands instead of merely posterising, and it is the reason this reads as a
 * *format* failing rather than as a filter.
 *
 * The depth collapses under `crunch` as the beat and the overall energy rise,
 * so a loud bar loses colours and a quiet one gets them back. Output is a
 * `mix` against the source weighted by `uIntensity` — at zero that returns the
 * sample untouched, which quantising to 256 levels would not quite do.
 *
 * 1 fetch.
 */
export const BITCRUSH_PASS: PassDefinition = {
  id: 'bitcrush',
  fragment: `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uBeat;
uniform float uEnergy;
uniform float uIntensity;
uniform float uLevels;
uniform float uCrunch;
uniform float uBias;
out vec4 fragColour;
void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  float loud = 0.5 * uBeat + 0.5 * uEnergy;
  float levels = max(2.0, uLevels - uCrunch * loud * (uLevels - 2.0));
  float sides = levels - uBias * (levels - 2.0);
  vec3 depth = vec3(sides, levels, sides);
  // floor(1.0 * depth) is depth itself, one step past the top of the range,
  // so the clamp is load-bearing on pure white rather than defensive.
  vec3 crushed = clamp(floor(here * depth) / max(depth - 1.0, vec3(1.0)), 0.0, 1.0);
  fragColour = vec4(mix(here, crushed, uIntensity), 1.0);
}
`,
  params: {
    levels: { default: 6, min: 2, max: 32 },
    crunch: { default: 0.5, min: 0, max: 1 },
    bias: { default: 0.35, min: 0, max: 1 },
  },
};

/**
 * The family, in the order a preset is most likely to want them: geometry
 * first (`rgbsplit`, `blockshift`, `smear`, `tear`), then the two that decide
 * what a pixel *is* (`dropout`, `bitcrush`). Registered into the catalogue by
 * `passes.ts`; nothing here reaches into it.
 */
export const GLITCH_PASSES: readonly PassDefinition[] = [
  RGBSPLIT_PASS,
  BLOCKSHIFT_PASS,
  SMEAR_PASS,
  TEAR_PASS,
  DROPOUT_PASS,
  BITCRUSH_PASS,
];
