/**
 * The terrain scene — a heightfield flown over, whose height *is* the album
 * cover's luminance.
 *
 * The point of this one is that the artwork is **data**, not wallpaper. Every
 * other scene and pass in the library treats the cover as an image to sample;
 * here it is a displacement map, and the bright parts of the sleeve are
 * mountains. A voxel-terrain flythrough is also squarely 1993-96 in idiom
 * (D-015: the era's idiom, none of its assets), which is the other half of why
 * it belongs.
 *
 * ## The three things that decide whether this works at all
 *
 * **1 · The displacement is a vertex texture fetch.** The height has to be
 * known before the vertex is placed, so the vertex shader samples `uArt`.
 * That is legal here for three separate reasons, and it is worth writing them
 * down because a vertex texture fetch is exactly the sort of thing that works
 * on every desktop and then does not work on the one device we care about:
 *
 *   - GLES 3.0 mandates `MAX_VERTEX_TEXTURE_IMAGE_UNITS >= 16`, so unlike
 *     GLES 2.0 (where the minimum was **zero**) the vertex stage is guaranteed
 *     to have samplers at all. Mesa V3D on the Pi 5 reports 16.
 *   - A sampler uniform is program-scoped, not stage-scoped. `pipeline.ts`
 *     binds the cover to texture unit 1 (`UNIT_ART`) and sets `uArt` to that
 *     unit with one `uniform1i` per program; declaring `uniform sampler2D
 *     uArt;` in the vertex shader reads that same binding. Nothing in the
 *     pipeline needed changing for this scene.
 *   - The cover texture is created `nearest`-filtered with no mipmaps, so it
 *     is mipmap-complete as it stands. That matters: a vertex fetch has no
 *     derivatives and samples level 0, and a texture whose min filter wanted
 *     mipmaps it did not have would sample **black** — a flat world with no
 *     error anywhere.
 *
 * **2 · A 256px cover is not a heightmap.** Point-sampled luminance off a
 * sleeve gives a flat, noisy field: covers live in the midtones, and a 96-wide
 * grid across a 256px image steps 2.7 texels per vertex, which is undersampling
 * — it reads the noise and misses the shape. Three things fix it, all in
 * `relief()` below:
 *
 *   - **A five-tap cross low-pass** at a settable span (`relief`), so the mesh
 *     averages the region it steps over instead of point-sampling it. The same
 *     four arms give the gradient for free, which is where the lighting comes
 *     from — the smoothing and the normal cost one set of taps between them.
 *   - **Contrast expansion** (`contrast`) around mid-grey, so a sleeve that
 *     occupies 0.35-0.65 of the range becomes a landscape that occupies all of
 *     it. The expansion is a hand-written smoothstep rather than the built-in
 *     so its derivative can be applied to the gradient too: shade the shape you
 *     made, not the one you were given.
 *   - **Tone, not luminance.** Rec. 601 luma puts a saturated blue sleeve at
 *     0.11 everywhere and flattens it into a plain, even though the eye sees
 *     plenty of structure. Mixing part-way toward HSV value keeps saturated
 *     colour as terrain.
 *
 * **3 · There is no depth buffer.** `createFramebuffer` in `gl-context.ts`
 * attaches colour only, and the scene always renders into one of the chain's
 * targets — so `depthTest: true` would enable a test against a buffer that is
 * not there, which is a silent no-op rather than an error. Occlusion therefore
 * has to be real draw order, exactly as it is for the tunnel (D-070). A
 * heightfield is the easy case: every cell occupies a disjoint slice of z, so
 * sorting by row is not an approximation, it is exact. Indices are emitted far
 * row first, which is also how the era's flight simulators did it.
 *
 * ## The wrap, and why the texture folds
 *
 * The mesh does not travel. It is scrolled by up to one cell and then recycled,
 * so row `n` is drawn where row `n+1` stood a moment ago — the tunnel's trick,
 * and the same proof obligation. See `buildTerrainGeometry`.
 *
 * The cover is *mirrored* rather than repeated when the UV leaves 0..1. Plain
 * repetition puts a cliff at every tile edge, and a cliff in a heightfield is a
 * wall across the landscape. Mirroring is C0-continuous: the worst it produces
 * is a crease, and a crease in terrain is a ridge line — a landform, not a
 * fault.
 *
 * ## What it costs
 *
 * 97 x 65 = 6305 vertices, 12288 triangles, one draw call, five vertex texture
 * fetches per vertex (~31.5k a frame, ~1.9M a second at 60fps). One texture
 * fetch and one `fwidth` pair per fragment. The grid is 96 x 64 cells because
 * at the half-resolution default a cell is ~9px at the fog line and ~30px at
 * the bottom of the screen — finer than the low-passed cover has detail to
 * fill. Doubling it would quadruple the vertex fetches to interpolate data the
 * artwork does not contain.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { SceneDefinition } from '../passes.js';

export interface TerrainGeometryOptions {
  /** Cells across the strip. There is one more column of vertices than cells. */
  readonly columns: number;
  /** Cells along the strip, from the camera to the horizon. */
  readonly rows: number;
  /**
   * Rows of terrain per copy of the cover. Must be a whole number — the scroll
   * wrap depends on it, see `buildTerrainGeometry`.
   */
  readonly rowsPerCover: number;
}

/**
 * 96 x 64 cells, and one copy of the cover per 96 rows.
 *
 * The cover therefore maps onto a **96 x 96 square of world**: it spans the
 * strip's full width across, and the same distance along. That isotropy is not
 * cosmetic — a cover stretched 2:1 in the direction of travel reads as smeared
 * rather than as landscape, and there is no way to un-see it once noticed.
 */
export const TERRAIN_GEOMETRY_OPTIONS: TerrainGeometryOptions = {
  columns: 96,
  rows: 64,
  rowsPerCover: 96,
};

/** Attribute 0: lateral world position in `x`, row index in `y`. */
export const ATTRIBUTE_CELL = 0;
/** Attribute 1: the album-art UV for this vertex, before the fold. */
export const ATTRIBUTE_UV = 1;

/**
 * `GlContext.draw` binds a `Uint16Array` index buffer, so a mesh whose vertices
 * do not fit in 16 bits would silently draw the wrong triangles.
 */
const MAX_VERTICES = 65536;

const whole = (value: number, minimum: number, name: string): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`terrain ${name} must be a whole number >= ${String(minimum)}`);
  }
  return value;
};

/**
 * The V distance after which the mirrored cover repeats exactly: two copies,
 * one of them flipped. The scroll wrap is only invisible on a multiple of it.
 */
export const MIRROR_PERIOD_COVERS = 2;

/** Rows of travel after which the landscape is identical to where it started. */
export const terrainWrapRows = (
  options: TerrainGeometryOptions = TERRAIN_GEOMETRY_OPTIONS,
): number => options.rowsPerCover * MIRROR_PERIOD_COVERS;

/**
 * The fold, in TypeScript — the exact twin of `mirrorUv` in both shaders.
 *
 * Exported because the wrap proof is arithmetic and belongs in a test rather
 * than in a screenshot: what has to hold is that shifting a coordinate by the
 * mirror period lands on the same texel, and that is a claim about this
 * function.
 */
export const mirrorCoordinate = (value: number): number => {
  const folded = ((value * 0.5) % 1) * 2;
  const wrapped = folded < 0 ? folded + 2 : folded;
  return 1 - Math.abs(wrapped - 1);
};

/**
 * The grid, as the buffers the pipeline uploads once at startup.
 *
 * **Why `rowsPerCover` must be a whole number.** The mesh stands still. The
 * vertex shader scrolls it by `fract(travel)` of a cell and adds
 * `floor(travel)` rows to the V coordinate, so a vertex always carries the
 * terrain at its true world distance and the recycling is exact rather than
 * approximate. What is *not* automatically exact is the wrap of `travel`
 * itself: it has to be taken modulo something, or after an hour it is a number
 * near 20000 whose fractional part quantises visibly even at `highp`. Taking it
 * modulo `2 * rowsPerCover` shifts V by exactly two covers, and two covers is
 * the mirror period — so the substitution is invisible. A fractional
 * `rowsPerCover` would put a jump in the landscape every time the counter
 * wrapped, which is the kind of bug that gets blamed on the driver.
 *
 * **Why the indices run far row first.** There is no depth attachment on the
 * chain's targets and `GlContext` has no face culling, so draw order is the
 * only thing deciding what is in front. Back-to-front by row is exact for a
 * heightfield: cells occupy disjoint slices of z, so no two of them can
 * legitimately swap places.
 */
export const buildTerrainGeometry = (
  options: TerrainGeometryOptions = TERRAIN_GEOMETRY_OPTIONS,
): GeometrySpec => {
  const columns = whole(options.columns, 2, 'columns');
  const rows = whole(options.rows, 2, 'rows');
  const rowsPerCover = whole(options.rowsPerCover, 1, 'rowsPerCover');

  const perRow = columns + 1;
  const vertexCount = perRow * (rows + 1);
  if (vertexCount > MAX_VERTICES) {
    throw new RangeError(
      `terrain mesh needs ${String(vertexCount)} vertices, over 16 bits`,
    );
  }

  const cells = new Float32Array(vertexCount * 2);
  const uvs = new Float32Array(vertexCount * 2);
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const vertex = row * perRow + column;
      // Cells are one world unit square, so the lateral coordinate is also the
      // column number the fragment shader draws its grid lines on.
      cells[vertex * 2] = column - columns * 0.5;
      cells[vertex * 2 + 1] = row;
      // U spans exactly one cover across the strip: no lateral tiling at all,
      // so no fold down the middle of the flight path to be symmetrical about.
      uvs[vertex * 2] = column / columns;
      uvs[vertex * 2 + 1] = row / rowsPerCover;
    }
  }

  const indices = new Uint16Array(rows * columns * 6);
  let cursor = 0;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = 0; column < columns; column += 1) {
      const near = row * perRow + column;
      const far = near + perRow;
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
      { location: ATTRIBUTE_CELL, size: 2, data: cells },
      { location: ATTRIBUTE_UV, size: 2, data: uvs },
    ],
    indices,
    count: indices.length,
  };
};

export const TERRAIN_MESH = buildTerrainGeometry();

/** World units per cell, both axes. One, so world x is also a column index. */
const CELL = 1;
const COVER_STEP = 1 / TERRAIN_GEOMETRY_OPTIONS.rowsPerCover;
const WRAP_ROWS = terrainWrapRows();
/** The strip is this deep; the far edge must be dissolved well before it. */
const MESH_DEPTH = TERRAIN_GEOMETRY_OPTIONS.rows * CELL;
/**
 * Fog saturates at 40 units, well inside the 64-unit strip, so the mesh's far
 * edge sits deep in haze rather than ending as a line. The last quarter is then
 * faded to black on top of that, because the sky is the cleared target and the
 * cleared target is black — a fog colour that stopped at full strength would
 * put a lit band against it with a hard top edge.
 */
const FOG_END = 40;
/**
 * Eye height above the mean terrain plane, and how far ahead the nearest row
 * sits. The offset is why this scene needs no guard against `w = 0`: no vertex
 * can reach the camera plane, because the nearest one is a cell in front of it.
 */
const EYE_HEIGHT = 5.5;
const NEAR_ROWS = 2;
/**
 * The horizon, as a shift of the principal point rather than a camera pitch.
 * Pitching the camera would keystone the grid; shifting clip `y` by a constant
 * multiple of `w` is a lens shift, so verticals stay vertical and the land
 * simply fills the lower two thirds of the panel.
 */
const HORIZON = 0.25;

/** 66 degrees vertical — wide enough to feel like flight, short of fisheye. */
const CAMERA_FOV = 1.15;
const CAMERA_FOCAL = 1 / Math.tan(CAMERA_FOV / 2);
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 500;

/**
 * The sun, normalised here rather than in a `const` initialiser: a built-in
 * call in a constant expression is legal ESSL and still not something to
 * discover a Mesa V3D disagreement about on the device. It sits behind and
 * above the camera, so slopes facing the viewer are the lit ones.
 */
const SUN = ((): readonly [number, number, number] => {
  const [x, y, z] = [-0.45, 0.78, 0.44];
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
})();

/** How far toward HSV value the height tone leans, away from Rec. 601 luma. */
const VALUE_MIX = 0.4;
/** Low-pass span, in UV, at `relief` 0 and 1: about 2 and 13 texels of a 256. */
const TAP_NARROW = 0.008;
const TAP_WIDE = 0.05;

const glsl = (value: number): string => value.toFixed(5);

/**
 * `highp`, not the `mediump` of the fragment stage. Positions run to 66 world
 * units, the travel counter to 192 rows, and the UV taps are fractions of a
 * 256px cover — at `mediump`'s ten-bit mantissa the taps would collapse onto
 * each other and the gradient with them.
 *
 * `uTime` in particular **must** be `highp` and must not be shared with the
 * fragment stage. A `mediump` clock quantises to about a second by the time a
 * track has been playing for twenty minutes, and the flight would start
 * stuttering forward in steps. It is declared here, used here, and absent from
 * the fragment shader, which is what makes that safe: only a uniform used in
 * *both* stages has to carry the same precision in both, and that is a link
 * error when it is violated (`precision.test.ts`).
 */
const TERRAIN_VERTEX = `#version 300 es
precision highp float;

layout(location = ${String(ATTRIBUTE_CELL)}) in vec2 aCell;
layout(location = ${String(ATTRIBUTE_UV)}) in vec2 aUv;

// The one uniform this scene reads in both stages, so it is pinned to the
// fragment shader's precision explicitly rather than inheriting highp here.
uniform mediump float uIntensity;

uniform float uTime;
uniform float uBeat;
uniform vec2 uResolution;
uniform sampler2D uArt;

uniform float uSpeed;
uniform float uHeight;
uniform float uContrast;
uniform float uRelief;
uniform float uPulse;

out vec2 vUv;
out vec2 vGrid;
out float vShade;
out float vAlt;
out float vDist;

const float kCell = ${glsl(CELL)};
const float kCoverStep = ${glsl(COVER_STEP)};
const float kWrapRows = ${glsl(WRAP_ROWS)};
const float kEye = ${glsl(EYE_HEIGHT)};
const float kNearRows = ${glsl(NEAR_ROWS)};
const float kHorizon = ${glsl(HORIZON)};
const float kFocal = ${glsl(CAMERA_FOCAL)};
const float kNear = ${glsl(CAMERA_NEAR)};
const float kFar = ${glsl(CAMERA_FAR)};
const float kValueMix = ${glsl(VALUE_MIX)};
const float kTapNarrow = ${glsl(TAP_NARROW)};
const float kTapWide = ${glsl(TAP_WIDE)};
const vec3 kSun = vec3(${glsl(SUN[0])}, ${glsl(SUN[1])}, ${glsl(SUN[2])});

// Mirror rather than repeat. Repetition puts a cliff at every tile edge and a
// cliff in a heightfield is a wall; this is continuous, and its worst artefact
// is a crease, which reads as a ridge.
vec2 mirrorUv(vec2 uv) {
  vec2 folded = fract(uv * 0.5) * 2.0;
  return 1.0 - abs(folded - 1.0);
}

// Height tone, not luminance. Rec. 601 puts a saturated blue sleeve at 0.11
// everywhere and turns it into a plain; leaning part-way toward HSV value keeps
// saturated colour as terrain.
float tone(vec2 uv) {
  vec3 art = texture(uArt, mirrorUv(uv)).rgb;
  float luma = dot(art, vec3(0.299, 0.587, 0.114));
  float value = max(max(art.r, art.g), art.b);
  return mix(luma, value, kValueMix);
}

// Five taps in a cross: the centre and four arms. The arms low-pass the cover
// so the mesh averages what it steps over rather than point-sampling 2.7 texels
// apart, and the same two differences are the gradient — so the normal costs
// nothing beyond the smoothing that was needed anyway.
vec3 relief(vec2 uv) {
  float span = mix(kTapNarrow, kTapWide, uRelief);
  float centre = tone(uv);
  float left = tone(uv - vec2(span, 0.0));
  float right = tone(uv + vec2(span, 0.0));
  float back = tone(uv - vec2(0.0, span));
  float front = tone(uv + vec2(0.0, span));
  float height = (centre * 2.0 + left + right + back + front) / 6.0;
  return vec3(height, (right - left) / (2.0 * span), (front - back) / (2.0 * span));
}

void main() {
  // Wrapped at two covers of travel, which is where the mirrored field repeats
  // exactly. Without the wrap the counter grows without bound and its
  // fractional part quantises after twenty minutes of playback.
  float travel = mod(uTime * uSpeed, kWrapRows);
  float row = aCell.y - fract(travel);
  float z = -(row + kNearRows) * kCell;
  // The whole-row part of the travel rides in V, so a recycled vertex picks up
  // the terrain of the row it has replaced instead of merely standing in for it.
  vec2 uv = vec2(aUv.x, aUv.y + floor(travel) * kCoverStep);

  vec3 field = relief(uv);

  // Contrast expansion around mid-grey, written out rather than called as
  // smoothstep so the same t can produce the derivative below.
  // 'half' is a reserved word in GLSL ES 3.00, hence the name.
  float reach = mix(0.5, 0.14, uContrast);
  float lo = 0.5 - reach;
  float t = clamp((field.x - lo) / (2.0 * reach), 0.0, 1.0);
  float shaped = t * t * (3.0 - 2.0 * t);
  // smoothstep's derivative. Shade the shape the expansion made, not the one it
  // was handed: without this the lighting is subtly out of step with the relief
  // and the peaks look painted on.
  float gain = 6.0 * t * (1.0 - t) / (2.0 * reach);

  // uIntensity at 0 is the calm floor: rolling hills, and no beat in them.
  // The beat moves the land rather than lighting it (D-071).
  float amplitude = uHeight * (0.45 + 0.55 * uIntensity);
  amplitude *= 1.0 + uBeat * uIntensity * uPulse;
  float height = (shaped - 0.5) * amplitude;

  // The cover maps onto a square of world, so one UV unit is kCoverStep of a
  // cell in both directions; V runs against z, hence the sign.
  float slopeX = amplitude * gain * field.y * kCoverStep / kCell;
  float slopeZ = -amplitude * gain * field.z * kCoverStep / kCell;
  vec3 normal = normalize(vec3(-slopeX, 1.0, -slopeZ));

  vec3 world = vec3(aCell.x * kCell, height - kEye, z);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec4 clip = vec4(
    world.x * kFocal / aspect,
    world.y * kFocal,
    ((kFar + kNear) * world.z + 2.0 * kFar * kNear) / (kNear - kFar),
    -world.z);
  // A lens shift, not a pitch: constant in NDC after the divide, so the grid
  // does not keystone and the horizon simply sits higher up the panel.
  clip.y += kHorizon * clip.w;
  gl_Position = clip;

  // Unmirrored on purpose. Folding here would fold *across* the triangle that
  // straddles the seam and flatten it; the fragment shader folds per pixel,
  // where it is exact.
  vUv = uv;
  vGrid = vec2(aCell.x, row);
  vShade = 0.30 + 0.85 * max(dot(normal, kSun), 0.0);
  vAlt = shaped;
  vDist = -z;
}
`;

const TERRAIN_FRAGMENT = `#version 300 es
precision mediump float;

// highp on the two coordinates that are folded or differentiated; everything
// else here is colour, which is what mediump is for.
in highp vec2 vUv;
in highp vec2 vGrid;
in float vShade;
in float vAlt;
in float vDist;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform vec3 uForeground;
uniform mediump float uIntensity;
uniform float uGrid;
uniform float uFog;

out vec4 fragColour;

const float kFogEnd = ${glsl(FOG_END)};
const float kMeshDepth = ${glsl(MESH_DEPTH)};

highp vec2 mirrorUv(highp vec2 uv) {
  highp vec2 folded = fract(uv * 0.5) * 2.0;
  return 1.0 - abs(folded - 1.0);
}

void main() {
  // The land wears the artwork it is shaped from. The fold's derivative jumps
  // at the crease, which would spike an implicit LOD — harmless here, because
  // the cover is nearest-filtered with no mipmaps to pick between.
  vec3 art = texture(uArt, mirrorUv(vUv)).rgb;
  vec3 colour = art * vShade;

  // An altitude ramp is what makes a heightfield read as landscape rather than
  // as a crumpled photograph: valleys sink toward the album's accent, peaks
  // catch the foreground the way a snow line does.
  colour = mix(colour * 0.55 + uAccent * 0.12, colour, smoothstep(0.0, 0.45, vAlt));
  colour = mix(colour, mix(colour, uForeground, 0.5), smoothstep(0.75, 1.0, vAlt));

  // Cell lines, analytically antialiased. fwidth is core in GLSL ES 3.00, and
  // the second term fades the grid out where a cell is smaller than a couple of
  // pixels — past that point lines cannot be drawn, only a solid wash.
  highp vec2 edge = abs(fract(vGrid - 0.5) - 0.5);
  highp vec2 width = fwidth(vGrid);
  vec2 line = 1.0 - smoothstep(vec2(0.0), width * 1.4, edge);
  float grid = max(line.x, line.y);
  grid *= 1.0 - smoothstep(0.25, 0.75, max(width.x, width.y));
  colour = mix(colour, uForeground, grid * uGrid * (0.35 + 0.65 * uIntensity));

  // Fog, squared, tinted from the record rather than from a constant. A linear
  // ramp fogs the middle distance far too early.
  float depth = clamp(vDist / kFogEnd, 0.0, 1.0);
  vec3 fogColour = uAccent * 0.3 + vec3(0.015, 0.01, 0.04);
  colour = mix(colour, fogColour, clamp(uFog, 0.0, 1.0) * depth * depth);

  // ...and then to black over the last quarter of the strip. The sky is the
  // cleared target, which is black, so this is what makes the mesh's far edge
  // stop being an edge instead of merely being hazy.
  colour *= 1.0 - smoothstep(0.75, 1.0, vDist / kMeshDepth);

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * The heightfield.
 *
 * `depthTest: false` for the reason in the file docblock: the chain's targets
 * have no depth attachment, so asking for the test would be a no-op that reads
 * like a guarantee. `buildTerrainGeometry` emits the back-to-front row order
 * that actually resolves occlusion, and for a heightfield that order is exact.
 */
export const TERRAIN_SCENE: SceneDefinition = {
  id: 'terrain',
  vertex: TERRAIN_VERTEX,
  fragment: TERRAIN_FRAGMENT,
  geometry: TERRAIN_MESH,
  depthTest: false,
  params: {
    /** Rows of terrain crossed per second. 6 is a walk over a 96-unit cover. */
    speed: { default: 6, min: 0, max: 30 },
    /** Peak-to-trough relief, in world units. The eye rides at 5.5. */
    height: { default: 6, min: 0, max: 20 },
    /** Midtone expansion. 0 is the sleeve's own range: flat and noisy. */
    contrast: { default: 0.7, min: 0, max: 1 },
    /** Low-pass span. 0 is crags off the cover's grain, 1 is rolling hills. */
    relief: { default: 0.45, min: 0, max: 1 },
    /** The cell lines. 0 is a solid landscape, 1 is a mapping-software wire. */
    grid: { default: 0.35, min: 0, max: 1 },
    /** Distance haze, tinted from the album. */
    fog: { default: 1, min: 0, max: 1 },
    /** How far the land swells on a beat, as a fraction of its height. */
    pulse: { default: 0.2, min: 0, max: 1 },
  },
};
