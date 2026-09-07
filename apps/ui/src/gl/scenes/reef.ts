/**
 * The reef scene — the calm mode (D-018).
 *
 * `N2O` is a strobing tunnel at speed, which is right for loud music at 8pm and
 * wrong for an always-on object playing something quiet at 11pm. D-018 calls
 * that a **product gap rather than a nice-to-have**: a visualiser you switch
 * off has failed, and shipping only the aggressive mode guarantees it gets
 * switched off. So this is the tonal opposite of the tunnel, and *calm is a
 * technical requirement here, not a mood*. Three rules follow from it, and
 * every decision below is downstream of one of them:
 *
 * | Rule | How it is kept |
 * |---|---|
 * | **No strobe** | `uBeat` is declared in the vertex shader and *nowhere else* |
 * | **Slow** | every animated term has a period in tens of seconds |
 * | **Dark** | the deep tint is ~0.05 luminance; peak filament ~0.5 |
 *
 * ## What `uBeat` is allowed to touch, and why never brightness
 *
 * The fragment shader — the stage that decides every colour in this scene —
 * **does not declare `uBeat` at all**, so it is structurally incapable of
 * flashing. That is stronger than a convention, and it is asserted in the test
 * file rather than trusted. D-071 caps beat-driven flashing globally at 6%
 * relative luminance; this scene is not near the cap because it does not spend
 * the beat on luminance in the first place.
 *
 * What the beat does spend itself on is **position and phase**, both in the
 * vertex stage:
 *
 *  - a small vertical **lift** on the drifting forms, a fraction of their own
 *    size, so a beat gives them a nudge rather than a jolt;
 *  - a small **phase advance** on the caustic warp, so the net crawls a little
 *    ahead of itself.
 *
 * The phase advance is worth defending, because "it changes what a pixel is
 * doing" and "it is a flash" are not the same claim. Shifting the phase of a
 * stationary field *translates* it: the screen's mean luminance is invariant,
 * so no area of the panel gets brighter — the filaments simply move. A flash
 * is a change in the amount of light; this is a change in where it is.
 *
 * ## How the album participates
 *
 * **The album is the light.** There is one light source in this scene — the
 * surface overhead — and what the surface transmits is the cover, refracted by
 * the *same* warp field that bends the caustics. So the net and the shafts are
 * both tinted by `uArt` sampled through the refraction, the deep water is
 * `uAccent` nearly extinguished, and the silhouettes are unlit because they are
 * the thing blocking it.
 *
 * That choice, rather than "silhouettes coloured from the cover" or "cover as a
 * backdrop", because it is the one that makes the artwork *structural*: turn
 * `uArt` off and the scene has no light in it. The cover is sampled at a low
 * spatial frequency, so a viewer reads the record's palette moving through the
 * water and never reads the image itself — which is what keeps this a reef and
 * not an album cover behind a filter.
 *
 * ## Caustics: summed distorted sine sheets, not Worley
 *
 * Two octaves of three sine sheets at incommensurate angles and drift rates.
 * Where the three sheets cancel, the sum crosses zero and `1 - abs(sum)` peaks
 * — a thin bright filament — and raising it to the fourth power turns the
 * ridges into a net rather than stripes. The second octave runs the *same*
 * phases negated, so it counter-drifts for free and the two nets interfere
 * instead of sliding together.
 *
 * The classical alternative is animated Worley/Voronoi F1, which is the better
 * caustic and costs far more: two octaves means 18 cell hashes and 18 distance
 * evaluations per fragment, all of it dependent arithmetic. The sine field is
 * **8 transcendentals for the whole net**, and on a field this slow the
 * difference in realism is much smaller than the difference in price.
 *
 * ## God rays: a wedge, not a radial blur
 *
 * A god-ray *post* effect needs a light position and a radial blur — tens of
 * fetches along a ray, and the most expensive thing in any chain that has one.
 * Inside a scene it is nearly free, because we already know where the surface
 * is. A volumetric shaft is the integral of light along the view ray through a
 * cone whose apex is the light; on a plane, every ray from that apex is the
 * level set of `(x - lx) / (ly - y)`. So one divide gives the fan coordinate,
 * two sines of it at incommensurate frequencies give shafts of varying width,
 * and a vertical `smoothstep` fades them out with depth. **One divide, two
 * sines, zero fetches** — for the effect that would otherwise be the whole
 * budget.
 *
 * ## Silhouettes
 *
 * Original abstract forms only (D-015): a tapered lens with a slow camber that
 * flexes as it drifts. Nothing here is modelled on a specific creature design,
 * and nothing in this file borrows a shape from anybody. They are drawn as
 * billboards rather than as an SDF over the whole screen, because the water
 * field already costs every fragment and the form maths should only be paid for
 * where a form actually is.
 *
 * The billboards carry a real constraint with them, which `layoutReefLanes`
 * exists to satisfy: **the scene stage runs with blending off and its targets
 * have no depth attachment** (D-070), so a billboard is an opaque rectangle
 * that overwrites whatever it covers. It draws the water itself — the field is
 * a pure function of screen position, so any fragment can evaluate it — which
 * makes a quad invisible against the backdrop. But a quad drawn over *another
 * quad* would erase that form. Hence horizontal lanes that provably cannot
 * overlap, excursions included.
 *
 * ## Cost, per fragment
 *
 * Water (every fragment): ~10 transcendentals (2 warp, 6 net, 2 shaft), one
 * divide, one clamped texture fetch, ~35 ALU. Forms (a few percent of the
 * frame): one more sine and ~12 ALU. No loops, no `discard`, no dependent
 * fetches beyond the single refracted sample.
 *
 * Against the flat scene's *one* fetch and nothing else, this is the expensive
 * end of the scene stage and it is a full-screen scene — so a preset built on
 * it should keep the post chain short and spend its budget here.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { SceneDefinition } from '../passes.js';

/**
 * The golden and silver ratios, used as low-discrepancy sequences.
 *
 * Depth and starting phase are both spread over `0..1` by an irrational step,
 * which gives an even spread at every count without a random number generator —
 * so the mesh is byte-identical every run and a test can assert exact values.
 * Two *different* irrationals because the same one for both would put depth and
 * phase in lockstep: every form would enter the frame in size order.
 */
const GOLDEN = 0.618033988749895;
const SILVER = 0.414213562373095;

export interface ReefGeometryOptions {
  /** Drifting silhouettes. Each gets its own horizontal lane. */
  readonly forms: number;
  /**
   * Clear space in NDC between two neighbouring forms at their closest — that
   * is, after both have swung to the limit of their vertical excursion.
   */
  readonly clearance: number;
  /** Half-height of the band the lanes are packed into, in NDC. */
  readonly spread: number;
}

/**
 * Five forms is what reads as a populated stretch of water without becoming
 * traffic: at the default drift a form takes the better part of a minute to
 * cross, so five means one is usually near the middle of the frame and the
 * others are entering, leaving, or deep enough to be half-lost in the murk.
 */
export const REEF_GEOMETRY_OPTIONS: ReefGeometryOptions = {
  forms: 5,
  clearance: 0.03,
  spread: 0.92,
};

/** Attribute 0: the corner offset in `xy`, and the vertex's role in `z`. */
export const ATTRIBUTE_CORNER = 0;
/** Attribute 1: `(phase, halfSize, laneCentre, depth)` for this form. */
export const ATTRIBUTE_FORM = 1;

/** `aCorner.z`: the water plane, whose corners are already clip coordinates. */
export const ROLE_WATER = 0;
/** `aCorner.z`: a silhouette billboard, whose corners are the unit square. */
export const ROLE_FORM = 1;

/**
 * The vertical excursion budget, as a fraction of a form's own half-size.
 *
 * These two numbers are shared with the vertex shader — they are interpolated
 * into its source below — because the lane layout has to reserve room for
 * exactly the motion the shader will apply. Divorcing them is how two forms end
 * up overlapping on a loud beat, three months after anybody remembers why the
 * gap was the size it was.
 */
export const BOB_AMPLITUDE = 0.12;
export const BEAT_LIFT = 0.08;
export const MAX_LANE_EXCURSION = BOB_AMPLITUDE + BEAT_LIFT;

/**
 * A form smaller than this is a smudge rather than a silhouette: 0.03 NDC is
 * about 19px tall on the 720x1280 panel, before the half-resolution render
 * scale (D-011) halves it again.
 */
const MIN_HALF_SIZE = 0.03;

/** Near forms get more of the frame than far ones, which is what sells depth. */
const NEAR_WEIGHT = 1;
const FAR_WEIGHT = 0.45;

export interface ReefLane {
  /** Where in its crossing the form starts, `0..1`. */
  readonly phase: number;
  /** `0` nearest, `1` furthest. Drives size, speed and how far it fades. */
  readonly depth: number;
  /** Half-height of the billboard in NDC. Its width is this, in pixels. */
  readonly halfSize: number;
  /** The lane's centre line in NDC. */
  readonly centre: number;
}

const whole = (value: number, minimum: number, name: string): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`reef ${name} must be a whole number >= ${String(minimum)}`);
  }
  return value;
};

const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`reef ${name} must be a positive number`);
  }
  return value;
};

/**
 * Pack the forms into horizontal lanes that cannot overlap.
 *
 * The packing is the whole safety argument for the mesh, so it is a pure
 * function with its own tests rather than a loop inside the buffer builder.
 *
 * Lanes tile `[-spread, spread]` exactly, with each lane's height proportional
 * to how near its form is. **The half-size is derived from the lane, not the
 * other way round** — that inversion is what makes non-overlap structural: a
 * form is given `(height / 2 - clearance) / (1 + MAX_LANE_EXCURSION)`, so its
 * body *plus its full bob and beat lift* still leaves `clearance` before the
 * lane boundary, at every form count. Sizing first and then hoping the gap was
 * big enough works at five forms and quietly fails at two, where the lanes are
 * large and the excursion is proportional to the size.
 */
export const layoutReefLanes = (
  options: ReefGeometryOptions = REEF_GEOMETRY_OPTIONS,
): readonly ReefLane[] => {
  const forms = whole(options.forms, 1, 'forms');
  const clearance = positive(options.clearance, 'clearance');
  const spread = positive(options.spread, 'spread');

  // Depth, phase and lane weight in one pass, so the loop below iterates
  // values rather than indices — there is nothing to index out of range, and
  // therefore no unreachable fallback to leave sitting in the coverage report.
  const planned = Array.from({ length: forms }, (_unused, index) => {
    const depth = ((index + 1) * GOLDEN) % 1;
    return {
      depth,
      phase: ((index + 1) * SILVER) % 1,
      weight: NEAR_WEIGHT + (FAR_WEIGHT - NEAR_WEIGHT) * depth,
    };
  });
  const total = planned.reduce((sum, form) => sum + form.weight, 0);

  const lanes: ReefLane[] = [];
  let cursor = -spread;
  for (const [index, form] of planned.entries()) {
    const height = (2 * spread * form.weight) / total;
    const halfSize = (height / 2 - clearance) / (1 + MAX_LANE_EXCURSION);
    if (halfSize < MIN_HALF_SIZE) {
      throw new RangeError(
        `reef lane ${String(index)} leaves only ${halfSize.toFixed(4)} for a form — ` +
          'use fewer forms, less clearance, or more spread',
      );
    }
    lanes.push({
      phase: form.phase,
      depth: form.depth,
      halfSize,
      centre: cursor + height / 2,
    });
    cursor += height;
  }
  return lanes;
};

/**
 * The mesh: one oversized triangle for the water, then one quad per form.
 *
 * **The water is a single triangle** rather than two, for the reason
 * `FULLSCREEN_TRIANGLE` gives in `passes.ts` — one primitive covers the
 * viewport with no diagonal seam for a tile-based rasteriser to walk twice.
 * Its corners are clip coordinates and go through the vertex shader untouched.
 *
 * **The forms are emitted far end first.** Nothing depends on it — the lanes
 * cannot overlap, so no form is ever drawn over another — but there is no depth
 * buffer and no blending at the scene stage, so draw order is the *only* thing
 * that would decide it if that invariant were ever relaxed. Sorting now costs
 * nothing and means a future overlapping layout degrades into a painter's
 * ordering rather than into whichever form happened to be emitted last.
 *
 * The mesh is 3 + 4n vertices, so a 16-bit index cannot overflow: the lane
 * guard refuses long before the count could approach it.
 */
export const buildReefGeometry = (
  options: ReefGeometryOptions = REEF_GEOMETRY_OPTIONS,
): GeometrySpec => {
  const lanes = [...layoutReefLanes(options)].sort((a, b) => b.depth - a.depth);

  const vertexCount = 3 + lanes.length * 4;
  const corners = new Float32Array(vertexCount * 3);
  const forms = new Float32Array(vertexCount * 4);
  const indices = new Uint16Array(3 + lanes.length * 6);

  // The water plane. (-1,-1), (3,-1), (-1,3) covers the clip square with room
  // to spare, and is wound counter-clockwise like every quad after it.
  corners.set([-1, -1, ROLE_WATER, 3, -1, ROLE_WATER, -1, 3, ROLE_WATER]);
  indices.set([0, 1, 2]);

  const quad: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  let vertex = 3;
  let cursor = 3;
  for (const lane of lanes) {
    const base = vertex;
    for (const [x, y] of quad) {
      corners[vertex * 3] = x;
      corners[vertex * 3 + 1] = y;
      corners[vertex * 3 + 2] = ROLE_FORM;
      forms[vertex * 4] = lane.phase;
      forms[vertex * 4 + 1] = lane.halfSize;
      forms[vertex * 4 + 2] = lane.centre;
      forms[vertex * 4 + 3] = lane.depth;
      vertex += 1;
    }
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], cursor);
    cursor += 6;
  }

  return {
    attributes: [
      { location: ATTRIBUTE_CORNER, size: 3, data: corners },
      { location: ATTRIBUTE_FORM, size: 4, data: forms },
    ],
    indices,
    count: indices.length,
  };
};

export const REEF_MESH = buildReefGeometry();

const glsl = (value: number): string => value.toFixed(3);

/**
 * `highp`, like the tunnel's, and for the same class of reason: this stage owns
 * the clock. Every animated phase in the scene is integrated here from `uTime`
 * and handed to the fragment stage as a varying, so the precision that matters
 * is the precision `uTime * rate` is computed at. At `mediump` — 16 bits, a
 * ten-bit mantissa — an hour of uptime quantises time itself to nearly two
 * seconds, and every slow drift in the scene would ratchet.
 *
 * The uniforms shared with the fragment stage are declared `mediump`
 * explicitly, against this file's `highp` default. A uniform used in both
 * stages must carry the same precision in both or **the program fails to
 * link** — on hardware, invisibly to any headless test. `precision.test.ts`
 * exists because that bug has already been paid for once.
 */
const REEF_VERTEX = `#version 300 es
precision highp float;

layout(location = ${String(ATTRIBUTE_CORNER)}) in vec3 aCorner;
layout(location = ${String(ATTRIBUTE_FORM)}) in vec4 aForm;

// Vertex-stage only, deliberately: see the docblock. uBeat cannot reach a
// colour from here, which is what makes "no strobe" structural.
uniform highp float uTime;
uniform mediump float uBeat;
// Shared with the fragment shader — mediump in both, or this will not link.
uniform mediump float uIntensity;
uniform mediump vec2 uResolution;

uniform float uDrift;
uniform float uSway;
uniform float uFlow;

// Every varying carries an explicit precision, matching the fragment stage
// declaration for declaration. Precision is not part of the interface-matching
// rules for varyings the way it is for uniforms, so a mismatch here would link
// and then quantise on some drivers and not others — which is a worse bug than
// one that refuses to link.
out highp vec4 vFlowA;
out highp vec4 vFlowB;
out mediump vec2 vWater;
out mediump vec4 vForm;

const float kTau = 6.28318;
// Crossings per second at full drift. The near form takes ~29s to cross and
// the far one ~77s, and the user's intensity dial scales both down from
// there — "slow" in this scene means a period in tens of seconds.
const float kNearSpeed = 0.035;
const float kFarSpeed = 0.013;
// How far past the frame edge a form is parked before it wraps. The wrap has
// to happen entirely off-stage or it reads as a form vanishing.
const float kOffStage = 0.06;
const float kBob = ${glsl(BOB_AMPLITUDE)};
const float kLift = ${glsl(BEAT_LIFT)};
// ~11s for the ambient bob, ~4.6s for the flex. A body's movement, not a wave's.
const float kBobRate = 0.55;
const float kSwim = 1.35;
// Radians of caustic phase the beat is allowed to borrow, at full sway.
const float kBeatPhase = 0.35;
// How much of a far form survives the murk. Depth cue, and nearly free.
const float kFarFade = 0.4;

void main() {
  float role = aCorner.z;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  float phase = aForm.x;
  float halfSize = aForm.y;
  float depth = aForm.w;
  // Half-width in NDC, so the billboard is square in *pixels* on a portrait
  // panel rather than square in clip space, which would be a tall rectangle.
  float halfWidth = halfSize / max(aspect, 0.001);

  // Every motion term is scaled by uIntensity, so intensity 0 is a still
  // scene rather than a dark one: the water stays lit, the net stays where it
  // is, and nothing moves. Scaling the *rate* means dragging the dial steps
  // the phase — acceptable here precisely because that only happens under
  // somebody's finger, unlike a drift that would do it unprompted.
  float speed = mix(kNearSpeed, kFarSpeed, depth) * uDrift * uIntensity;
  // One direction for every form: this is a current, and forms crossing each
  // other in both directions is busier than the calm mode wants to be.
  float travel = fract(phase + uTime * speed);
  float margin = halfWidth + kOffStage;
  float centreX = mix(-1.0 - margin, 1.0 + margin, travel);

  // The two things the beat may move, both of them positions.
  float bob = sin(uTime * kBobRate * uIntensity + phase * kTau) * kBob * halfSize;
  float lift = uBeat * uSway * kLift * halfSize;

  vec2 billboard = vec2(
    centreX + aCorner.x * halfWidth,
    aForm.z + bob + lift + aCorner.y * halfSize);
  // role is exactly 0 or 1, so this is a select rather than a blend.
  vec2 ndc = mix(aCorner.xy, billboard, role);
  gl_Position = vec4(ndc, 0.0, 1.0);

  // The water field is evaluated in units where y spans -1..1 and x is scaled
  // to match, so the caustics are not stretched by the panel's shape. It is
  // linear in clip space, so the interpolator gives a billboard exactly the
  // background it is standing in front of — which is what lets an opaque quad
  // disappear against the water it overwrites.
  vWater = vec2(ndc.x * aspect, ndc.y);
  vForm = vec4(aCorner.xy, role, mix(1.0, kFarFade, depth));

  // Phases, integrated here and never rescaled downstream. Each rate is
  // incommensurate with the others so the field never returns to a previous
  // state — the failure mode is a net that visibly repeats, which is what
  // makes a screensaver read as a loop.
  float flow = uTime * uFlow * uIntensity;
  float nudge = uBeat * uSway * kBeatPhase;
  vFlowA = vec4(flow * 0.13 + nudge, flow * 0.11 - nudge, flow * 0.29, flow * 0.23);
  vFlowB = vec4(
    flow * 0.19,
    flow * 0.09,
    flow * 0.07,
    uTime * kSwim * uIntensity + phase * kTau);
}
`;

/**
 * `mediump`, because everything here is colour (`gl/README.md`).
 *
 * The exceptions are the two phase varyings, which are `highp` in both stages:
 * they grow without bound with uptime, and at `mediump` the whole scene would
 * stutter after a few minutes of playing.
 *
 * Note what is *absent*: no `uTime` and no `uBeat`. The stage that decides
 * every brightness in this scene cannot see the clock or the beat, so it can
 * neither drift on its own nor flash on a downbeat. That is the calm-mode
 * guarantee, expressed as a missing declaration rather than as a comment.
 */
const REEF_FRAGMENT = `#version 300 es
precision mediump float;

in highp vec4 vFlowA;
in highp vec4 vFlowB;
in mediump vec2 vWater;
in mediump vec4 vForm;

uniform sampler2D uArt;
uniform vec3 uAccent;
// Shared with the vertex shader — mediump in both, or this will not link.
uniform mediump float uIntensity;

uniform float uCaustics;
uniform float uRays;
uniform float uMurk;
uniform float uShade;
uniform float uTint;

out vec4 fragColour;

// Cells of caustic net across the height of the frame.
const float kNetScale = 3.4;
const float kWarpAmount = 0.28;
// The sun, above and slightly to one side of the frame. Off-centre because a
// centred light makes a symmetrical fan, which reads as a graphic rather than
// as a room.
const vec2 kLight = vec2(0.18, 1.55);
// How much of the cover the frame spans. Small: the album is being read as a
// palette moving through water, not displayed.
const float kArtScale = 0.24;
const float kNetGain = 0.42;
const float kRayGain = 0.26;
// What is left of the light inside a silhouette. Multiplicative, so a form can
// only ever take light away — it cannot brighten a pixel by any route.
const float kFormDarken = 0.22;

/**
 * One octave of the net: three sine sheets at incommensurate angles.
 *
 * Where the three cancel, the sum crosses zero and this peaks — a filament,
 * not a stripe. The fourth power is two multiplies rather than a pow(), and it
 * is what turns soft ridges into the thin bright net light actually makes.
 */
float sheet(vec2 p, vec3 phase) {
  float a = sin(p.x + phase.x);
  float b = sin(p.y * 1.13 + phase.y);
  float c = sin((p.x + p.y) * 0.79 + phase.z);
  float ridge = 1.0 - abs(a + b + c) * 0.3333;
  ridge *= ridge;
  return ridge * ridge;
}

void main() {
  vec2 p = vWater;

  // Domain warp: the water surface is not flat, so the net that reaches the
  // floor is not a grid. One sine and one cosine, at a lower spatial frequency
  // than the net itself.
  vec2 warp = vec2(sin(p.y * 1.7 + vFlowA.x), cos(p.x * 1.43 + vFlowA.y));
  vec2 w = p + warp * kWarpAmount;

  // Two octaves, hand-unrolled: there is no loop here at all, so there is no
  // bound to justify. Two is the count where the net stops reading as a single
  // frequency; a third costs another three sines and is invisible at this
  // contrast. The second octave reuses the *negated* phases, so it drifts the
  // other way and the two interfere rather than sliding together.
  vec3 phase = vec3(vFlowA.z, vFlowA.w, vFlowB.x);
  float net = sheet(w * kNetScale, phase) + 0.45 * sheet(w * kNetScale * 2.13, -phase);
  net *= 0.69;

  // A shaft, in screen space, knowing where the surface is: every ray from the
  // light is a level set of this ratio, so one divide replaces the radial blur
  // a post-process god-ray pass would need. Two sines of it at incommensurate
  // frequencies beat against each other into shafts of varying width.
  float fan = (p.x - kLight.x) / max(kLight.y - p.y, 0.35);
  float shaft = (sin(fan * 6.3 + vFlowB.y) * 0.5 + 0.5)
    * (sin(fan * 2.7 + vFlowB.z) * 0.5 + 0.5);
  shaft *= shaft;
  float rays = shaft * smoothstep(-1.35, 0.95, p.y);

  // The album is the light. The cover is sampled through the same warp that
  // bends the caustics, so what comes through the surface is the record,
  // refracted. Clamped rather than tiled: at this scale the frame maps well
  // inside the texture, and fract() would put a seam through the water.
  vec2 artUv = clamp(0.5 + w * kArtScale, 0.0, 1.0);
  vec3 lit = mix(uAccent, texture(uArt, artUv).rgb, uTint);

  // Deep water: the accent, nearly extinguished, with just enough blue left
  // that a red album does not make a red room. This is the floor of the whole
  // scene, and it is dark on purpose — a bright screen in a dark room at 1am
  // is the failure this mode exists to prevent.
  vec3 deep = uAccent * 0.07 + vec3(0.004, 0.016, 0.032);
  float extinction = mix(1.0, smoothstep(-1.15, 0.85, p.y), uMurk);
  // Intensity swells the light a little, but never to nothing: at 0 the water
  // is still lit and still coloured, it has simply stopped moving.
  float swell = 0.75 + 0.25 * uIntensity;

  vec3 colour =
    deep + lit * (net * kNetGain * uCaustics + rays * kRayGain * uRays) * extinction * swell;

  // The branch is uniform across each primitive — the water plane never takes
  // it, a billboard always does — so the frame pays for the form maths only
  // over the few percent of it a form covers.
  if (vForm.z > 0.5) {
    vec2 q = vForm.xy;
    // An original abstract form (D-015): a lens tapering to nothing at both
    // ends, with a camber that flexes slowly as it drifts. The 1.25 shrinks
    // the shape inside its quad so the soft edge finishes before the quad
    // boundary does — otherwise the tips would end on a hard cut.
    float taper = clamp(1.0 - q.x * q.x * 1.25, 0.0, 1.0);
    float camber = taper * (0.16 * q.x + 0.09 * sin(q.x * 2.4 + vFlowB.w));
    float thickness = taper * taper * 0.55;
    float mask = 1.0 - smoothstep(-0.05, 0.05, abs(q.y - camber) - thickness);
    colour *= mix(1.0, kFormDarken, mask * uShade * vForm.w);
  }

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * The reef.
 *
 * `depthTest: false` because the chain's targets have no depth attachment
 * (D-070) — asking for the test would be asking for something that silently
 * always passes. Order here is the lane invariant plus a far-to-near emission,
 * not a z-buffer.
 *
 * Every default is chosen for the 11pm case rather than the demo: the drift is
 * a crossing a minute, the caustics are the brightest thing on screen and still
 * only reach about half luminance, and `sway` — the one dial the beat touches —
 * defaults low.
 */
export const REEF_SCENE: SceneDefinition = {
  id: 'reef',
  vertex: REEF_VERTEX,
  fragment: REEF_FRAGMENT,
  geometry: REEF_MESH,
  depthTest: false,
  params: {
    /** How fast the silhouettes cross. 1 is ~29s near, ~77s far, at full intensity. */
    drift: { default: 1, min: 0, max: 4 },
    /** The only beat-bound dial: vertical nudge, and a caustic phase advance. */
    sway: { default: 0.35, min: 0, max: 1 },
    /** Rate of the caustic and shaft phases. 1 is a crawl; 3 is a ripple. */
    flow: { default: 1, min: 0, max: 3 },
    /** Strength of the caustic net. */
    caustics: { default: 0.7, min: 0, max: 1 },
    /** Strength of the shafts from the surface. */
    rays: { default: 0.55, min: 0, max: 1 },
    /** How fast the light is swallowed with depth. 0 is a swimming pool. */
    murk: { default: 0.75, min: 0, max: 1 },
    /** How dark the silhouettes are against the water. */
    shade: { default: 0.85, min: 0, max: 1 },
    /** How much of the light is the cover rather than the extracted accent. */
    tint: { default: 0.8, min: 0, max: 1 },
  },
};
