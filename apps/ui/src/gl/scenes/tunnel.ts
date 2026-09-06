/**
 * The tunnel scene — a PS1-era tube of ring geometry the camera flies down.
 *
 * P5-23 (geometry, camera, curve-with-near-fade) and P5-25 (album art as the
 * tunnel texture) live here; the post-stage PS1 artefacts live next door in
 * `effects/ps1.ts`. The split is not arbitrary, and getting it wrong is the
 * failure mode PS1_MODE.md's six artefacts are most exposed to — an artefact
 * implemented in the wrong stage either does nothing or cannot be switched
 * off:
 *
 * | # | Artefact              | Where it has to live                      |
 * |---|-----------------------|-------------------------------------------|
 * | 1 | Vertex snap           | this vertex shader — it moves vertices    |
 * | 2 | Affine texture map    | this vertex + fragment pair — it is what  |
 * |   |                       | the interpolator does between them        |
 * | 3 | 15-bit colour + dither| a post pass (`fifteenbit`)                |
 * | 4 | No z-buffer           | `depthTest: false` plus the back-to-front |
 * |   |                       | index order this file builds              |
 * | 5 | Distance fog          | this fragment shader — post has no depth  |
 * | 6 | 240p output           | a post pass (`twoforty`)                  |
 *
 * Ported from `spikes/n2o-tunnel/`, which proved all six in GLSL. What is new
 * here is the fit to the engine: no `uProj` (the uniform contract has no
 * matrix, so the projection is built in the shader from `uResolution`), no
 * face culling (`GlContext` cannot ask for it, so painter's ordering has to be
 * real), and the tiling is done with `fract` rather than by trusting the
 * sampler's wrap mode.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { SceneDefinition } from '../passes.js';

const TAU = Math.PI * 2;

export interface TunnelGeometryOptions {
  /** Ring pairs along the tube. There is one more ring than there are gaps. */
  readonly rings: number;
  /** Vertices around a ring. The seam vertex is duplicated, so this is gaps. */
  readonly segments: number;
  /** Copies of the cover around the circumference. Must be a whole number. */
  readonly repeatsAround: number;
  /** Copies of the cover between one ring and the next. Whole number. */
  readonly repeatsPerRing: number;
}

/**
 * 70 rings of 22 segments is the spike's mesh: ~1600 vertices, one draw call,
 * and a tube smooth enough that the flat shading reads as a cylinder rather
 * than as a prism. Four copies of the cover around and one per ring is what
 * made the art legible without becoming wallpaper.
 */
export const TUNNEL_GEOMETRY_OPTIONS: TunnelGeometryOptions = {
  rings: 70,
  segments: 22,
  repeatsAround: 4,
  repeatsPerRing: 1,
};

/** Attribute 0: the unit circle in `xy`, the ring index in `z`. */
export const ATTRIBUTE_RING = 0;
/** Attribute 1: the album-art UV for this vertex. */
export const ATTRIBUTE_UV = 1;

/**
 * A `Uint16Array` index buffer is what `GlContext.draw` binds, so a mesh whose
 * vertices do not fit in 16 bits would silently draw the wrong triangles.
 */
const MAX_VERTICES = 65536;

const whole = (value: number, minimum: number, name: string): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`tunnel ${name} must be a whole number >= ${String(minimum)}`);
  }
  return value;
};

/**
 * The ring mesh, as the buffers the pipeline uploads once at startup.
 *
 * **Why the repeats must be whole numbers.** The tube does not actually move:
 * the vertex shader scrolls it by `mod(time, one ring)` and lets the geometry
 * stand still, so once a ring's worth of travel has passed, ring `n` is drawn
 * where ring `n+1` was a moment ago. That substitution is invisible only if
 * consecutive rings carry the same texture content — i.e. only if the V step
 * between rings is a whole number of copies of the cover. The same argument
 * around the circumference makes the U span whole, so the duplicated seam
 * vertex at `segment === segments` lands on the same texel as `segment === 0`.
 * A fractional repeat would put a visible ratchet in the tunnel once a second,
 * which is exactly the kind of bug that gets blamed on the driver.
 *
 * **Why the indices run far ring first.** There is no depth buffer (artefact
 * 04) and `GlContext` has no face culling, so what is in front is decided
 * purely by draw order. Back-to-front is the painter's algorithm the PSX did
 * on the CPU; the sorting errors at glancing angles are the artefact, and they
 * only appear if the ordering is genuinely there to be wrong.
 */
export const buildTunnelGeometry = (
  options: TunnelGeometryOptions = TUNNEL_GEOMETRY_OPTIONS,
): GeometrySpec => {
  const rings = whole(options.rings, 1, 'rings');
  const segments = whole(options.segments, 3, 'segments');
  const repeatsAround = whole(options.repeatsAround, 1, 'repeatsAround');
  const repeatsPerRing = whole(options.repeatsPerRing, 1, 'repeatsPerRing');

  const perRing = segments + 1;
  const vertexCount = (rings + 1) * perRing;
  if (vertexCount > MAX_VERTICES) {
    throw new RangeError(
      `tunnel mesh needs ${String(vertexCount)} vertices, over 16 bits`,
    );
  }

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let ring = 0; ring <= rings; ring += 1) {
    for (let segment = 0; segment < perRing; segment += 1) {
      const vertex = ring * perRing + segment;
      const around = segment / segments;
      const angle = around * TAU;
      positions[vertex * 3] = Math.cos(angle);
      positions[vertex * 3 + 1] = Math.sin(angle);
      // The ring index rides in z and the shader turns it into a distance, so
      // scrolling costs one `mod` per vertex instead of a buffer upload.
      positions[vertex * 3 + 2] = ring;
      uvs[vertex * 2] = around * repeatsAround;
      uvs[vertex * 2 + 1] = ring * repeatsPerRing;
    }
  }

  const indices = new Uint16Array(rings * segments * 6);
  let cursor = 0;
  for (let ring = rings - 1; ring >= 0; ring -= 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const near = ring * perRing + segment;
      const far = near + perRing;
      indices[cursor] = near;
      indices[cursor + 1] = far;
      indices[cursor + 2] = near + 1;
      indices[cursor + 3] = near + 1;
      indices[cursor + 4] = far;
      indices[cursor + 5] = far + 1;
      cursor += 6;
    }
  }

  return {
    attributes: [
      { location: ATTRIBUTE_RING, size: 3, data: positions },
      { location: ATTRIBUTE_UV, size: 2, data: uvs },
    ],
    indices,
    count: indices.length,
  };
};

export const TUNNEL_MESH = buildTunnelGeometry();

/** z units between rings. The tube is this long, and the shader knows it. */
const RING_SPACING = 6;
const TUNNEL_DEPTH = TUNNEL_GEOMETRY_OPTIONS.rings * RING_SPACING;
/**
 * Fog reaches full strength before the last ring does. If it saturated exactly
 * at the end of the tube the far rim would still be visibly a rim; ending the
 * ramp early means the tunnel dissolves into haze and the mesh has no edge.
 */
const FOG_END = TUNNEL_DEPTH * 0.55;
/**
 * How far ahead the curve is allowed to start bending. The ring you are inside
 * must stay centred on the camera — otherwise the nearest geometry swims
 * sideways as the curve animates, which reads as a bug rather than as a bend.
 * The spike settled on ~12 rings for the ease.
 */
const CURVE_FADE = RING_SPACING * 12;

/**
 * Vertical field of view, in radians — 66 degrees, wide enough that the tube
 * fills a landscape panel without the fisheye a wider lens gives a cylinder.
 * The focal length is worked out here rather than in the shader so the source
 * carries a plain literal: a `tan()` in a `const` initialiser is legal ESSL
 * but not something to discover a compiler disagreeing about on the Pi.
 */
const CAMERA_FOV = 1.15;
const CAMERA_FOCAL = 1 / Math.tan(CAMERA_FOV / 2);

const glsl = (value: number): string => value.toFixed(1);

/**
 * `highp`, not the `mediump` the fragment shaders use. Positions run to ~420
 * units down the tube and the V coordinate to 70 copies of the cover; at
 * `mediump`'s ten-bit mantissa that is a quantisation of a tenth of a unit,
 * which would snap vertices and stagger the texture on hardware while looking
 * perfect on a desktop. Colour is `mediump`, geometry is not (`gl/README.md`).
 */
const TUNNEL_VERTEX = `#version 300 es
precision highp float;

layout(location = ${String(ATTRIBUTE_RING)}) in vec3 aRing;
layout(location = ${String(ATTRIBUTE_UV)}) in vec2 aUv;

// Explicitly mediump, not the file's highp default.
//
// A uniform used in both stages must carry the *same* precision in both, or
// the program fails to link — and the failure is a link error on real
// hardware, invisible to any headless test. The fragment shader below is
// mediump, so these are too; the file's highp default still governs the
// vertex-local position maths, which is why it is declared at all (positions
// run to ~420 units and V to 70 copies of the cover).
uniform mediump float uTime;
uniform mediump float uBeat;
uniform mediump float uIntensity;
uniform mediump vec2 uResolution;
uniform float uSpeed;
uniform float uRadius;
uniform float uPulse;
uniform float uCurve;
uniform float uSnap;
uniform float uAffine;

out vec2 vUv;
out float vW;
out float vDepth;
out float vRim;

const float kSpacing = ${glsl(RING_SPACING)};
const float kFogEnd = ${glsl(FOG_END)};
const float kCurveFade = ${glsl(CURVE_FADE)};
// A 66 degree vertical field of view, and a near plane close enough that the
// ring around the camera is not clipped away before the fade can centre it.
const float kFocal = ${CAMERA_FOCAL.toFixed(5)};
const float kNear = 0.5;
const float kFar = 500.0;
// Artefact 01: the GTE had no sub-pixel precision, so vertices landed on whole
// pixels. This is that grid in NDC — coarser than any resolution we render at,
// so the jitter survives the upscale instead of being lost in it.
const vec2 kSnapGrid = vec2(150.0, 90.0);

void main() {
  // The mesh never moves. Scrolling by one ring and wrapping is what lets a
  // fixed 70 rings be an endless tunnel — see buildTunnelGeometry for why the
  // texture has to be whole-numbered for the wrap to be invisible.
  float scroll = mod(uTime * uSpeed, 1.0) * kSpacing;
  float z = scroll - aRing.z * kSpacing;

  // The curve eases in from the camera outward. Bending the ring you are
  // standing inside would slide the near geometry across the screen.
  float ease = smoothstep(0.0, kCurveFade, -z);
  float curveX = sin(z * 0.028 + uTime * 0.45) * uCurve * ease;
  float curveY = cos(z * 0.019 + uTime * 0.33) * uCurve * 0.62 * ease;

  float radius = uRadius * (1.0 + uBeat * uIntensity * uPulse);
  vec3 world = vec3(aRing.x * radius + curveX, aRing.y * radius + curveY, z);

  // The projection is built here because the uniform contract carries no
  // matrix — and it costs less than one would: the camera never rotates, so
  // this is a scale and a depth remap rather than a full transform.
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec4 clip = vec4(
    world.x * kFocal / aspect,
    world.y * kFocal,
    ((kFar + kNear) * world.z + 2.0 * kFar * kNear) / (kNear - kFar),
    -world.z);

  // A ring exactly on the camera plane has w = 0, and one NaN vertex takes the
  // whole triangle with it. Nudging w off zero costs nothing and cannot be
  // seen: the geometry there is behind the near plane anyway.
  float w = clip.w < 0.0 ? min(clip.w, -0.001) : max(clip.w, 0.001);
  vec3 ndc = clip.xyz / w;
  vec2 snapped = floor(ndc.xy * kSnapGrid + 0.5) / kSnapGrid;
  ndc.xy = mix(ndc.xy, snapped, clamp(uSnap, 0.0, 1.0));
  gl_Position = vec4(ndc * w, w);

  // Artefact 02: perspective-correct interpolation computes
  // sum(Li*Vi/wi) / sum(Li/wi). Feeding it uv*w makes the numerator collapse
  // to sum(Li*uv_i), so dividing by the interpolated w in the fragment leaves
  // plain linear interpolation — affine, exactly as the PSX did it. uAffine=0
  // hands back the correct mapping without a branch.
  vW = mix(1.0, w, clamp(uAffine, 0.0, 1.0));
  vUv = aUv * vW;

  // Depth only. How much fog that becomes is a colour decision, so it is made
  // in the fragment shader where the fog amount is.
  vDepth = clamp(-z / kFogEnd, 0.0, 1.0);
  // Cheap cylindrical shading: the top and bottom of the tube face the light
  // and the sides fall away. One varying instead of a normal and a dot.
  vRim = abs(aRing.y) * 0.5 + 0.5;
}
`;

const TUNNEL_FRAGMENT = `#version 300 es
precision mediump float;

// highp on the UV pair alone: it carries up to 70 copies of the cover
// multiplied by w, and mediump would tear the texture into steps. Everything
// else here is colour, which is what mediump is for.
in highp vec2 vUv;
in highp float vW;
in float vDepth;
in float vRim;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform float uBeat;
uniform float uIntensity;
uniform float uFog;
uniform float uFlash;

out vec4 fragColour;

void main() {
  // fract() rather than a REPEAT sampler. The pipeline creates the album
  // texture clamped, and a clamped sampler would smear one edge texel down the
  // entire tube — a failure that only shows up on the device. fract() tiles
  // correctly under either wrap mode, so P5-25's sampler settings are an
  // improvement to the filtering rather than a load-bearing dependency.
  highp vec2 uv = fract(vUv / vW);
  vec3 colour = texture(uArt, uv).rgb * (0.55 + 0.55 * vRim);

  // Beat flash toward the cover's accent. P5-26 binds the amount.
  colour = mix(colour, uAccent, uBeat * uIntensity * uFlash);

  // Artefact 05: a short draw distance hidden behind coloured haze, tinted
  // from the album rather than from a constant so the tube belongs to the
  // record playing. Squared, because a linear ramp fogs the middle distance
  // far too early.
  vec3 fogColour = uAccent * 0.34 + vec3(0.02, 0.01, 0.06);
  colour = mix(colour, fogColour, clamp(uFog, 0.0, 1.0) * vDepth * vDepth);

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * The tube.
 *
 * `depthTest: false` is artefact 04 and not an oversight: the PSX had no depth
 * buffer and sorted polygons on the CPU, so surfaces punch through each other
 * at glancing angles. `buildTunnelGeometry` supplies the back-to-front order
 * that makes the rest of the tunnel read correctly anyway.
 *
 * Every parameter is either a shape control or one of the two beat-bound
 * modulations P5-26 needs (`pulse`, `flash`) — left here, at their spike
 * values, rather than invented there.
 */
export const TUNNEL_SCENE: SceneDefinition = {
  id: 'tunnel',
  vertex: TUNNEL_VERTEX,
  fragment: TUNNEL_FRAGMENT,
  geometry: TUNNEL_MESH,
  depthTest: false,
  params: {
    /** Rings travelled per second. Beat-bindable (P5-26). */
    speed: { default: 4.5, min: 0, max: 20 },
    radius: { default: 7, min: 1, max: 20 },
    /** How far the radius swells on a beat, as a fraction of it. */
    pulse: { default: 0.13, min: 0, max: 1 },
    curve: { default: 3, min: 0, max: 12 },
    /** Artefact 01. 0 turns the low-precision grid off entirely. */
    snap: { default: 1, min: 0, max: 1 },
    /** Artefact 02. 0 is a perspective-correct, modern-looking tunnel. */
    affine: { default: 1, min: 0, max: 1 },
    /** Artefact 05. */
    fog: { default: 1, min: 0, max: 1 },
    /** How far the beat pulls the tube toward the accent colour. */
    flash: { default: 0.3, min: 0, max: 1 },
  },
};
