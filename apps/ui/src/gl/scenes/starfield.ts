/**
 * The starfield scene — the other canonical screensaver of the period, and the
 * one nobody owns.
 *
 * It predates every 90s screensaver anyone would name, which is exactly why it
 * is here: flying toasters and marching pipes are somebody's trademark, and a
 * starfield is an idea from the 1970s that everybody implemented (D-015 gets no
 * work to do for once). It is also the cheapest scene in the library, so the
 * savings are spent on the three things that separate a good one from a
 * screensaver: parallax, depth, and the album.
 *
 * ## Quads, not points
 *
 * `GlContext.draw` issues `drawArrays`/`drawElements` with `gl.TRIANGLES` and
 * nothing else — there is no `gl.POINTS` in the interface, and adding one would
 * mean editing the only file in this directory that touches WebGL. So each star
 * is two triangles. That is not the consolation prize it sounds like:
 * `gl_PointSize` is capped by the driver (V3D's ceiling is small), point sprites
 * cannot be stretched into a streak, and the quad's local coordinate is a free
 * varying to shape the star with. Four vertices a star is 4096 vertices total,
 * which is a rounding error against the terrain scene next door.
 *
 * ## How the album participates
 *
 * A generic starfield is a screensaver; this one has to be *this record's*
 * starfield. The mesh is a **32 x 32 lattice**, and each star samples the cover
 * at its own place in that lattice — so the field is a 32 x 32 point sampling of
 * the artwork, one star per 8 x 8 block of a 256px sleeve, scattered through
 * depth and flown through. Two things come out of that sample:
 *
 *   - **Colour** (`tint`). The star takes the *hue* of its block, normalised by
 *     the block's own peak channel so a dark sleeve gives dark-hued stars rather
 *     than invisible ones. A duotone cover gives a two-tone field; a warm sleeve
 *     gives a warm one. A black block falls back to white, which is also what
 *     happens before any art has loaded — the pipeline binds a 1x1 black texture
 *     then, and a field of white stars is the right thing to show.
 *   - **Visible density** (`density`). The block's luminance weights how bright
 *     its star is, so a high-contrast sleeve gives a sparse field of bright
 *     stars and a bright sleeve gives a dense even one. It is weighting rather
 *     than spawning because the mesh is built by a pure function that has never
 *     seen the artwork — the GPU has it, the generator does not — and what the
 *     eye reads as density is which stars are visible anyway.
 *
 * ## Depth, and why the generator stratifies it
 *
 * Uniform random depth clumps: with 1024 samples the gaps and clusters are
 * visible as sheets of stars arriving together. Depths are therefore stratified
 * — one per 1/1024 slice — and then **shuffled** against the lattice order, so
 * depth carries no correlation with screen position. Without the shuffle the
 * field is a diagonal sheet, which is the one arrangement that looks obviously
 * generated.
 *
 * ## The beat streaks, it does not flash
 *
 * D-071 caps beat-driven luminance globally, so the beat here elongates each
 * star along its radial direction — the warp streak — rather than brightening
 * it. The colour is divided by the square root of the stretch, so a streaked
 * star puts roughly the same light on the panel as an unstreaked one: the beat
 * is motion, and the photosensitivity argument never comes near it.
 *
 * ## What it costs
 *
 * 1024 stars: 4096 vertices, 2048 triangles, 6144 indices, one draw call, one
 * vertex texture fetch per vertex and **none** per fragment. Fragment work is a
 * length, two smoothsteps and a mix over a few hundred small quads — well under
 * a full screen of overdraw even with near stars streaked.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { SceneDefinition } from '../passes.js';

export interface StarfieldGeometryOptions {
  /** Stars per side of the jittered lattice. The field holds this squared. */
  readonly lattice: number;
  /** Parallax layers. Each gets its own speed, size and brightness. */
  readonly layers: number;
  /** Seed for the jitter and the shuffle. The mesh is otherwise identical. */
  readonly seed: number;
}

/**
 * 32 x 32 = 1024 stars, three layers.
 *
 * The lattice size is doing double duty: it is the star count *and* the
 * resolution at which the cover is sampled. 32 across a 256px sleeve is one
 * star per 8 x 8 block — coarse enough that neighbouring stars differ, fine
 * enough that the field carries the artwork's colour distribution rather than
 * four smeared averages of it.
 */
export const STARFIELD_GEOMETRY_OPTIONS: StarfieldGeometryOptions = {
  lattice: 32,
  layers: 3,
  seed: 0x5eed57a2,
};

/** Attribute 0: field position in `xy`, depth phase in `z`, layer in `w`. */
export const ATTRIBUTE_STAR = 0;
/** Attribute 1: which corner of the star's quad this vertex is, in -1..1. */
export const ATTRIBUTE_CORNER = 1;

/**
 * The four corners, in the order the index buffer below assumes. Two triangles
 * wound the same way — there is no face culling in `GlContext`, so winding is
 * not load-bearing today; it is kept consistent so that turning culling on
 * later is a one-line change rather than a hunt.
 */
export const STAR_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/** `GlContext.draw` binds a `Uint16Array`, so the mesh must fit in 16 bits. */
const MAX_VERTICES = 65536;

const whole = (value: number, minimum: number, name: string): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `starfield ${name} must be a whole number >= ${String(minimum)}`,
    );
  }
  return value;
};

/**
 * mulberry32 — small, fast, and above all *deterministic*.
 *
 * The mesh is built once at startup and asserted against in tests, so the field
 * has to be the same field every run. `Math.random()` would make every test of
 * the distribution a flake waiting for a bad seed.
 */
const randomFrom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * A shuffled 0..count-1, Fisher-Yates against the same stream.
 *
 * This is what decorrelates depth and layer from lattice position. Straight
 * `index / count` depth over a lattice puts the field on a diagonal plane, and
 * `index % layers` stripes the parallax layers across the sky.
 */
const shuffledOrder = (count: number, random: () => number): readonly number[] => {
  const order = Array.from({ length: count }, (_unused, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = order[index] ?? index;
    order[index] = order[swap] ?? swap;
    order[swap] = held;
  }
  return order;
};

/**
 * The field, as the buffers the pipeline uploads once at startup.
 *
 * Positions are a **jittered lattice** rather than uniform random: with a
 * thousand samples, uniform random leaves clumps and holes big enough to see,
 * and a jittered lattice is the cheapest blue-noise-ish alternative there is.
 * It also gives the cover sampling above its regular grid for free.
 *
 * Depth is stratified across 0..1 and shuffled, so the field is evenly occupied
 * at every distance and no sheet of stars arrives at once.
 */
export const buildStarfieldGeometry = (
  options: StarfieldGeometryOptions = STARFIELD_GEOMETRY_OPTIONS,
): GeometrySpec => {
  const lattice = whole(options.lattice, 2, 'lattice');
  const layers = whole(options.layers, 1, 'layers');
  const stars = lattice * lattice;
  const vertexCount = stars * STAR_CORNERS.length;
  if (vertexCount > MAX_VERTICES) {
    throw new RangeError(
      `starfield mesh needs ${String(vertexCount)} vertices, over 16 bits`,
    );
  }

  const random = randomFrom(options.seed);
  const order = shuffledOrder(stars, random);

  const positions = new Float32Array(vertexCount * 4);
  const corners = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array(stars * 6);
  for (let star = 0; star < stars; star += 1) {
    const column = star % lattice;
    const row = Math.floor(star / lattice);
    // -1..1 across the field. The same coordinate, remapped to 0..1, is where
    // this star reads the album cover.
    const x = ((column + random()) / lattice) * 2 - 1;
    const y = ((row + random()) / lattice) * 2 - 1;
    const slot = order[star] ?? star;
    const depth = (slot + random()) / stars;
    const layer = slot % layers;

    for (let corner = 0; corner < STAR_CORNERS.length; corner += 1) {
      const vertex = star * STAR_CORNERS.length + corner;
      const offset = STAR_CORNERS[corner] ?? [0, 0];
      positions[vertex * 4] = x;
      positions[vertex * 4 + 1] = y;
      positions[vertex * 4 + 2] = depth;
      positions[vertex * 4 + 3] = layer;
      corners[vertex * 2] = offset[0];
      corners[vertex * 2 + 1] = offset[1];
    }

    const base = star * STAR_CORNERS.length;
    const cursor = star * 6;
    indices[cursor] = base;
    indices[cursor + 1] = base + 1;
    indices[cursor + 2] = base + 2;
    indices[cursor + 3] = base + 2;
    indices[cursor + 4] = base + 1;
    indices[cursor + 5] = base + 3;
  }

  return {
    attributes: [
      { location: ATTRIBUTE_STAR, size: 4, data: positions },
      { location: ATTRIBUTE_CORNER, size: 2, data: corners },
    ],
    indices,
    count: indices.length,
  };
};

export const STARFIELD_MESH = buildStarfieldGeometry();

/** Nearest and furthest a star gets, in the same units `spread` is in. */
const FIELD_NEAR = 0.6;
const FIELD_RANGE = 26;
/** 66 degrees vertical, the same lens the terrain and the tunnel fly behind. */
const CAMERA_FOV = 1.15;
const CAMERA_FOCAL = 1 / Math.tan(CAMERA_FOV / 2);
const LAYERS = STARFIELD_GEOMETRY_OPTIONS.layers;

const glsl = (value: number): string => value.toFixed(5);

/**
 * `highp`. Two reasons, and both are about the clock rather than the geometry:
 * `uTime` is unbounded, and a `mediump` clock quantises to about a second after
 * twenty minutes of playback — the field would advance in visible jerks. The
 * twinkle's hash needs the range too.
 *
 * `uTime` is deliberately *not* declared in the fragment shader. Only a uniform
 * used in both stages has to carry the same precision in both, and violating
 * that is a link failure rather than a compile error (`precision.test.ts`), so
 * the fewer uniforms cross the seam the better. `uIntensity` is the only one
 * that does here, and it is pinned to `mediump` on both sides.
 */
const STARFIELD_VERTEX = `#version 300 es
precision highp float;

layout(location = ${String(ATTRIBUTE_STAR)}) in vec4 aStar;
layout(location = ${String(ATTRIBUTE_CORNER)}) in vec2 aCorner;

// Explicitly mediump, to match the fragment shader that also reads it.
uniform mediump float uIntensity;

uniform float uTime;
uniform float uBeat;
uniform vec2 uResolution;
uniform sampler2D uArt;

uniform float uSpeed;
uniform float uSpread;
uniform float uSize;
uniform float uParallax;
uniform float uWarp;
uniform float uTint;
uniform float uDensity;

out vec3 vColour;
out vec2 vLocal;

const float kNear = ${glsl(FIELD_NEAR)};
const float kRange = ${glsl(FIELD_RANGE)};
const float kFocal = ${glsl(CAMERA_FOCAL)};
const float kLayerSpan = ${glsl(LAYERS - 1)};

void main() {
  // Layer 0 is the far, slow, small one; the last is near, fast and bright.
  // Perspective already gives size and brightness by distance — what the layers
  // add is separation in *rate*, which is what still reads as depth on a panel
  // seen from two metres, where a size difference is a pixel.
  float layer = aStar.w / max(kLayerSpan, 1.0);
  float rate = mix(1.0 - 0.55 * uParallax, 1.0 + 0.75 * uParallax, layer);
  float bulk = mix(0.7, 1.35, layer);

  // mod() inside, fract() outside. Both are needed: mod keeps the argument
  // small, which is what stops the phase quantising after an hour of playback,
  // and fract is what recycles a star that has passed the camera to the back of
  // the field. uIntensity at 0 leaves a slow drift rather than a frozen sky.
  float advance = uSpeed * (0.35 + 0.65 * uIntensity) * rate;
  float depth = fract(aStar.z - mod(uTime * advance, 1.0));
  float distance = kNear + depth * kRange;

  // The star's own block of the cover: a 32 x 32 lattice over the sleeve.
  vec3 art = texture(uArt, aStar.xy * 0.5 + 0.5).rgb;
  float peak = max(max(art.r, art.g), art.b);
  // Hue, not colour: dividing by the peak channel keeps a dark block's star
  // visible. A black block — and the 1x1 black texture bound before any art has
  // loaded — falls back to white, which is what a starfield should look like.
  vec3 hue = peak > 0.004 ? art / peak : vec3(1.0);
  float luma = dot(art, vec3(0.299, 0.587, 0.114));
  vec3 tint = mix(vec3(1.0), hue, uTint);
  float weight = mix(1.0, 0.3 + 0.7 * luma, uDensity);

  // Fade at both ends of the wrap, or stars pop into existence at the far plane
  // and swell into blobs as they pass the near one.
  float fade = smoothstep(0.0, 0.1, depth) * (1.0 - smoothstep(0.86, 1.0, depth));
  float twinkle = fract(sin(dot(aStar.xy, vec2(12.9898, 78.233))) * 43758.5453);
  // Slow, shallow and *not* beat-locked: a tenth of a stop at a third of a hertz
  // is life, not a flash.
  float shimmer = 1.0 + 0.12 * sin(uTime * 0.8 + twinkle * 6.2831853);

  // The perspective divide is done here rather than by the rasteriser, so the
  // quad is built in screen space around an already-projected centre. A star is
  // always square-on to the camera; there is nothing to orient.
  vec2 view = aStar.xy * uSpread * kFocal / distance;
  float radius = length(view);
  // Radially outward, with a defined answer at the vanishing point.
  vec2 along = radius > 0.0001 ? view / radius : vec2(0.0, 1.0);
  vec2 across = vec2(-along.y, along.x);

  float stretch = 1.0 + uWarp * uBeat * uIntensity * 7.0;
  float size = uSize * bulk / distance;
  vec2 corner = across * (aCorner.x * size) + along * (aCorner.y * size * stretch);

  vec2 point = view + corner;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // No depth buffer on the chain's targets and nothing to sort against, so z is
  // 0 and w is 1: this vertex is already where it belongs.
  gl_Position = vec4(point.x / aspect, point.y, 0.0, 1.0);

  float bright = mix(0.35, 1.0, 1.0 - depth) * fade * weight * shimmer;
  // A streak spreads one star's light over more pixels. Dividing by the root of
  // the stretch keeps roughly that much light on the panel, so the beat reads as
  // movement and never as a flash (D-071).
  vColour = tint * bright / sqrt(stretch);
  vLocal = aCorner;
}
`;

const STARFIELD_FRAGMENT = `#version 300 es
precision mediump float;

in vec3 vColour;
in vec2 vLocal;

uniform vec3 uAccent;
uniform mediump float uIntensity;
uniform float uGlow;

out vec4 fragColour;

void main() {
  float radius = length(vLocal);

  // Nothing is cut out of the quad — the engine bans the keyword that would do
  // it, and it costs early-z on tiled hardware anyway — and the scene stage
  // draws unblended. So the quad's corners have to *be* the background, and
  // they are: the falloff reaches zero inside the inscribed circle and the
  // pipeline clears the target to black. The cost of
  // that is an occasional bite where two quads overlap, which is a pixel or two
  // and cannot be sorted away: the stars' depth order changes every frame and
  // the index buffer is uploaded once.
  float core = 1.0 - smoothstep(0.0, mix(0.35, 0.7, uGlow), radius);
  float skirt = 1.0 - smoothstep(0.0, 1.0, radius);

  // The core is the star's own colour; the skirt is pulled toward the album's
  // accent and scaled by the star's own brightness, so a near star has a halo
  // and a far one does not suddenly acquire one.
  float bright = max(max(vColour.r, vColour.g), vColour.b);
  vec3 halo = mix(vColour, uAccent * bright, 0.65);
  vec3 colour =
    vColour * core * core +
    halo * skirt * skirt * skirt * uGlow * (0.25 + 0.75 * uIntensity);

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * The field.
 *
 * `depthTest: false` because the chain's render targets carry no depth
 * attachment — `createFramebuffer` attaches colour only — so the test would be
 * a silent no-op rather than a guarantee. Stars are unsorted for the reason in
 * the fragment shader, and at this size it costs a pixel.
 */
export const STARFIELD_SCENE: SceneDefinition = {
  id: 'starfield',
  vertex: STARFIELD_VERTEX,
  fragment: STARFIELD_FRAGMENT,
  geometry: STARFIELD_MESH,
  depthTest: false,
  params: {
    /** Field lengths per second. 0.08 crosses the field in twelve seconds. */
    speed: { default: 0.08, min: 0, max: 1 },
    /** How wide the field is thrown. Low is a tight tunnel of stars. */
    spread: { default: 5, min: 1, max: 12 },
    /** Star size at unit distance. A mid-depth star is a couple of pixels. */
    size: { default: 0.2, min: 0.05, max: 0.6 },
    /** Rate separation between the layers. 0 is one uniform field. */
    parallax: { default: 0.6, min: 0, max: 1 },
    /** How far a beat streaks a star along its own direction of travel. */
    warp: { default: 0.5, min: 0, max: 1 },
    /** How much of a star's colour comes from the cover. 0 is white stars. */
    tint: { default: 0.85, min: 0, max: 1 },
    /** How hard the cover's luminance decides which stars read as present. */
    density: { default: 0.5, min: 0, max: 1 },
    /** The accent-tinted halo around each star. */
    glow: { default: 0.4, min: 0, max: 1 },
  },
};
