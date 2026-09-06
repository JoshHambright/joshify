/**
 * Effect family D — the Winamp classics (P5-09).
 *
 * Spectrum bars, oscilloscope, kaleidoscope, particles. Four passes, no code
 * path anywhere: each is a `PassDefinition` the catalogue holds as data, and a
 * preset names it by id (passes.ts).
 *
 * **What these four are actually driven by.** `uBands[16]` — sixteen buckets,
 * bass to treble — is the input for the whole family. On Tier 2 those are a
 * real FFT of the PCM librespot is decoding. On Tier 0 and Tier 1, which is
 * what almost everybody will actually see, they are *procedural*: smooth
 * value noise, floored at 0.05, bass-tilted, with neighbouring bands
 * deliberately correlated so a wave travels across them (reactivity/
 * procedural.ts). That is a very different signal from an FFT — it never
 * spikes and it never bottoms out — so every pass here is tuned against it
 * rather than against real spectrum data:
 *
 * - a **contrast curve** on each band, because smooth noise sits in the middle
 *   of its range and an uncurved display hovers at half height looking dead;
 * - a **tilt compensation**, because both the procedural field and a real FFT
 *   of music fall away toward treble, and without it the right-hand side of
 *   any of these is permanently short;
 * - a **floor** under the bar height, for the same reason the provider floors
 *   its bands: an empty display reads as a crashed process, not as silence.
 *
 * A visualiser that only comes alive on Tier 2 is one nearly nobody sees,
 * because Tier 2 needs librespot and is opt-in (D-013).
 *
 * **Shared constraints.** GLES 3.1 on a VideoCore VII: `#version 300 es`,
 * `precision mediump float;`, `highp` declared locally only where coordinate
 * maths needs it. No `discard` — on a tile-based GPU it disables early-Z for
 * the whole draw, and every pass here covers its target anyway. No loop whose
 * bound depends on data; the two loops that exist have literal bounds with the
 * reason written beside them.
 */
import type { PassDefinition } from '../passes.js';

/**
 * Every fragment shader in the family starts here.
 *
 * It declares no uniforms on purpose: a prelude that declared `uTexture` would
 * hand it to the overlays, and the whole point of D-062 is that an overlay
 * structurally cannot filter what is beneath it.
 */
const HEAD = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColour;
const float TAU = 6.2831853;
`;

/**
 * **Spectrum bars. An overlay** — the one pass in this repo that D-062 was
 * written for.
 *
 * Bars are drawn geometry with hard vertical edges one panel pixel wide. Run
 * inside the scaled chain at the default 0.5 grain, every one of those edges
 * is a half-resolution texel smeared over two, and sixteen soft-edged
 * rectangles is not a spectrum analyser, it is a bar chart seen through a wet
 * window. So this runs after the upscale, at panel resolution, alpha-blended
 * over the finished frame — which it can afford to do because it does not
 * read the frame at all. It composites; it does not filter. It is also
 * therefore the last thing the degrader will drop, which is right: dropping
 * the bars saves nothing worth the hole it leaves.
 *
 * **Sixteen bars is a coordinate problem, not a loop.** The bar a fragment
 * belongs to is a function of its own x, and the band that bar needs is that
 * index — so there is no iteration here at all, just `int(vUv.x * 16.0)` and
 * one dynamically indexed read of the uniform array (legal in GLSL ES 3.00,
 * unlike ES 1.00, and the reason this shape works).
 *
 * **Colour comes from `uAccent` and `uForeground` and nowhere else.** Both are
 * contrast-corrected against the artwork server-side (P3-04) and the bars sit
 * directly on that artwork. The body is a gradient between the two rather than
 * one flat accent: the accent is *extracted from* the cover, so a single-tone
 * bar can vanish into the region of the cover it came from, while a bar
 * carrying both colours cannot.
 *
 * **Cost:** no texture reads, roughly twenty ALU per fragment, at panel
 * resolution. The cheapest pass in the engine.
 */
export const BARS_PASS: PassDefinition = {
  id: 'bars',
  overlay: true,
  fragment: `${HEAD}
uniform float uBands[16];
uniform float uIntensity;
uniform vec2 uTexel;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform float uGain;
uniform float uTilt;
uniform float uGap;
uniform float uHeight;
uniform float uCap;

void main() {
  // The bar this fragment is in, and where across that bar it sits. No loop:
  // sixteen bars is a function of x.
  float slot = vUv.x * 16.0;
  int index = clamp(int(slot), 0, 15);
  float within = fract(slot);

  // Both a real FFT of music and the procedural noise field are bass-heavy,
  // so an uncompensated display ramps down to nothing at the right-hand edge.
  // A rising per-band gain is what a hardware analyser does for the same
  // reason.
  float tilt = 1.0 + uTilt * float(index) / 15.0;
  float level = clamp(uBands[index] * uGain * tilt, 0.0, 1.0);
  // Smooth pseudo-noise clusters around the middle of its range; a contrast
  // curve spreads it so Tier 0 bars dance instead of hovering at half height.
  float shaped = level * level * (3.0 - 2.0 * level);
  // Never quite zero, for the same reason the provider floors its bands: an
  // empty display reads as a crashed process rather than as a quiet passage.
  float top = uHeight * (0.04 + 0.96 * shaped) * uIntensity;

  // uTexel is the panel here, not the chain, so these edges are exactly one
  // real pixel wide -- which is the entire argument for being an overlay.
  float halfBar = 0.5 * (1.0 - uGap);
  float aa = uTexel.x * 16.0;
  float column = 1.0 - smoothstep(halfBar - aa, halfBar, abs(within - 0.5));
  float body = 1.0 - smoothstep(top - uTexel.y, top, vUv.y);
  float tip = body * smoothstep(top - uCap - uTexel.y, top - uCap, vUv.y);

  // Two contrast-corrected colours rather than one: the accent was extracted
  // from the cover, so a flat accent bar can disappear into the cover.
  float up = clamp(vUv.y / max(top, 0.001), 0.0, 1.0);
  vec3 colour = mix(uAccent, uForeground, up * 0.55);
  colour = mix(colour, uForeground, tip);

  // uIntensity scales the bars down and fades them out together, so 0 is a
  // fully transparent no-op rather than a flat line along the bottom.
  fragColour = vec4(colour, column * body * uIntensity);
}
`,
  params: {
    gain: { default: 1.15, min: 0.25, max: 3 },
    tilt: { default: 0.6, min: 0, max: 1.5 },
    gap: { default: 0.22, min: 0, max: 0.6 },
    height: { default: 0.34, min: 0.05, max: 1 },
    cap: { default: 0.012, min: 0, max: 0.08 },
  },
};

/**
 * **Oscilloscope. An overlay**, for the same reason as the bars: it is a
 * two-pixel line, and a two-pixel line upscaled from half resolution is a
 * four-pixel smudge. It reads nothing beneath it, so it costs no chain input.
 *
 * **What this is honestly drawing, since it is not a waveform.** There is no
 * PCM on Tier 0 or Tier 1 — that is the whole of D-010 — so there is no
 * waveform to trace, and calling this one would be a lie told in a docblock.
 * What it draws is a **resynthesis**: a bank of sixteen harmonics whose
 * amplitudes are `uBands`, summed. It is the waveform *of a signal that has
 * this spectrum* — not the waveform of the track. The phases are invented
 * (odd harmonics as sine, even as cosine, a fixed quarter-turn apart) because
 * a magnitude spectrum does not contain phase. That last point holds on Tier 2
 * as well: an FFT magnitude bin has thrown its phase away, so even against a
 * real spectrum this is a reconstruction with a shape we chose, not the trace
 * on a scope.
 *
 * What it *does* honestly show is the spectrum: a bass-heavy moment gives a
 * slow rolling curve, a bright one gives a fine ripple over it, and the trace
 * travels exactly one period per beat — seamlessly, because every harmonic is
 * an integer multiple of the fundamental, so the sawtooth discontinuity in
 * `uPhase` lands where the wave repeats and is invisible.
 *
 * **The loop bound is 16** because the contract fixes the band count at 16
 * (`BAND_COUNT`, uniforms.ts) and this is one harmonic per band.
 *
 * **Cost:** one `sin` and one `cos` for the whole sum, not thirty-two. The
 * harmonics come out of a Chebyshev recurrence (`s[k+1] = 2·cosθ·s[k] −
 * s[k−1]`), which is six flops each, and the conservative bound check skips
 * even that for the ~60% of the panel the trace provably cannot reach. Call it
 * 120 flops on the band and 10 off it, at panel resolution.
 */
export const SCOPE_PASS: PassDefinition = {
  id: 'scope',
  overlay: true,
  fragment: `${HEAD}
uniform float uBands[16];
uniform float uPhase;
uniform float uIntensity;
uniform vec2 uResolution;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform float uAmp;
uniform float uCycles;
uniform float uWidth;
uniform float uGlow;

// The glow reaches exactly this far and no further, which is what gives the
// early-out below a bound instead of a guess.
const float GLOW_PX = 16.0;

void main() {
  highp float amp = uAmp * uIntensity;
  highp float fromMiddle = vUv.y - 0.5;
  // The trace is normalised to +/-1 before scaling, so it cannot leave this
  // band, and nothing outside the band plus the glow is within a glow radius
  // of it in y. Most of the panel is not, and skips the harmonic sum -- and
  // it skips coherently, because the test is on y alone.
  highp float reach = amp + (uWidth * 0.5 + GLOW_PX) / uResolution.y;

  float alpha = 0.0;
  vec3 colour = uForeground;

  if (abs(fromMiddle) <= reach) {
    // One period of travel per beat. Every harmonic is an integer multiple of
    // this, so uPhase's sawtooth wraps exactly where the wave repeats and the
    // discontinuity is invisible.
    highp float theta = (vUv.x * uCycles + uPhase) * TAU;
    highp float c = cos(theta);
    highp float sPrev = 0.0;
    highp float sCur = sin(theta);
    highp float cPrev = 1.0;
    highp float cCur = c;
    highp float sum = 0.0;
    highp float slope = 0.0;
    // Seeded above zero so a silent spectrum divides by something.
    highp float norm = 0.0001;

    // Bound is 16: one harmonic per band, and the contract fixes 16 bands.
    for (int k = 1; k <= 16; ++k) {
      float amplitude = uBands[k - 1];
      // Odd harmonics as sine, even as cosine. A magnitude spectrum has no
      // phase, so some phase has to be chosen; alternating keeps the trace
      // from collapsing into a symmetric pulse train.
      bool isEven = (k % 2) == 0;
      highp float basis = isEven ? cCur : sCur;
      highp float derivative = isEven ? -sCur : cCur;
      sum += amplitude * basis;
      slope += amplitude * float(k) * derivative;
      norm += amplitude;
      // Chebyshev recurrence: sin(kt) and cos(kt) from sin(t) and cos(t), so
      // the whole bank costs one transcendental pair rather than thirty-two.
      // mediump loses about a percent by k=16, which is a fraction of a pixel.
      highp float sNext = 2.0 * c * sCur - sPrev;
      highp float cNext = 2.0 * c * cCur - cPrev;
      sPrev = sCur;
      sCur = sNext;
      cPrev = cCur;
      cCur = cNext;
    }

    highp float trace = sum / norm;
    highp float curve = 0.5 + trace * amp;
    // Distance to the curve, not distance in y: without dividing by the
    // gradient the line thins to nothing wherever it is steep. It is a
    // linearisation, so it is only trusted near the curve -- which is the
    // only place it is asked.
    highp float gradient =
      (slope / norm) * amp * TAU * uCycles * uResolution.y / uResolution.x;
    highp float d =
      abs(vUv.y - curve) * uResolution.y / sqrt(1.0 + gradient * gradient);

    float core = 1.0 - smoothstep(uWidth * 0.5, uWidth * 0.5 + 1.0, d);
    float halo = max(0.0, 1.0 - d / GLOW_PX);
    alpha = clamp(core + uGlow * halo * halo, 0.0, 1.0);
    colour = mix(uAccent, uForeground, core);
  }

  // At uIntensity 0 the amplitude is already flat; the fade is what makes it
  // an actual no-op instead of a line across the middle of the screen.
  fragColour = vec4(colour, alpha * uIntensity);
}
`,
  params: {
    amp: { default: 0.16, min: 0, max: 0.45 },
    cycles: { default: 1.5, min: 0.25, max: 6 },
    width: { default: 2, min: 1, max: 8 },
    glow: { default: 0.35, min: 0, max: 1 },
  },
};

/**
 * **Kaleidoscope. Not an overlay, and it cannot be one.**
 *
 * A kaleidoscope is a *filter*: it draws nothing of its own, it re-samples
 * what is beneath it through a folded coordinate. An overlay is given no
 * `uTexture` (D-062), so an overlay kaleidoscope has nothing to mirror — it is
 * structurally impossible, not merely a bad idea. It belongs in the scaled
 * chain, where it also composes over whatever scene ran ahead of it: folding
 * the tunnel is free (D-014).
 *
 * Bass drives the radial squeeze and treble the spin speed, both read with
 * constant indices — four uniform reads each, no loop.
 *
 * The mirror-repeat at the end is by hand because the render targets are
 * clamp-to-edge: a fold that leaves the unit square would otherwise smear one
 * row of texels outward across the whole wedge, which looks like a driver bug.
 *
 * **Cost:** one `atan`, one `sqrt`, one `sin`/`cos` pair and two texture reads
 * per fragment, at render scale. The second read is the price of mixing back
 * toward the untouched frame so `uIntensity = 0` is exactly a pass-through.
 */
export const KALEIDO_PASS: PassDefinition = {
  id: 'kaleido',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform float uBands[16];
uniform float uBeat;
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;
uniform float uSegments;
uniform float uSpin;
uniform float uPulse;
uniform float uMix;

void main() {
  vec3 base = texture(uTexture, vUv).rgb;

  // Square the coordinate first, or the wedges are ellipses on a 720x1280
  // panel and the symmetry stops reading as symmetry.
  highp float aspect = uResolution.x / uResolution.y;
  highp vec2 centred = (vUv - 0.5) * vec2(aspect, 1.0);
  highp float radius = length(centred);
  highp float angle = atan(centred.y, centred.x);

  // Constant indices: four reads at each end of the spectrum, no loop.
  float bass = 0.25 * (uBands[0] + uBands[1] + uBands[2] + uBands[3]);
  float treble = 0.25 * (uBands[12] + uBands[13] + uBands[14] + uBands[15]);

  // Floored at two: one segment is not a kaleidoscope, and a fractional count
  // leaves a hard seam where the last wedge fails to close.
  highp float segments = max(2.0, floor(uSegments));
  highp float wedge = TAU / segments;
  angle += uTime * uSpin * (0.5 + treble);
  // Fold into one wedge, then mirror within it. The mirror is what makes the
  // join between wedges continuous rather than a visible cut.
  angle = abs(mod(angle, wedge) - wedge * 0.5);

  highp float squeeze = 1.0 + uPulse * (bass - 0.5 + uBeat);
  highp vec2 folded = vec2(cos(angle), sin(angle)) * radius * squeeze;
  highp vec2 uv = folded / vec2(aspect, 1.0) + 0.5;
  // Mirror-repeat by hand: the targets are clamp-to-edge, and a fold that
  // leaves the unit square would smear one row of texels across the wedge.
  uv = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);

  vec3 mirrored = texture(uTexture, uv).rgb;
  // uIntensity 0 returns the input untouched, which is what a no-op is for a
  // pass that filters rather than composites.
  fragColour = vec4(mix(base, mirrored, clamp(uMix * uIntensity, 0.0, 1.0)), 1.0);
}
`,
  params: {
    segments: { default: 6, min: 2, max: 12 },
    spin: { default: 0.09, min: -1, max: 1 },
    pulse: { default: 0.18, min: 0, max: 0.6 },
    mix: { default: 1, min: 0, max: 1 },
  },
};

/**
 * **Particles. Not an overlay — deliberately, and this is the one of the four
 * where the call could have gone either way.**
 *
 * The case for an overlay is sharpness, and it does not apply: a particle here
 * is a soft radial falloff with no hard edge anywhere in it, so the half-res
 * upscale costs it nothing a Gaussian was not going to do to it regardless.
 * The case against is the word "bloom" in the effect's own name. Inside the
 * chain, a feedback or echo pass downstream picks the particles up and smears
 * them into trails; as an overlay they would be drawn after everything and
 * would only ever be dots. The whole payoff of the family-A passes is that
 * they get to act on what came before them, and particles are the best thing
 * in this family to hand them.
 *
 * **No state, so no real particle system.** There are no persistent buffers
 * here and nothing to integrate velocity into, so this is the standard
 * stateless dodge: the screen is a grid of cells, each cell owns one particle,
 * and a particle's position is a hash of (cell, generation) where generation
 * is `floor(uTime / uLife)` staggered per cell. A particle is constructed to
 * stay inside its own cell for its whole life — it starts at a hashed height
 * that leaves exactly enough room for its drift — which is what makes the
 * neighbourhood search exact rather than approximate.
 *
 * **"Beat-spawned", honestly:** without state we cannot spawn *on* the beat,
 * so lifetimes are staggered and the whole field brightens with `uBeat`
 * instead. The field is also a spectrum — a fragment's particles are lit by
 * the band at its own screen x — so the sparkle moves bass-to-treble across
 * the panel in step with the bars.
 *
 * **The loop bound is 9** — the home cell and its eight neighbours. That is
 * exact, not a guess: a particle never leaves its home cell, and its radius is
 * capped below one cell, so no cell further away can reach this fragment.
 *
 * **Cost:** nine cells, one hash each, one texture read; call it 250 flops per
 * fragment at render scale. The most expensive of the four, and the trade an
 * overlay could not have made — at 0.5 grain it does a quarter of the work.
 */
export const PARTICLES_PASS: PassDefinition = {
  id: 'particles',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform float uBands[16];
uniform float uBeat;
uniform float uEnergy;
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform float uDensity;
uniform float uSize;
uniform float uRise;
uniform float uLife;

// An integer-free hash with no sin() in it: the shader-idiomatic
// fract(sin(x) * 43758.5) varies between drivers, and this field has to be
// stable when the Pi and a desktop are being compared side by side.
highp vec2 hash22(highp vec2 p) {
  highp vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

void main() {
  vec3 base = texture(uTexture, vUv).rgb;

  // Cells are square, so a particle is a disc rather than an ellipse.
  highp float aspect = uResolution.x / uResolution.y;
  highp vec2 grid = vec2(vUv.x * aspect, vUv.y) * uDensity;
  highp vec2 cell = floor(grid);

  float glow = 0.0;
  // Bound is 9: the home cell and its eight neighbours. A particle never
  // leaves its home cell (see the start offset below) and uSize is capped
  // under one cell, so nothing further away can reach this fragment.
  for (int i = 0; i < 9; ++i) {
    highp vec2 home = cell + vec2(float(i % 3) - 1.0, float(i / 3) - 1.0);
    highp vec2 seed = hash22(home);
    // Staggered so the field drizzles instead of blinking in unison.
    highp float age = uTime / uLife + seed.x * 6.0;
    // Wrapped, not raw: the generation counter would otherwise reach five
    // figures on an appliance that has been up for a day, and a hash argument
    // that large quantises in fp32 -- the field would visibly coarsen the
    // longer it ran. The whole field repeats every 256 lifetimes, ten minutes
    // at the default, which is not a period anyone watching will find.
    highp float generation = mod(floor(age), 256.0);
    highp float progress = fract(age);
    // A cheap scramble of the cell seed rather than a second hash: this runs
    // nine times per fragment and only has to decorrelate one generation from
    // the next. The golden-ratio pair is the standard low-discrepancy choice.
    highp vec2 jitter = fract(seed * 37.13 + generation * vec2(0.6180339, 0.3819660));
    // Start high enough that drift never carries the particle out of its own
    // cell. That is the invariant the loop bound of 9 rests on.
    highp float startY = jitter.y * (1.0 - abs(uRise)) + max(0.0, -uRise);
    highp vec2 centre = home + vec2(jitter.x, startY + progress * uRise);

    highp float d = length(grid - centre);
    // A soft falloff, not a disc. No hard edge is exactly why this pass can
    // afford to run at render scale instead of being an overlay.
    float spark = max(0.0, 1.0 - d / max(uSize, 0.001));
    // Fades in and out across the life, so nothing ever pops into existence.
    float envelope = 4.0 * progress * (1.0 - progress);
    glow += spark * spark * envelope;
  }

  // The field is a spectrum too: a particle is lit by the band at its own
  // screen x, so the sparkle runs bass to treble in step with the bars.
  int band = clamp(int(vUv.x * 16.0), 0, 15);
  float lit = clamp(glow, 0.0, 1.0);
  // No state means no spawning on the beat; brightening the whole field on it
  // is the honest substitute.
  float amount = lit * uBands[band] * (0.35 + 0.65 * uBeat) * (0.4 + 0.6 * uEnergy);

  vec3 tint = mix(uAccent, uForeground, lit);
  // Additive, and uIntensity 0 leaves the input bit-for-bit untouched.
  fragColour = vec4(base + tint * amount * uIntensity, 1.0);
}
`,
  params: {
    density: { default: 14, min: 4, max: 40 },
    size: { default: 0.16, min: 0.02, max: 0.45 },
    rise: { default: 0.7, min: -1, max: 1 },
    life: { default: 2.4, min: 0.4, max: 8 },
  },
};

/** Family D, as the catalogue takes it. */
export const CLASSIC_PASSES: readonly PassDefinition[] = [
  BARS_PASS,
  SCOPE_PASS,
  KALEIDO_PASS,
  PARTICLES_PASS,
];
