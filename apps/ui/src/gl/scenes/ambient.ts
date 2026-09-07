/**
 * The `ambient` scene — a few solids turning slowly on a field of album art.
 *
 * P5-35, and the stage the `PLUS!` theme sits on (THEMES.md). The mid-90s
 * desktop screensaver look is specific: a *small number* of convex solids,
 * flat-shaded with hard facet edges, rotating on their own axes and drifting
 * across a dark field. The technique — rotating solids on black — predates all
 * of those screensavers and belongs to nobody, which is what makes it usable
 * under D-015; nothing here reproduces anyone's content, logo or wordmark.
 *
 * It is also the scene that proves the pipeline can draw **actual meshes with
 * hidden surfaces**, where `tunnel` proves it can draw one big tube and `flat`
 * proves nothing at all. That turned out to be the whole design problem:
 *
 * **There is no depth buffer.** `GlContext.createFramebuffer` attaches a
 * colour texture and nothing else (`gl-context.ts`), so every render target in
 * the chain is colour-only. `setDepthTest(true)` against a framebuffer with no
 * depth attachment behaves as if the test always passes — it is not a
 * z-buffer, it is a no-op that *looks* like one. `GlContext` has no face
 * culling either. So `depthTest: false` here is a statement of fact rather
 * than an aesthetic choice like the tunnel's (PS1 artefact 04), and the scene
 * has to solve hidden surfaces itself. It does it twice, exactly:
 *
 *  - **Within a solid**, by rejecting back faces in the vertex shader: each
 *    vertex carries its face's plane (normal + offset), the shader works out
 *    which side of that plane the camera is on, and pushes the whole triangle
 *    outside the clip volume when it faces away. For a *convex* solid the
 *    front-facing set never overlaps itself, so this is exact — not an
 *    approximation of culling, the real thing. The test is per face rather
 *    than per vertex, so a face near the silhouette cannot be half-culled into
 *    a stretched sliver.
 *  - **Between solids**, by the painter's algorithm with an ordering that
 *    cannot go stale: every solid keeps a **fixed depth**, drifting only in x
 *    and y, and `buildAmbientGeometry` emits them far-to-near and refuses a
 *    roster whose depth spans could ever touch. Two spheres separated along
 *    the view axis have a separating plane perpendicular to it with the camera
 *    on the near one's side, so far-first is correct for every frame, at every
 *    angle, forever. Solids that could interpenetrate in depth are a build
 *    error, not a z-fight to discover on the panel.
 *
 * **The album is the source, twice over.** A Plus! theme was wallpaper *and*
 * screensaver, so this is both: the field behind the solids is the cover
 * itself, dimmed and slowly parallaxed (`backdrop`), and each facet is a crop
 * of the same cover at full brightness, lit by a fixed key light and pushed
 * toward the cover's accent in shadow (`tint`). The solids read as lit panes
 * of the field they drift across, which is a stronger use of the artwork than
 * texturing them alone would be — and it means a dark, quiet sleeve gives a
 * dark, quiet scene rather than a generic solid-rotator with a picture on it.
 *
 * **Cost.** 100 vertices, 42 triangles, one draw call. Fill is one full-screen
 * textured quad for the field plus whatever the solids cover — roughly 1.2
 * screens of textured fragments, no dependent reads, no loops. It is the
 * cheapest scene in the engine after `flat`.
 */
import type { GeometrySpec } from '../gl-context.js';
import type { SceneDefinition } from '../passes.js';

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];

/* ------------------------------------------------------------------ */
/* Small vector maths, kept local                                      */
/* ------------------------------------------------------------------ */

const at = <T>(list: readonly T[], index: number, what: string): T => {
  const found = list[index];
  if (found === undefined) throw new RangeError(`${what}: no element ${String(index)}`);
  return found;
};

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/**
 * Throws rather than returning a zero vector: a normalise that quietly gives
 * back `[NaN, NaN, NaN]` puts one NaN in a buffer and takes every triangle
 * touching it off the screen, with nothing anywhere saying why.
 */
const normalise = (a: Vec3, what: string): Vec3 => {
  const size = Math.hypot(a[0], a[1], a[2]);
  if (!(size > 1e-9)) throw new RangeError(`${what} has no direction to normalise`);
  return [a[0] / size, a[1] / size, a[2] / size];
};

/* ------------------------------------------------------------------ */
/* The solids                                                          */
/* ------------------------------------------------------------------ */

export type SolidKind = 'tetrahedron' | 'cube' | 'octahedron';

export interface SolidShape {
  /**
   * Corners **on the unit sphere**. Every solid having circumradius 1 is what
   * makes a placement's `radius` its true bounding radius in world units — and
   * a bounding radius that does not change as the solid turns is what lets the
   * depth-separation check below be a build-time guarantee rather than a hope.
   */
  readonly vertices: readonly Vec3[];
  /** Each face as a cycle of corner indices, in either winding. */
  readonly faces: readonly (readonly number[])[];
}

/** `1/sqrt(3)`: a cube corner at `(±1, ±1, ±1)` pulled onto the unit sphere. */
const CUBE_CORNER = 1 / Math.sqrt(3);

const CUBE: SolidShape = {
  vertices: [
    [-CUBE_CORNER, -CUBE_CORNER, -CUBE_CORNER],
    [CUBE_CORNER, -CUBE_CORNER, -CUBE_CORNER],
    [CUBE_CORNER, CUBE_CORNER, -CUBE_CORNER],
    [-CUBE_CORNER, CUBE_CORNER, -CUBE_CORNER],
    [-CUBE_CORNER, -CUBE_CORNER, CUBE_CORNER],
    [CUBE_CORNER, -CUBE_CORNER, CUBE_CORNER],
    [CUBE_CORNER, CUBE_CORNER, CUBE_CORNER],
    [-CUBE_CORNER, CUBE_CORNER, CUBE_CORNER],
  ],
  // Cycles, not windings: `tessellateSolid` decides which way round each one
  // goes from the geometry, so a hand-written table cannot get it wrong.
  faces: [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ],
};

const TETRAHEDRON: SolidShape = {
  vertices: [
    [CUBE_CORNER, CUBE_CORNER, CUBE_CORNER],
    [CUBE_CORNER, -CUBE_CORNER, -CUBE_CORNER],
    [-CUBE_CORNER, CUBE_CORNER, -CUBE_CORNER],
    [-CUBE_CORNER, -CUBE_CORNER, CUBE_CORNER],
  ],
  faces: [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 3, 2],
  ],
};

const OCTAHEDRON: SolidShape = {
  vertices: [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  faces: [
    [0, 2, 4],
    [2, 1, 4],
    [1, 3, 4],
    [3, 0, 4],
    [2, 0, 5],
    [1, 2, 5],
    [3, 1, 5],
    [0, 3, 5],
  ],
};

export const SOLID_SHAPES: Readonly<Record<SolidKind, SolidShape>> = {
  tetrahedron: TETRAHEDRON,
  cube: CUBE,
  octahedron: OCTAHEDRON,
};

/**
 * How much of the cover one facet shows, as a fraction of the square.
 *
 * Under 1 for two reasons: the album texture is created clamped by the
 * pipeline, so a facet whose UVs reach exactly 0 or 1 samples the edge texel
 * and picks up whatever bilinear does at the border; and leaving the sleeve's
 * own edge inside the facet is what makes it read as a picture on a face
 * rather than as a wall of colour.
 */
const FACE_FILL = 0.92;

export interface SolidMesh {
  readonly positions: readonly Vec3[];
  /** Per vertex, its **face's** normal — one per face, never averaged. */
  readonly normals: readonly Vec3[];
  /** Per vertex, its face's plane offset: `dot(normal, any point on it)`. */
  readonly offsets: readonly number[];
  readonly uvs: readonly Vec2[];
  readonly indices: readonly number[];
}

/**
 * A shape's faces, as buffers — the arithmetic the whole scene rests on.
 *
 * **Vertices are shared inside a face and never across one.** That is what
 * flat shading *is*: a corner of a cube belongs to three faces with three
 * different normals, so it has to exist three times. A mesh with one shared
 * corner cannot have a hard edge there, and the result is a soft, smooth,
 * wrong-looking solid that no shader parameter can fix — so the test file
 * asserts the duplication rather than trusting this comment.
 *
 * **The winding is computed, not declared.** Each face's cycle is taken in
 * whatever order the table gives, and reversed if its normal points inward.
 * Hand-written winding tables are the classic source of one face of a solid
 * being inside-out; here it is arithmetic, and the solid being convex and
 * centred on the origin is the only thing that has to be true.
 *
 * **The plane offset is what the back-face rejection needs.** Every point of a
 * planar face satisfies `dot(normal, p) = offset`, so the shader can decide
 * which side of the face the camera is on with one dot product and no extra
 * geometry — and, crucially, gets the *same answer for all three vertices of
 * a triangle*, so a face is never half-culled.
 *
 * **UVs are a planar projection of the face**, built from a right-handed basis
 * around its normal, so the cover appears the right way round on every face
 * rather than mirrored on half of them, and centred whatever the face's shape.
 */
export const tessellateSolid = (shape: SolidShape): SolidMesh => {
  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const offsets: number[] = [];
  const uvs: Vec2[] = [];
  const indices: number[] = [];

  for (const face of shape.faces) {
    if (face.length < 3) throw new RangeError('a face needs at least three corners');
    const corners = face.map((index) => at(shape.vertices, index, 'solid corner'));

    const centre = corners.reduce<Vec3>(
      (sum, corner) => [
        sum[0] + corner[0] / corners.length,
        sum[1] + corner[1] / corners.length,
        sum[2] + corner[2] / corners.length,
      ],
      [0, 0, 0],
    );

    const a = at(corners, 0, 'face corner');
    const raw = normalise(
      cross(subtract(at(corners, 1, 'face corner'), a), subtract(centre, a)),
      'face normal',
    );
    // Outward is the direction that agrees with the face's own centre, because
    // the solid is convex and centred on the origin. If the table wound the
    // cycle the other way, reverse the cycle rather than only the normal —
    // the UVs and the triangle fan both follow the cycle.
    const outward = dot(raw, centre) >= 0;
    const cycle = outward ? corners : [...corners].reverse();
    const normal = outward ? raw : negate(raw);
    const offset = dot(normal, centre);
    if (!(offset > 0)) {
      throw new RangeError('a face passes through the origin — the solid is not convex');
    }

    // A right-handed basis around the normal: seen from outside the solid the
    // cover is upright and unmirrored. `up` swaps axes near the poles, where
    // the obvious choice degenerates.
    const up: Vec3 = Math.abs(normal[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const tangent = normalise(cross(up, normal), 'face tangent');
    const bitangent = cross(normal, tangent);

    const flat = cycle.map((corner): Vec2 => {
      const local = subtract(corner, centre);
      return [dot(local, tangent), dot(local, bitangent)];
    });
    const half = flat.reduce(
      (widest, point) => Math.max(widest, Math.abs(point[0]), Math.abs(point[1])),
      0,
    );
    if (!(half > 0)) throw new RangeError('a face has no area to texture');

    const base = positions.length;
    for (let corner = 0; corner < cycle.length; corner += 1) {
      const point = at(flat, corner, 'projected corner');
      positions.push(at(cycle, corner, 'face corner'));
      normals.push(normal);
      offsets.push(offset);
      uvs.push([
        0.5 + (point[0] / half) * 0.5 * FACE_FILL,
        0.5 + (point[1] / half) * 0.5 * FACE_FILL,
      ]);
    }
    // A fan: the face is convex, so this triangulates it and keeps the cycle's
    // winding in every triangle.
    for (let corner = 1; corner + 1 < cycle.length; corner += 1) {
      indices.push(base, base + corner, base + corner + 1);
    }
  }

  return { positions, normals, offsets, uvs, indices };
};

/* ------------------------------------------------------------------ */
/* The field                                                           */
/* ------------------------------------------------------------------ */

export interface SolidPlacement {
  readonly kind: SolidKind;
  /** World x and y of the solid's home. Drift wanders around this. */
  readonly x: number;
  readonly y: number;
  /**
   * Distance in front of the camera. **Constant for the life of the scene** —
   * nothing in the shader may move a solid in z, because a fixed depth is what
   * makes the far-to-near draw order permanently correct without a z-buffer.
   */
  readonly depth: number;
  /** Bounding radius in world units. The solids are unit-sphere meshes. */
  readonly radius: number;
  readonly spinAxis: Vec3;
  /** Turns per second at `spin = 1`. A minute or so per revolution. */
  readonly spinRate: number;
  /** Where in its wander loop this solid starts, in radians. */
  readonly driftPhase: number;
  /** Radians per second around that loop. */
  readonly driftRate: number;
}

/**
 * The ceilings the `size` and `swell` parameters may reach.
 *
 * They are constants rather than literals in the `ParamSpec` because the
 * depth-separation check has to reason about the *largest* a solid can ever
 * get: a preset turning `size` up must not be able to push two solids into
 * each other's depth range, so the check is made against the worst case a
 * preset is allowed to ask for, once, at build time.
 */
export const SIZE_CEILING = 1.2;
export const SWELL_CEILING = 0.18;
const WORST_CASE_SCALE = SIZE_CEILING * (1 + SWELL_CEILING);

/** Matches `kNear` in the vertex shader. Nothing may cross it. */
const NEAR_PLANE = 0.5;

/**
 * Five solids, near to far, each about a quarter of the screen high.
 *
 * Five, not fifteen: the idiom is a nearly empty field with a few objects in
 * it, and every extra solid is another depth band the separation rule has to
 * fit — the roster is a geometric series in depth for exactly that reason.
 * Apparent size is `radius * focal / depth`, so a fixed ratio between depths
 * keeps the same ratio between radii and the whole field scales together — the
 * roster is a 1.6 ratio throughout, which is the tightest spacing that still
 * clears the separation rule at the size and swell ceilings. The taper (24% of
 * the screen near, 19% far) is nearly the only depth cue left, since parallax
 * cannot help: everything drifts, nothing approaches.
 *
 * `x` and `y` are given in world units at each solid's own depth, so they read
 * as roughly a quarter to a third of a screen away from centre wherever the
 * solid sits. Spin axes are deliberately off the model axes — a cube turning
 * about its own face normal barely looks like it is turning at all.
 */
export const AMBIENT_SOLIDS: readonly SolidPlacement[] = [
  {
    kind: 'tetrahedron',
    x: -2.4,
    y: -2.2,
    depth: 8.6,
    radius: 1.35,
    spinAxis: [0.31, 0.87, 0.38],
    spinRate: 0.023,
    driftPhase: 0.4,
    driftRate: 0.031,
  },
  {
    kind: 'cube',
    x: 4.3,
    y: 3.7,
    depth: 14.4,
    radius: 2.14,
    spinAxis: [0.62, 0.55, -0.56],
    spinRate: 0.017,
    driftPhase: 2.1,
    driftRate: 0.024,
  },
  {
    kind: 'octahedron',
    x: -2.8,
    y: 0.5,
    depth: 23,
    radius: 3.26,
    spinAxis: [-0.42, 0.79, 0.45],
    spinRate: 0.029,
    driftPhase: 3.9,
    driftRate: 0.019,
  },
  {
    kind: 'tetrahedron',
    x: 12.5,
    y: -8.9,
    depth: 36.9,
    radius: 4.88,
    spinAxis: [0.71, -0.35, 0.61],
    spinRate: 0.013,
    driftPhase: 5.2,
    driftRate: 0.015,
  },
  {
    kind: 'cube',
    x: -17.7,
    y: 13,
    depth: 59,
    radius: 7.23,
    spinAxis: [-0.28, 0.66, 0.7],
    spinRate: 0.011,
    driftPhase: 1.3,
    driftRate: 0.012,
  },
];

export const ATTRIBUTE_POSITION = 0;
export const ATTRIBUTE_FACE = 1;
export const ATTRIBUTE_UV = 2;
export const ATTRIBUTE_HOME = 3;
export const ATTRIBUTE_SPIN = 4;
export const ATTRIBUTE_TRAIT = 5;

/** `aTrait.w`, telling the vertex shader which of its two jobs this is. */
const KIND_SOLID = 0;
const KIND_BACKDROP = 1;

/** Four corners of the field quad, drawn before anything else. */
const BACKDROP_VERTEX_COUNT = 4;

/** `GlContext.draw` binds a `Uint16Array`, so a bigger mesh draws garbage. */
const MAX_VERTICES = 65536;

/**
 * The scene's one mesh: the field quad, then every solid, far to near.
 *
 * The order is the hidden-surface algorithm, so it is enforced here rather
 * than assumed of the caller — a roster written near-to-far in the table above
 * would otherwise draw the whole field back to front, which looks like a
 * shader bug and is not one.
 *
 * Three things are refused outright rather than drawn wrong:
 *
 *  - **Depth spans that could touch.** Two solids are safely painter-ordered
 *    only if a plane perpendicular to the view axis separates them, so
 *    consecutive depths must differ by more than the two bounding radii at the
 *    largest scale a preset may ask for. Anything closer is a z-fight nobody
 *    can fix from a preset.
 *  - **Anything that could cross the near plane**, which would put `w` at or
 *    through zero and take the triangle with it.
 *  - **A mesh over 16 bits of index.** Sixty-five thousand vertices is not a
 *    roster anyone meant to write.
 */
export const buildAmbientGeometry = (
  placements: readonly SolidPlacement[] = AMBIENT_SOLIDS,
): GeometrySpec => {
  if (placements.length === 0) throw new RangeError('ambient needs at least one solid');

  const ordered = [...placements].sort((one, other) => other.depth - one.depth);
  for (const solid of ordered) {
    if (!(solid.radius > 0)) throw new RangeError('a solid needs a positive radius');
    if (!Number.isFinite(solid.depth)) throw new RangeError('a solid needs a depth');
    if (!Number.isFinite(solid.x) || !Number.isFinite(solid.y)) {
      throw new RangeError('a solid needs a finite home');
    }
    if (!Number.isFinite(solid.spinRate) || !Number.isFinite(solid.driftRate)) {
      throw new RangeError('a solid needs finite rates');
    }
    if (solid.depth - solid.radius * WORST_CASE_SCALE <= NEAR_PLANE) {
      throw new RangeError('a solid reaches through the near plane');
    }
  }

  const meshes = new Map<SolidKind, SolidMesh>();
  const meshFor = (kind: SolidKind): SolidMesh => {
    const known = meshes.get(kind);
    if (known !== undefined) return known;
    const built = tessellateSolid(SOLID_SHAPES[kind]);
    meshes.set(kind, built);
    return built;
  };

  const vertexCount =
    BACKDROP_VERTEX_COUNT +
    ordered.reduce((total, solid) => total + meshFor(solid.kind).positions.length, 0);
  if (vertexCount > MAX_VERTICES) {
    throw new RangeError(
      `ambient mesh needs ${String(vertexCount)} vertices, over 16 bits`,
    );
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const far = at(ordered, index - 1, 'solid');
    const near = at(ordered, index, 'solid');
    const needed = (far.radius + near.radius) * WORST_CASE_SCALE;
    if (far.depth - near.depth <= needed) {
      throw new RangeError(
        `solids at ${String(far.depth)} and ${String(near.depth)} can overlap in depth,` +
          ` which no draw order can sort without a depth buffer`,
      );
    }
  }

  const positions: number[] = [];
  const faces: number[] = [];
  const uvs: number[] = [];
  const homes: number[] = [];
  const spins: number[] = [];
  const traits: number[] = [];
  const indices: number[] = [];

  // The field, first and farthest. Its corners are already in clip space; the
  // vertex shader passes them through rather than projecting them.
  const corners: readonly Vec2[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const corner of corners) {
    positions.push(corner[0], corner[1], 0);
    faces.push(0, 0, 1, 0);
    uvs.push(corner[0] * 0.5 + 0.5, corner[1] * 0.5 + 0.5);
    homes.push(0, 0, 0);
    spins.push(0, 0, 1, 0);
    traits.push(0, 0, 0, KIND_BACKDROP);
  }
  indices.push(0, 1, 2, 0, 2, 3);

  for (const solid of ordered) {
    const mesh = meshFor(solid.kind);
    const axis = normalise(solid.spinAxis, 'spin axis');
    const base = positions.length / 3;

    for (let vertex = 0; vertex < mesh.positions.length; vertex += 1) {
      const position = at(mesh.positions, vertex, 'solid vertex');
      const normal = at(mesh.normals, vertex, 'solid normal');
      const uv = at(mesh.uvs, vertex, 'solid uv');
      positions.push(position[0], position[1], position[2]);
      faces.push(normal[0], normal[1], normal[2], at(mesh.offsets, vertex, 'plane'));
      uvs.push(uv[0], uv[1]);
      // Depth is negative z: the camera looks down -z, as in `tunnel`.
      homes.push(solid.x, solid.y, -solid.depth);
      spins.push(axis[0], axis[1], axis[2], solid.spinRate);
      traits.push(solid.driftPhase, solid.driftRate, solid.radius, KIND_SOLID);
    }
    for (const index of mesh.indices) indices.push(base + index);
  }

  return {
    attributes: [
      { location: ATTRIBUTE_POSITION, size: 3, data: new Float32Array(positions) },
      { location: ATTRIBUTE_FACE, size: 4, data: new Float32Array(faces) },
      { location: ATTRIBUTE_UV, size: 2, data: new Float32Array(uvs) },
      { location: ATTRIBUTE_HOME, size: 3, data: new Float32Array(homes) },
      { location: ATTRIBUTE_SPIN, size: 4, data: new Float32Array(spins) },
      { location: ATTRIBUTE_TRAIT, size: 4, data: new Float32Array(traits) },
    ],
    indices: new Uint16Array(indices),
    count: indices.length,
  };
};

export const AMBIENT_MESH = buildAmbientGeometry();

/* ------------------------------------------------------------------ */
/* The shaders                                                         */
/* ------------------------------------------------------------------ */

/**
 * The same 66 degree lens the tunnel uses. Two scenes with different fields of
 * view cut between each other badly — the room appears to change size — and
 * there is no reason for this one to disagree. Worked out here so the source
 * carries a literal, for the reason `tunnel.ts` gives: a `tan()` in a `const`
 * initialiser is legal ESSL that is not worth discovering a Pi disagrees about.
 */
const CAMERA_FOV = 1.15;
const CAMERA_FOCAL = 1 / Math.tan(CAMERA_FOV / 2);

/**
 * A fixed key light, up and to the left and slightly toward the camera.
 *
 * Fixed rather than beat-driven on purpose: D-071 caps beat-driven luminance
 * centrally, and a scene whose whole subject is *shape* gets more from moving
 * geometry than from lighting it harder. So the beat moves solids and the
 * light stays put.
 */
const KEY_LIGHT: Vec3 = normalise([-0.42, 0.76, 0.5], 'key light');

/** Where haze reaches full strength. Past the farthest solid, with margin. */
const HAZE_END = 78;

const glsl = (value: number): string => value.toFixed(5);

/**
 * `highp`, and one uniform in particular needs it.
 *
 * `uTime` is monotonic and unbounded (uniforms.ts), and this scene multiplies
 * it by rates measured in hundredths — an hour in, `mediump` holds 3600
 * seconds to about three seconds of resolution, which would freeze every solid
 * into a slideshow. It is therefore declared `highp` *and* never read by the
 * fragment shader, so the two stages cannot disagree about it. The uniforms
 * that do appear in both are pinned to `mediump` here, against the file
 * default, because a mismatch is a **link** failure invisible to every
 * headless test (precision.test.ts exists for that bug).
 */
const AMBIENT_VERTEX = `#version 300 es
precision highp float;

layout(location = ${String(ATTRIBUTE_POSITION)}) in vec3 aPosition;
layout(location = ${String(ATTRIBUTE_FACE)}) in vec4 aFace;
layout(location = ${String(ATTRIBUTE_UV)}) in vec2 aUv;
layout(location = ${String(ATTRIBUTE_HOME)}) in vec3 aHome;
layout(location = ${String(ATTRIBUTE_SPIN)}) in vec4 aSpin;
layout(location = ${String(ATTRIBUTE_TRAIT)}) in vec4 aTrait;

uniform highp float uTime;
uniform mediump float uBeat;
uniform mediump float uPhase;
uniform mediump float uIntensity;
uniform mediump vec2 uResolution;
uniform float uSpin;
uniform float uDrift;
uniform float uSize;
uniform float uSwell;

// Explicitly mediump on both sides of the interface, for the same reason the
// shared uniforms are: matching is required, and the defaults differ.
out mediump vec2 vUv;
out mediump float vLight;
out mediump float vDepth;
out mediump float vField;

const float kTau = 6.2831853;
const float kFocal = ${glsl(CAMERA_FOCAL)};
const float kNear = ${glsl(NEAR_PLANE)};
const float kFar = 500.0;
const float kHazeEnd = ${glsl(HAZE_END)};
const vec3 kKey = vec3(${glsl(KEY_LIGHT[0])}, ${glsl(KEY_LIGHT[1])}, ${glsl(KEY_LIGHT[2])});
// What the scene does at uIntensity = 0. Not zero: a field that has stopped
// reads as a frozen frame, and the calmest this should ever be is slow.
const float kCalm = 0.25;
// Under 1 so the slow parallax below cannot walk the field off the edge of a
// clamped texture and smear one column of texels across the panel.
const float kFieldZoom = 0.94;
// Shading floor, so a facet turned away from the key light is dim rather than
// black — the album is on these faces and unlit black would throw it away.
const float kFloor = 0.25;

// Rodrigues, column-major. Rebuilding the rotation per vertex is more
// arithmetic than doing it once per solid, but the uniform contract carries no
// matrices and no per-object slot to put one in, so the per-solid constants
// ride in the attributes instead. The whole mesh is 96 solid vertices, so this
// is 96 small matrix builds a frame — nothing, next to one screen of fill.
mat3 turn(vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  float t = 1.0 - c;
  return mat3(
    t * axis.x * axis.x + c,
    t * axis.x * axis.y + s * axis.z,
    t * axis.x * axis.z - s * axis.y,
    t * axis.x * axis.y - s * axis.z,
    t * axis.y * axis.y + c,
    t * axis.y * axis.z + s * axis.x,
    t * axis.x * axis.z + s * axis.y,
    t * axis.y * axis.z - s * axis.x,
    t * axis.z * axis.z + c);
}

void main() {
  // The user's dial scales every rate rather than gating any of them, so the
  // scene slows down toward calm instead of switching motions off.
  float motion = mix(kCalm, 1.0, uIntensity);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vField = aTrait.w;

  if (aTrait.w > 0.5) {
    // The field: the cover as wallpaper, already in clip space. Cropped rather
    // than stretched — a square sleeve scaled to a 16:9 panel would make every
    // face on it wide, which is the one distortion people notice instantly.
    vec2 fit = vec2(min(aspect, 1.0), min(1.0 / aspect, 1.0));
    vec2 parallax = vec2(sin(uTime * 0.017), cos(uTime * 0.013)) * 0.015 * motion;
    vUv = (aUv - 0.5) * fit * kFieldZoom + 0.5 + parallax;
    vLight = 1.0;
    vDepth = 0.0;
    gl_Position = vec4(aPosition.xy, 0.0, 1.0);
    return;
  }

  float depth = -aHome.z;
  // Drift is proportional to depth, so a far solid crosses as much *screen* as
  // a near one. Two incommensurate rates make a slow Lissajous that never
  // quite repeats, which is what stops the field looking like it is on rails.
  float wander = uDrift * depth * 0.05;
  vec2 offset = vec2(
    sin(uTime * aTrait.y * motion + aTrait.x),
    cos(uTime * aTrait.y * 0.78 * motion + aTrait.x * 1.7)) * wander;
  // The only thing bound to the beat grid. sin() of the phase sawtooth is
  // continuous across the wrap where the sawtooth itself is not, so the field
  // breathes with the bar instead of snapping back on every beat. It moves the
  // solid rather than lighting it (D-071).
  offset.y += sin(uPhase * kTau) * uSwell * uIntensity * depth * 0.02;

  // x and y only: the depth of a solid is fixed for the life of the scene,
  // because the draw order baked into the index buffer depends on it.
  vec3 centre = aHome + vec3(offset, 0.0);
  float scale = aTrait.z * uSize * (1.0 + uSwell * uIntensity * uBeat);
  mat3 spin = turn(aSpin.xyz, kTau * aSpin.w * uSpin * motion * uTime);
  vec3 normal = spin * aFace.xyz;
  vec3 world = centre + spin * aPosition * scale;

  vUv = aUv;
  // Flat shading without an interpolation qualifier: the normal is the
  // face's, so this varying is identical at all three corners and
  // interpolates to itself. The hard edge comes from the mesh — a corner
  // exists once per face it touches — which is where it belongs.
  vLight = kFloor + (1.0 - kFloor) * clamp(dot(normal, kKey), 0.0, 1.0);
  vDepth = clamp(-world.z / kHazeEnd, 0.0, 1.0);

  // Exact back-face rejection, and the reason every vertex carries its face's
  // plane. The face is visible only if the camera — at the origin — is on the
  // outward side of that plane: dot(n, p_cam) > offset in model space, which
  // rearranges to this in world space with no inverse and no divide. All three
  // corners of a triangle compute the same value, so a face is either drawn or
  // gone, never stretched into a sliver.
  float side = -dot(normal, centre) - aFace.w * scale;

  // No projection matrix in the contract, so it is built here: the camera
  // never moves, which makes it a scale and a depth remap.
  vec4 clip = vec4(
    world.x * kFocal / aspect,
    world.y * kFocal,
    ((kFar + kNear) * world.z + 2.0 * kFar * kNear) / (kNear - kFar),
    -world.z);

  // A rejected face is pushed outside the clip volume on every axis, so the
  // triangle is thrown away whole before rasterisation. This is what stands in
  // for the face culling GlContext cannot ask for and the depth buffer the
  // render targets do not have.
  gl_Position = side > 0.0 ? clip : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const AMBIENT_FRAGMENT = `#version 300 es
precision mediump float;

in mediump vec2 vUv;
in mediump float vLight;
in mediump float vDepth;
in mediump float vField;

uniform sampler2D uArt;
uniform vec3 uAccent;
uniform mediump float uIntensity;
uniform float uLight;
uniform float uTint;
uniform float uBackdrop;
uniform float uHaze;

out vec4 fragColour;

// What an unlit facet keeps when uLight is 0: the cover, near enough flat.
const float kUnlit = 0.72;

void main() {
  vec3 art = texture(uArt, vUv).rgb;

  if (vField > 0.5) {
    // Wallpaper. Pulled toward the accent and darkened hard, because this is
    // the field the solids are read against — the moment it competes with them
    // for attention the scene stops being solids on a dark field and becomes
    // a busy picture with shapes on it.
    vec2 fromCentre = vUv - 0.5;
    float vignette = 1.0 - 0.85 * clamp(dot(fromCentre, fromCentre) * 2.2, 0.0, 1.0);
    fragColour = vec4(mix(art, uAccent * 0.4, 0.4) * uBackdrop * vignette, 1.0);
    return;
  }

  // uLight is the whole flat-shaded/gently-lit axis: 0 is the cover printed on
  // the facet with no lighting at all, 1 is full contrast between the facet
  // facing the key light and the one turned away.
  vec3 colour = art * mix(kUnlit, vLight, uLight);

  // Facet colour from the cover's palette, weighted to the shadowed faces so
  // the lit ones stay the artwork. Scaled by the user's dial: pushing colour
  // is an effect, and at zero intensity the solids are very nearly the sleeve.
  colour = mix(colour, uAccent, uTint * mix(0.35, 1.0, uIntensity) * (1.0 - vLight));

  // The only depth cue left once size is taper-matched and nothing approaches
  // the camera. Squared, so the near half of the field is untouched and the
  // far solid sits back rather than the whole scene going grey.
  vec3 haze = uAccent * 0.2 + vec3(0.015, 0.012, 0.03);
  colour = mix(colour, haze, clamp(uHaze, 0.0, 1.0) * vDepth * vDepth);

  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * Slow solids on a field of album art.
 *
 * `depthTest: false` is not the tunnel's artefact 04 restated — it is the
 * pipeline's actual capability. No render target has a depth attachment
 * (`gl-context.ts` attaches colour and nothing else), so asking for the test
 * would enable a comparison against a buffer that is not there. The scene
 * sorts itself instead: exact back-face rejection inside each convex solid,
 * and a build-time-verified far-to-near order between them.
 */
export const AMBIENT_SCENE: SceneDefinition = {
  id: 'ambient',
  vertex: AMBIENT_VERTEX,
  fragment: AMBIENT_FRAGMENT,
  geometry: AMBIENT_MESH,
  depthTest: false,
  params: {
    /** Turns per second, as a multiple of each solid's own rate. */
    spin: { default: 1, min: 0, max: 4 },
    /** How far a solid wanders from home, as a fraction of its depth. */
    drift: { default: 1, min: 0, max: 3 },
    /**
     * Overall scale. The ceiling is `SIZE_CEILING`, and it is not arbitrary:
     * `buildAmbientGeometry` proves the depth ordering holds at exactly this
     * value, so raising it here without raising it there would let a preset
     * push two solids into one depth band.
     */
    size: { default: 1, min: 0.4, max: SIZE_CEILING },
    /** How far a beat swells a solid, as a fraction of its radius. */
    swell: { default: 0.12, min: 0, max: SWELL_CEILING },
    /** Flat-shaded at 0, gently lit at 1. */
    light: { default: 0.7, min: 0, max: 1 },
    /** How far the shadowed facets take the cover's accent colour. */
    tint: { default: 0.35, min: 0, max: 1 },
    /** Brightness of the album art behind the solids. 0 is a black field. */
    backdrop: { default: 0.18, min: 0, max: 1 },
    /** Distance fade, the only depth cue the scene has left. */
    haze: { default: 0.7, min: 0, max: 1 },
  },
};
