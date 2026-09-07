/**
 * Effect family E — art-derived (P5-10).
 *
 * Six post passes: `shatter`, `cycle`, `slitscan`, `displace`, `edge`,
 * `matrix`. Each is a `PassDefinition` and nothing more — `passes.ts` owns the
 * catalogue, a preset names one by id, and the pipeline never learns what any
 * of them is (VISUALIZER.md, "effects are data, not code paths").
 *
 * ## The thesis, which is the whole point of the family
 *
 * The other four families deform whatever the scene handed them. This one
 * treats **the album cover as source material rather than as a backdrop**: it
 * samples it, takes its palette, reads its luminance as a field. The test each
 * pass is written against is *would this look identical over a flat colour?* —
 * and if the answer is yes, the pass has missed:
 *
 * | Pass | What of the artwork it uses | Over a solid colour |
 * |---|---|---|
 * | `cycle` | a palette read out of the cover itself | one flat tone, cycling |
 * | `slitscan` | the frame own history | nothing at all |
 * | `displace` | the cover luminance *gradient* as the flow field | nothing at all |
 * | `shatter` | nothing — it is geometry over the picture | shards you cannot see |
 * | `edge` | the cover contours, as a Sobel of `uArt` | nothing at all |
 * | `matrix` | the cover resampled to emissive cells | a flat grid |
 *
 * Three of those six are *exactly* nothing over a flat colour, which is the
 * strongest form of the property. Two are honest about being weaker:
 * `shatter` is a fracture pattern laid over whatever is there, and `matrix` is
 * the one that earns its place on a different argument entirely — see its
 * docblock.
 *
 * ## Where the artwork is read from
 *
 * `uArt` is the **raw cover**, not what the chain has done to it. That matters
 * twice over. `edge` takes its gradient there because a Sobel of `uTexture`
 * after a dither or a grain pass detects the noise and not the picture, and
 * after a posterize it detects the banding contours — mush, in both cases,
 * which is the failure this pass most had to avoid. `displace` does the same
 * so that its flow field is a property of the album rather than of whatever
 * ran before it, and stays stable while the picture moves through it.
 *
 * The consequence, stated rather than hidden: over the `tunnel` scene (D-014)
 * both of those read a *flat* cover that no longer registers with the geometry
 * on screen. The cover contours drawn over the tube are then a deliberate
 * double exposure, not an outline of what you are looking at. Over `flat`,
 * which is what family E was written for, they register exactly.
 *
 * ## The rules every pass here keeps
 *
 * **At `uIntensity == 0` each pass is an exact pass-through** — the same bits
 * out as in, not a near miss. Where a pass displaces, the displacement is
 * scaled by `uIntensity` so the fetch lands back on `vUv`; where it recolours,
 * the final `mix` weight carries `uIntensity`. `shatter` writes its rotation
 * as `rot(a) * local - local` rather than rebuilding the coordinate around the
 * shard centre, because `(x - c) + c` is not exactly `x` in floating point and
 * a half-texel error at zero intensity is a pass that never quite switches
 * off. `art.test.ts` pins the expression that does this for each pass.
 *
 * The trap `glitch.ts` documents applies here too: a `mediump` hash can round
 * to exactly `1.0`, so `step()` against one is not reliably off. Nothing in
 * this family gates on a hash — `shatter` uses hashes for magnitudes and
 * angles, every one of which is multiplied by `uIntensity` — so no `on` guard
 * is needed, and the test checks that this stays true.
 *
 * **Motion is bound to the music.** `uTime` does not appear in this file at
 * all, which the test asserts: `cycle` steps its palette on `uPhase`,
 * `slitscan` sweeps its live line on `uPhase` and wipes on `uBeat`, `displace`
 * and `shatter` pump on `uBeat`, `edge` drops its knee on the beat, `matrix`
 * lights its columns from `uBands`.
 *
 * **Precision.** `precision mediump float;` throughout, on a VideoCore VII
 * where `highp` fragment work is a real cost. `highp` is a local qualifier in
 * three places and each says why: the raster grid in `matrix`, the lattice
 * coordinates in `shatter`, and the hash in `shatter`. Colour is never
 * `highp`, and — the rule that matters across files — **no uniform in this
 * family carries a precision qualifier at all.** A uniform declared `highp`
 * here and `mediump` in another pass is a *link* failure on hardware
 * (`precision.test.ts`), and the cheapest way never to have that argument is
 * to let every uniform take the file default.
 *
 * **No `discard`, no data-dependent loops.** The only loop in the file is
 * `shatter`'s, bound at a literal 9 for a reason written beside it.
 *
 * ## Cost, at the resolution the stage renders at
 *
 * | Pass | Texture fetches | Notes |
 * |---|---|---|
 * | `cycle` | 2 | the frame, plus one point sample of `uArt` for the palette |
 * | `slitscan` | 2 | `uTexture` + `uPrev` |
 * | `displace` | 5 | 4 gradient taps of `uArt`, plus the displaced sample |
 * | `shatter` | 1 | one sample; the cost is 10 hashes and a 9-cell Voronoi |
 * | `edge` | 9 | 8 Sobel taps of `uArt`, plus the frame |
 * | `matrix` | 2 | the cell centre, plus the frame for the exact no-op |
 *
 * Twenty-one fetches for the family. `edge` is this family's `bloom` — budget
 * it as roughly three ordinary passes, and do not put it in a chain that also
 * carries `bloom` or `smear`. Everything else here is cheap, and `shatter` is
 * cheap in *fetches* while being the most ALU-heavy pass in the file.
 *
 * ## What each one does to contrast
 *
 * P5-16 treats these as documented fact, so they are stated per pass below in
 * the same terms `lofi.ts` uses. In one table, worst first:
 *
 * | Pass | Effect on mean luminance |
 * |---|---|
 * | `matrix` | **a cut of `1 - coverage`** (59% at the default fill) unless `gain` compensates; at `gain = 1` the cell mean is exact until a channel clips |
 * | `cycle` | at `tone = 0` luminance is **decoupled from the input** — the only pass here that can invert it. At `tone = 1` it is hue-only and neutral |
 * | `edge` | darkens along contours only; `coverage * amount * (1 - luma(ink))`, and exactly zero where the cover is flat |
 * | `shatter` | seams only: about `4 * width` of the frame, up to 19% of it at full beat, darkened by `crack` |
 * | `displace` | neutral. Geometric — it moves samples and never scales one |
 * | `slitscan` | neutral. A convex combination of two frames cannot leave the range they already covered, and on a still frame it is the identity |
 *
 * Homage, not reproduction (D-015): indexed-palette cycling, slit-scan
 * photography, Voronoi fracture, Sobel line work and dot-matrix displays are
 * period *techniques*, and none of them is anyone's trade dress.
 */
import type { PassDefinition } from '../passes.js';

/* ------------------------------------------------------------------ */
/* Shared shader fragments                                             */
/* ------------------------------------------------------------------ */

/**
 * What every pass in the file repeats. It declares no sampler on purpose:
 * which of the three a pass reads is part of what the pass *is*, and the
 * uniform audit in the tests only works if a shader declares exactly what it
 * uses.
 */
const HEAD = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 fragColour;
`;

/** Rec. 709, the same weights every other family uses. */
const LUMA = `float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}`;

/**
 * Three constant taps blended by position rather than `uBands[int(x * 16.0)]`.
 * A dynamically indexed uniform array becomes an indexable temporary on V3D,
 * and a spectrum running across the panel reads just as well from two `mix`es
 * and a `step`. (The same construction `glitch.ts` uses, for the same reason;
 * it is four lines and neither file exports it.)
 */
const SPECTRUM = `float spectrum(float t) {
  float low = mix(uBands[1], uBands[8], clamp(t * 2.0, 0.0, 1.0));
  float high = mix(uBands[8], uBands[14], clamp(t * 2.0 - 1.0, 0.0, 1.0));
  return mix(low, high, step(0.5, t));
}`;

/**
 * A hash with no `sin()` in it, `highp` inside and nowhere else.
 *
 * The idiomatic `fract(sin(n) * 43758.5453)` varies between drivers, and the
 * shard layout has to be the same on the Pi and on the desktop it was reviewed
 * on. (The construction is the one `classics.ts` uses for its particle field —
 * duplicated rather than shared because neither file exports it and this file
 * may not edit that one.)
 */
const HASH22 = `highp vec2 hash22(highp vec2 p) {
  highp vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}`;

/* ------------------------------------------------------------------ */
/* The passes                                                          */
/* ------------------------------------------------------------------ */

/**
 * **Shatter** — the picture breaks into shards on the beat and settles as it
 * decays.
 *
 * **Voronoi, not a jittered grid, and the reason is not aesthetics.** A
 * fracture pattern *is* a Voronoi diagram: the shards of a broken pane are the
 * cells of the points the crack front started from, which is why the technique
 * is what fracture is modelled with. A jittered grid gives rectangles whatever
 * you do to their contents, and a screen full of displaced rectangles reads as
 * a tile flip — as `blockshift` (P5-07), which already exists and is a
 * different effect. The price is that a Voronoi has to *search*: nine hashes
 * per fragment instead of one.
 *
 * **The loop bound of 9 is exact, not cautious.** Each site is confined to the
 * middle 90% of its own cell, so a site outside the 3x3 block around a
 * fragment cannot be the nearest one to it — the same argument the particle
 * field uses for its nine cells, and it is what allows a constant bound where
 * a general Voronoi would need a growing search.
 *
 * Shards fly *away from the middle of the frame*, with a hashed magnitude and
 * a hashed spin, so the break reads as an impact rather than as noise; and
 * because the whole displacement is scaled by `uBeat`, reassembly is free —
 * the pieces come back as the beat decays, with nothing to integrate and no
 * state to hold.
 *
 * The seams are where the two nearest sites are equidistant, which is the one
 * term here that touches luminance.
 *
 * **Contrast:** neutral except at the seams. The displacement is geometric —
 * samples move, values do not scale — so the frame histogram is unchanged
 * apart from where a shard samples past the border and `CLAMP_TO_EDGE` repeats
 * it. The seam darkens by up to `crack * uIntensity`, over a band whose width
 * grows from 0.02 to 0.08 cells on the beat; the fraction of the frame inside
 * a Voronoi seam is about `4 * width`, so 8% of pixels at rest and 32% at a
 * full beat. At the default `crack` of 0.5 that is a mean luminance cut of 4%
 * at rest and 16% on the hit. Bounded, brief, and the only knob that matters
 * to P5-16 here.
 *
 * **Cost:** 1 texture fetch, 10 hashes, one `sin`/`cos` pair. Cheap on
 * bandwidth and the heaviest in the file on ALU.
 */
export const SHATTER_PASS: PassDefinition = {
  id: 'shatter',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uBeat;
uniform float uIntensity;
uniform float uCells;
uniform float uBurst;
uniform float uSpin;
uniform float uCrack;
${HASH22}

void main() {
  // highp for the lattice: uCells * vUv reaches a few tens and neighbouring
  // fragments have to agree about which cell they are in, or the shard edges
  // crawl. Square cells too -- on a 720x1280 panel an unscaled lattice gives
  // shards twice as tall as they are wide, which reads as a venetian blind.
  highp float aspect = uResolution.x / max(uResolution.y, 1.0);
  highp float cells = max(floor(uCells), 2.0);
  highp vec2 space = vec2(vUv.x * aspect, vUv.y) * cells;
  highp vec2 home = floor(space);

  // The bound is 9 -- the home cell and its eight neighbours -- and it is
  // exact: the jitter below keeps a site inside the middle 90% of its own
  // cell, so no site further out can be the nearest one to this fragment.
  // 8.0 as the starting distance rather than a huge sentinel, because mediump
  // tops out at 65504 and the widest a candidate can be here is under 3.
  highp vec2 shard = home;
  float best = 8.0;
  float second = 8.0;
  for (int i = 0; i < 9; ++i) {
    highp vec2 id = home + vec2(float(i % 3) - 1.0, float(i / 3) - 1.0);
    highp vec2 site = id + 0.5 + (hash22(id) - 0.5) * 0.9;
    float d = length(space - site);
    // Arithmetic select rather than an if: both sides are computed already and
    // a branch here would only buy divergence.
    float take = step(d, best);
    shard = mix(shard, id, take);
    second = min(second, max(d, best));
    best = min(best, d);
  }

  highp vec2 centre = shard + 0.5;
  vec2 seed = hash22(shard + 17.0);

  // Away from the middle of the frame, so the break reads as an impact.
  highp vec2 away = centre - vec2(0.5 * aspect, 0.5) * cells;
  // Guarded: a shard sitting exactly on the middle would normalise to NaN, and
  // one NaN fragment is a hole in the frame with nothing anywhere to explain
  // it.
  away = away / max(length(away), 0.001);

  float drive = uBeat * uIntensity;
  float angle = (seed.x - 0.5) * uSpin * drive;
  float c = cos(angle);
  float s = sin(angle);
  highp vec2 local = space - centre;
  // Written as a difference rather than as a coordinate rebuilt around the
  // shard centre: at angle 0 the matrix is the identity, so this term is
  // exactly zero, where (x - c) + c is only nearly x.
  highp vec2 spun = vec2(local.x * c - local.y * s, local.x * s + local.y * c) - local;
  highp vec2 moved = spun + away * uBurst * (0.35 + 0.65 * seed.y) * drive;

  // Back into UV. At uIntensity 0 every term above is zero and this fetch
  // lands on vUv, which is the whole pass-through guarantee.
  vec2 offset = vec2(moved.x / aspect, moved.y) / cells;
  vec3 piece = texture(uTexture, vUv - offset).rgb;

  // The seam: where the nearest two sites are equidistant. It widens on the
  // beat, and it is the only term in this pass that scales a colour.
  float width = 0.02 + 0.06 * uBeat;
  float seam = 1.0 - smoothstep(0.0, width, second - best);
  fragColour = vec4(piece * (1.0 - seam * uCrack * uIntensity), 1.0);
}
`,
  params: {
    /** Shards across the short edge. Under 3 there is nothing to break. */
    cells: { default: 10, min: 3, max: 40 },
    /** Peak displacement, in cell widths. */
    burst: { default: 0.4, min: 0, max: 1.5 },
    /** Peak rotation, in radians. */
    spin: { default: 0.5, min: 0, max: 1.5 },
    /** How dark the seam between two shards goes. A luminance cut — see above. */
    crack: { default: 0.5, min: 0, max: 1 },
  },
};

/**
 * **Palette cycling** — quantise to a small indexed palette taken from the
 * cover, then rotate the indices in time.
 *
 * The strongest period technique in the brief and very nearly free: no frame
 * of the animation is drawn, the *table* moves. Mark Ferrari's 90s work is the
 * reference, and what it needs is an indexed image and a palette to rotate.
 *
 * **Where the palette comes from, since all we have is a texture.** A real
 * extraction histograms the image and picks its modes. That needs a readback,
 * and this engine forbids one — a mid-frame read stalls a tile-based GPU, so
 * `GlContext` has no way to ask (README, "targeting a Pi 5"). What is here
 * instead is a **Vogel sunflower over the cover**: entry `i` is a point sample
 * of `uArt` at angle `i * 2.39996` and radius `0.45 * sqrt(i / levels)`, the
 * standard construction for spreading N points evenly over a disc. So the
 * palette is `levels` real colours from the artwork, spread across all of it
 * rather than along one line, and — the property that makes the effect work —
 * consecutive entries are never neighbours on the cover, so rotating the table
 * reads as a cycle and not as a slow pan across the picture. Radius 0.45 keeps
 * every sample inside the frame, which matters because `uArt` is a `REPEAT`
 * texture (the tunnel tiles it, P5-25) and a lookup off the edge would return
 * from the far side.
 *
 * `uAccent` and `uForeground` are deliberately *not* used. They are two
 * colours, and two colours is a ramp — which is what `posterize` already does
 * (P5-08). A cycle needs a table.
 *
 * **The rotation steps by whole entries, never interpolating**, because a
 * cross-fade between two palette entries is the one thing the technique never
 * did. It advances `levels * speed` steps across a beat off `uPhase`, so the
 * sawtooth wraps on a whole number of complete cycles and the reset at the
 * beat is invisible — the same reasoning that keeps the scope's harmonics
 * continuous (D-069).
 *
 * **Contrast: the most dangerous pass in the family, and it has a dial.** At
 * `tone = 1` the remap restores the pixel's measured luminance and changes hue
 * only, which is neutral under text and to within the clamp a fully saturated
 * entry forces. At `tone = 0` it is a true indexed cycle: output luminance
 * comes from the palette and is **decoupled from the input**, so a dark region
 * can become the cover's brightest colour and the ordering is not merely
 * compressed but *inverted*. That is the only pass in this family that can do
 * that, and `tone = 0, amount = 1` is the case P5-16 should test.
 *
 * **Cost:** 2 texture fetches, one `sin`/`cos` pair. The index arithmetic
 * stays under 300 and mediump holds integers exactly to 2048, so none of it
 * needs `highp`.
 */
export const CYCLE_PASS: PassDefinition = {
  id: 'cycle',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform sampler2D uArt;
uniform float uPhase;
uniform float uIntensity;
uniform float uLevels;
uniform float uSpeed;
uniform float uTone;
uniform float uAmount;
${LUMA}

// The golden angle. Vogel sunflower placement: point i at angle i * this and
// radius sqrt(i / n) covers a disc evenly, which is how a palette is read out
// of a 2D image without a histogram.
const float kGolden = 2.39996323;

void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  // Short of 1.0 so the top of the range cannot index one past the table.
  float tone = clamp(luma(here), 0.0, 0.999);

  float levels = max(floor(uLevels), 2.0);
  float turns = max(floor(uSpeed), 1.0);
  // Whole entries at a time. levels * turns steps across the beat means the
  // sawtooth wraps on a whole number of complete cycles, so the reset at the
  // beat boundary is invisible rather than a jump.
  float rotation = floor(uPhase * levels * turns);
  float slot = mod(floor(tone * levels) + rotation, levels);

  float t = (slot + 0.5) / levels;
  float angle = slot * kGolden;
  // 0.45 keeps the sample inside the cover: uArt wraps (P5-25), so a lookup
  // that walked off one edge would come back on the other.
  vec2 spot = vec2(0.5) + vec2(cos(angle), sin(angle)) * 0.45 * sqrt(t);
  vec3 entry = texture(uArt, spot).rgb;

  // Floored so a black palette entry cannot divide the frame away.
  float entryTone = max(luma(entry), 0.02);
  // uTone is how much of the pixel own luminance survives the remap: 1 is hue
  // only and neutral under text, 0 is a true indexed cycle whose brightness
  // rotates with the table.
  vec3 keyed = entry * (mix(entryTone, tone, uTone) / entryTone);

  fragColour = vec4(mix(here, clamp(keyed, 0.0, 1.0), uAmount * uIntensity), 1.0);
}
`,
  params: {
    /** Entries in the table. 8 is an EGA-ish read; 32 is a smooth ramp. */
    levels: { default: 8, min: 2, max: 32 },
    /** Complete cycles of the table per beat. Whole numbers only, in-shader. */
    speed: { default: 1, min: 1, max: 8 },
    /** How much of the input luminance survives. 1 is hue-only. */
    tone: { default: 0.45, min: 0, max: 1 },
    amount: { default: 1, min: 0, max: 1 },
  },
};

/**
 * **Slit-scan** — a live line sweeps the frame and everything behind it holds
 * an older moment.
 *
 * **What this honestly is, because it is not the textbook effect.** A real
 * slit-scan holds N frames and shows row `i` of frame `t - i`: a tap delay
 * line, one exact past moment per row. The engine has **one** frame of history
 * (`uPrev`, D-061) and three targets total, so a delay line of any depth is
 * not available and never was.
 *
 * What is here instead is a **per-row one-pole filter**: each row blends this
 * frame with the last one, with a retention that grows with distance from the
 * sweeping line. Because `uPrev` is the whole previous frame — this pass's own
 * output included — the history is *recursive*, so a row far from the line
 * shows an exponentially weighted sum of many past frames rather than one of
 * them. The depth comes from the recursion, not from a buffer.
 *
 * So: the visible signature of a slit-scan — time smeared across the frame,
 * fresh at the line and progressively older behind it. And what it is *not*:
 * no row corresponds to an exact frame, so you cannot say "that row is 20
 * frames ago"; a moving highlight leaves a decaying trail rather than a sharp
 * copy of itself at every row; and a chain that also carries `feedback` is two
 * one-pole filters on the same signal, which compounds into a much longer tail
 * than either was set for.
 *
 * The history is **dragged** by `drag` texels a frame along the scan axis, so
 * content ages *and* moves: a row shows an older moment at an older place,
 * which is the difference between a slit-scan and a ghost. `snap` collapses
 * the retention on `uBeat`, wiping the smear on the hit so it rebuilds behind
 * the line.
 *
 * **Contrast:** neutral, and provably so. The output is a convex combination
 * of two frames, so it cannot be darker than the darker of them or brighter
 * than the brighter — a mean this pass produces was already on screen. On a
 * still frame the two inputs are equal and it is exactly the identity. It
 * reduces *spatial* contrast on moving content only, which is what motion blur
 * is. Safe under text at any setting.
 *
 * **Cost:** 2 texture fetches, no branches, no transcendentals.
 */
export const SLITSCAN_PASS: PassDefinition = {
  id: 'slitscan',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uPhase;
uniform float uIntensity;
uniform float uAxis;
uniform float uHold;
uniform float uDrag;
uniform float uSweep;
uniform float uSnap;

void main() {
  vec3 here = texture(uTexture, vUv).rgb;

  // uAxis 0 sweeps down the rows, 1 across the columns, and the values between
  // are a legitimate diagonal rather than a mistake.
  float coord = mix(vUv.y, vUv.x, uAxis);
  // The live line, once per beat at uSweep 1. Off uPhase, so the scan is on
  // the beat grid instead of on a clock.
  float slit = fract(uPhase * uSweep);
  // Wrapped distance from the line: 0 at it, 1 directly opposite.
  float far = abs(fract(coord - slit + 0.5) - 0.5) * 2.0;

  // Retention grows behind the line and collapses on the beat if uSnap asks.
  // Capped short of 1.0 -- a retention of exactly one is a row that never
  // updates again.
  float keep = clamp(uHold * far * (1.0 - uSnap * uBeat), 0.0, 0.985) * uIntensity;

  // Texels of this stage, so the drag keeps its on-screen speed when the
  // degrader moves the render scale under it.
  vec2 drag = mix(vec2(0.0, uTexel.y), vec2(uTexel.x, 0.0), uAxis) * uDrag;
  vec3 past = texture(uPrev, vUv - drag).rgb;

  // Convex, so the result never leaves the range the two frames covered; and
  // at keep 0 it is the input bit for bit.
  fragColour = vec4(mix(here, past, keep), 1.0);
}
`,
  params: {
    /** 0 sweeps down the rows, 1 across the columns. */
    axis: { default: 0, min: 0, max: 1 },
    /** Peak retention, at the point furthest from the live line. */
    hold: { default: 0.88, min: 0, max: 1 },
    /** Texels of this stage the history moves each frame. */
    drag: { default: 1, min: 0, max: 6 },
    /** Sweeps of the live line per beat. */
    sweep: { default: 1, min: 0, max: 4 },
    /** How completely the beat wipes the smear. */
    snap: { default: 0.35, min: 0, max: 1 },
  },
};

/**
 * **Displacement** — the cover distorts itself.
 *
 * The field is **the gradient of the album cover's own luminance**, by central
 * differences over `uArt`, and that is the whole point: a noise-driven warp
 * would look the same over any input and belongs to family B, which already
 * has one. This field is a property of the artwork. It is zero everywhere the
 * cover is flat, it is strongest across its edges, and it is stable while the
 * picture moves through it — because it is read from the raw cover rather than
 * from what the chain has been doing to it.
 *
 * **The rotation is the interesting parameter.** At `curl = 0` the flow runs
 * along the gradient, so the picture is pushed toward light or dark and pools
 * there. At `curl = 1` it is a quarter turn — perpendicular to the gradient,
 * along the cover's contour lines. That field is divergence-free, so nothing
 * collapses into a bright region: the picture *stirs* around the artwork's
 * shapes instead of draining into them. `swirl` keeps turning it across the
 * beat, so the stirring direction moves with the music rather than sitting
 * still.
 *
 * **Contrast:** neutral. Every operation is geometric — a sample moves, no
 * value is ever scaled — so the frame's histogram and mean luminance are
 * unchanged, except where an offset walks past the border and `CLAMP_TO_EDGE`
 * repeats the edge row. Safe under text at any intensity, in the same way
 * `vhs`'s warble is. What it *can* do is move a bright region under the plate,
 * which is a case the plate's own worst-case analysis already covers (D-068),
 * because that quantifies over every possible backdrop.
 *
 * **Cost:** 5 texture fetches — four for the gradient and one displaced — plus
 * one `sin`/`cos` pair.
 */
export const DISPLACE_PASS: PassDefinition = {
  id: 'displace',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform sampler2D uArt;
uniform vec2 uTexel;
uniform float uBeat;
uniform float uPhase;
uniform float uIntensity;
uniform float uAmount;
uniform float uSpread;
uniform float uCurl;
uniform float uSwirl;
${LUMA}

// Clamped by hand because uArt wraps (REPEAT, so the tunnel can tile it --
// P5-25): a tap off the left edge otherwise returns from the right, and the
// difference across the border is a fiction. This is what CLAMP_TO_EDGE would
// have done, and the sampler cannot be changed from in here.
float field(vec2 uv) {
  return luma(texture(uArt, clamp(uv, 0.0, 1.0)).rgb);
}

void main() {
  // Not named step: a local called step would shadow the built-in for the rest
  // of the scope.
  vec2 reach = uTexel * max(uSpread, 1.0);
  // Central differences over the cover luminance. A real vector field, not
  // noise: it points across the artwork edges and is zero where it is flat.
  vec2 grad = vec2(
    field(vUv + vec2(reach.x, 0.0)) - field(vUv - vec2(reach.x, 0.0)),
    field(vUv + vec2(0.0, reach.y)) - field(vUv - vec2(0.0, reach.y)));

  // A quarter turn puts the flow along the contour lines rather than across
  // them, which makes it divergence-free -- the picture stirs around the
  // cover shapes instead of draining into them. uSwirl keeps turning it
  // across the beat.
  float angle = (uCurl + uSwirl * uPhase) * 1.5707963;
  float c = cos(angle);
  float s = sin(angle);
  vec2 flow = vec2(grad.x * c - grad.y * s, grad.x * s + grad.y * c);

  // Every term carries uIntensity, so at zero the offset is exactly zero and
  // the fetch lands on vUv.
  vec2 offset = flow * uAmount * (0.35 + 0.65 * uBeat) * uIntensity;
  fragColour = vec4(texture(uTexture, vUv + offset).rgb, 1.0);
}
`,
  params: {
    /** Peak displacement in UV, at a full-contrast edge. */
    amount: { default: 0.07, min: 0, max: 0.25 },
    /** Gradient tap distance, in texels of this stage. */
    spread: { default: 2, min: 1, max: 8 },
    /** Quarter turns applied to the field. 1 flows along the contours. */
    curl: { default: 0.75, min: 0, max: 1 },
    /** Extra quarter turns swept across each beat. */
    swirl: { default: 0.25, min: 0, max: 1 },
  },
};

/**
 * **Edge** — a Sobel of the album cover, inked over the frame. With
 * `posterize` in front of it, that is a cel-shaded look; on its own it is line
 * work over whatever the chain drew.
 *
 * **The kernel, stated.** Sobel: `gx = [-1 0 1; -2 0 2; -1 0 1]` and `gy` its
 * transpose, over luminance. Eight taps — the two zero columns are the centre
 * and cost nothing to skip — and the magnitude is `length(gx, gy) / 4`, where
 * 4 is the kernel gain for a black-to-white step. That is a real gradient
 * operator: the `[1 2 1]` smoothing perpendicular to each difference is
 * exactly what stops it being a high-pass that turns a busy cover to mush,
 * and it is why this is not four taps.
 *
 * **The gradient is taken from `uArt`, not from `uTexture`.** A Sobel of the
 * chain output after `dither` or `grain` finds the noise, and after
 * `posterize` finds the bands the quantiser just made — in both cases a
 * screen-filling scribble rather than an outline, which is the specific
 * failure this pass had to avoid. Reading the raw cover means the line work is
 * the album's own and survives whatever is done to the picture underneath it.
 * The cost is registration: over the `tunnel` scene the contours no longer
 * line up with what is on screen (see the file docblock).
 *
 * A note on `width`: at 1 the taps are adjacent texels and this is exactly
 * Sobel. Above that the operator samples a sparse lattice at `width` texels'
 * spacing, which is the gradient at a coarser scale — thicker outlines around
 * larger forms, and it *will* alias against fine detail. That is the trade,
 * and it is why the default is 1.
 *
 * The knee drops on `uBeat`, so finer contours surface on the hit and the
 * drawing thickens with the music instead of with a clock.
 *
 * **Contrast:** it can only move the frame toward the ink, and the ink is a
 * choice. With `ink = 1` the outline is `uForeground`, which is already
 * contrast-corrected against this cover server-side (P3-04), so the mean
 * barely moves. With `ink = 0` the outlines are black and mean luminance falls
 * by `coverage * amount`, where coverage is what fraction of the frame is
 * within a contour — data-dependent, near zero on a flat sleeve and up to
 * about 30% on a busy one at a low threshold. `ink = 0, amount = 1,
 * threshold = 0.02` is this pass's worst case for P5-16. Everywhere the cover
 * is flat the contribution is exactly zero, not merely small.
 *
 * **Cost:** 9 texture fetches. This family's `bloom` — budget it as three
 * ordinary passes and do not stack it with one.
 */
export const EDGE_PASS: PassDefinition = {
  id: 'edge',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform sampler2D uArt;
uniform vec2 uTexel;
uniform vec3 uForeground;
uniform float uBeat;
uniform float uIntensity;
uniform float uWidth;
uniform float uThreshold;
uniform float uInk;
uniform float uAmount;
${LUMA}

// Clamped by hand: uArt wraps for the tunnel (P5-25), and a tap off one edge
// returning from the other draws a hard false contour round the whole frame.
float tap(vec2 uv) {
  return luma(texture(uArt, clamp(uv, 0.0, 1.0)).rgb);
}

void main() {
  vec3 here = texture(uTexture, vUv).rgb;
  vec2 o = uTexel * max(uWidth, 0.5);

  // Sobel, written out. Eight taps: the centre column of gx and the centre row
  // of gy are zero, so the ninth sample would be multiplied by nothing.
  float tl = tap(vUv + vec2(-o.x, o.y));
  float tc = tap(vUv + vec2(0.0, o.y));
  float tr = tap(vUv + vec2(o.x, o.y));
  float ml = tap(vUv + vec2(-o.x, 0.0));
  float mr = tap(vUv + vec2(o.x, 0.0));
  float bl = tap(vUv + vec2(-o.x, -o.y));
  float bc = tap(vUv + vec2(0.0, -o.y));
  float br = tap(vUv + vec2(o.x, -o.y));

  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  // 0.25 is the kernel gain: a black-to-white step gives a component of 4.
  float mag = length(vec2(gx, gy)) * 0.25;

  // The knee drops on the beat, so the drawing thickens with the music.
  float knee = uThreshold * (1.0 - 0.35 * uBeat);
  // The soft edge is proportional to the knee plus a floor, so smoothstep can
  // never be handed a zero-width interval.
  float line = smoothstep(knee, knee + 0.05 + knee * 0.6, mag);

  // Ink out of the palette rather than out of nowhere: uForeground is already
  // contrast corrected against this cover (P3-04). uInk 0 is the black outline
  // of cel animation, 1 is the album own line colour.
  vec3 ink = mix(vec3(0.0), uForeground, uInk);
  fragColour = vec4(mix(here, ink, line * uAmount * uIntensity), 1.0);
}
`,
  params: {
    /** Tap spacing in texels. 1 is exactly Sobel; above that, a coarser scale. */
    width: { default: 1, min: 0.5, max: 4 },
    /** Gradient magnitude at which a contour starts being drawn. */
    threshold: { default: 0.12, min: 0.02, max: 0.6 },
    /** 0 inks in black, 1 in the extracted foreground colour. */
    ink: { default: 0, min: 0, max: 1 },
    amount: { default: 0.85, min: 0, max: 1 },
  },
};

/**
 * **Matrix** — the cover as a dot-matrix / LED wall.
 *
 * **Why it exists, which is not nostalgia.** The panel is read from about two
 * metres (PRODUCT.md §5.3, "glanceable from across the room"). At that
 * distance the eye integrates over several pixels, so fine detail in the
 * artwork is not resolved — it is averaged away — while a coarse emissive grid
 * *is* resolved, and reads as a picture built out of lamps. This is the one
 * pass in the family whose output is more legible than its input at the
 * distance the device is actually used from, rather than less.
 *
 * **Honest about the family thesis:** this is its weakest member. Over a solid
 * colour it is a grid and nothing more, where `slitscan`, `displace` and
 * `edge` would each do exactly nothing. What ties it to the artwork is the
 * resampling — every lamp is one point sample of the cover, so what is on
 * screen is the album reduced to `pitch`-sized cells — and it earns its place
 * on the legibility argument above rather than on this one.
 *
 * One sample per cell taken **at the cell centre**, like `halftone` (P5-08):
 * one lamp is one colour, flat, which is what a real display does, and every
 * fragment in a cell fetches the same texel, which is the best cache locality
 * available here.
 *
 * **Contrast, in three parts, because P5-16 needs all three:**
 *
 * 1. *Mean luminance.* The gaps between lamps are black, so an uncompensated
 *    grid is a `1 - coverage` cut, where coverage is the analytic lit area
 *    `pi/4 * fill²` — 48% at the default fill, so a 52% cut, the largest in
 *    this family by a wide margin. `gain` interpolates the lamp brightness up
 *    to `1 / coverage`, at which point the cell average is *exactly* the
 *    colour sampled, until a channel clips. At the defaults (`fill = 0.78`,
 *    `gain = 0.7`) the residual cut is about 16%.
 * 2. *Local contrast rises sharply.* Hard black between lit lamps. Read close
 *    up this is a strobing texture; read at two metres it integrates back to
 *    the cell colour, which is the entire premise.
 * 3. *Detail finer than `pitch` is destroyed*, exactly as in `halftone`.
 *    `pitch` is capped at 32 texels for that reason — beyond it the cover
 *    stops being recognisable as a picture, which is a different failure from
 *    an illegible one but still a failure.
 *
 * **Cost:** 2 texture fetches — the cell centre, plus the frame, which is what
 * buys the exact no-op at zero intensity.
 */
export const MATRIX_PASS: PassDefinition = {
  id: 'matrix',
  fragment: `${HEAD}
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uBands[16];
uniform float uBeat;
uniform float uIntensity;
uniform float uPitch;
uniform float uFill;
uniform float uGain;
uniform float uPulse;
${SPECTRUM}

void main() {
  vec3 here = texture(uTexture, vUv).rgb;

  // highp for the raster grid only: fp16 cannot hold 1280.5, and a cell index
  // that rounds at the bottom of the panel is a grid that visibly changes
  // pitch down the frame.
  highp vec2 raster = vUv * uResolution;
  highp float pitch = max(uPitch, 3.0);
  highp vec2 centre = (floor(raster / pitch) + 0.5) * pitch;

  // One sample per cell, at its centre. The clamp is for the last cell in a
  // row, whose centre can sit past the edge of the surface.
  vec3 lamp = texture(uTexture, clamp(centre / uResolution, 0.0, 1.0)).rgb;

  // Distance from the lamp, reaching 1.0 at the middle of a cell edge.
  highp float r = length(raster - centre) * 2.0 / pitch;
  float fill = clamp(uFill, 0.15, 1.0);
  float disc = 1.0 - smoothstep(fill - 0.12, fill + 0.12, r);

  // The lit fraction of a cell, analytically: a disc of radius fill/2 cells.
  // Dividing by it is what puts the average back where it was, because the
  // gaps are black and an uncompensated grid is a (1 - coverage) cut.
  float coverage = 0.7853982 * fill * fill;
  float gain = mix(1.0, 1.0 / max(coverage, 0.05), uGain);

  // A modulation about 1.0: each column of lamps is driven by its own band, so
  // the wall runs bass to treble across the panel, and the mean is unchanged
  // when the spectrum averages half.
  float drive = 1.0 + uPulse * (2.0 * spectrum(vUv.x) - 1.0 + 0.5 * uBeat);

  vec3 lit = lamp * disc * gain * drive;
  fragColour = vec4(mix(here, lit, uIntensity), 1.0);
}
`,
  params: {
    /** Cell pitch in texels of this stage. Capped at 32 — see the contrast note. */
    pitch: { default: 10, min: 4, max: 32 },
    /** Lamp diameter as a fraction of the cell. */
    fill: { default: 0.78, min: 0.3, max: 1 },
    /** How much of the gap's luminance is given back to the lamps. */
    gain: { default: 0.7, min: 0, max: 1 },
    /** How hard the per-column band drives its lamps. */
    pulse: { default: 0.35, min: 0, max: 1 },
  },
};

/**
 * The family, in the order a chain usually wants them: geometry first
 * (`shatter`, `slitscan`, `displace`), then the three that decide what a pixel
 * *is* (`cycle`, `edge`, `matrix`). `passes.ts` owns the catalogue and
 * registers this; nothing here reaches into it, which is what lets the two
 * files be edited independently.
 *
 * None of these is an overlay (D-062): every one filters what the stage before
 * it drew, and an overlay is given no `uTexture` at all.
 */
export const ART_PASSES: readonly PassDefinition[] = [
  SHATTER_PASS,
  SLITSCAN_PASS,
  DISPLACE_PASS,
  CYCLE_PASS,
  EDGE_PASS,
  MATRIX_PASS,
];
