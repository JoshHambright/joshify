/**
 * What can be tested about a scene with no GPU is its arithmetic — which is
 * also where mesh bugs live. A solid whose winding is inverted on one face, or
 * whose corners are shared between faces, does not fail: it draws, and looks
 * subtly and unfixably wrong on a panel nobody is standing in front of.
 *
 * Two invariants here are load-bearing rather than tidy, because the pipeline
 * has **no depth buffer** (`gl-context.ts` attaches colour to a framebuffer and
 * nothing else) and no face culling:
 *
 *  - every vertex carries its own face's normal and plane, so back faces can be
 *    rejected exactly, per face, in the vertex shader;
 *  - solids are emitted far to near and cannot overlap in depth, so the
 *    painter's ordering baked into the index buffer is correct in every frame.
 *
 * Both are asserted below. Neither is visible in a screenshot until it is wrong.
 */
import { describe, expect, it } from 'vitest';
import type { GeometrySpec } from '../gl-context.js';
import { paramUniformName } from '../uniforms.js';
import {
  AMBIENT_MESH,
  AMBIENT_SCENE,
  AMBIENT_SOLIDS,
  ATTRIBUTE_FACE,
  ATTRIBUTE_HOME,
  ATTRIBUTE_POSITION,
  ATTRIBUTE_SPIN,
  ATTRIBUTE_TRAIT,
  ATTRIBUTE_UV,
  SIZE_CEILING,
  SOLID_SHAPES,
  SWELL_CEILING,
  buildAmbientGeometry,
  tessellateSolid,
  type SolidKind,
  type SolidPlacement,
  type Vec3,
} from './ambient.js';

/** The uniforms every shader may read, from `uniforms.ts`. */
const CONTRACT = new Set([
  'uTime',
  'uBeat',
  'uPhase',
  'uEnergy',
  'uBands',
  'uIntensity',
  'uAccent',
  'uForeground',
  'uResolution',
  'uTexel',
  'uTexture',
  'uArt',
  'uPrev',
]);

const UNIFORM =
  /^\s*uniform\s+(?:(highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(?:\[\d+])?\s*;/gm;

const attributeData = (spec: GeometrySpec, location: number): Float32Array => {
  const found = spec.attributes.find((attribute) => attribute.location === location);
  if (found === undefined) {
    throw new Error(`no attribute at location ${String(location)}`);
  }
  return found.data;
};

const indicesOf = (spec: GeometrySpec): Uint16Array => {
  if (spec.indices === undefined) throw new Error('the ambient mesh must be indexed');
  return spec.indices;
};

const at = (values: Float32Array | Uint16Array, index: number): number =>
  values[index] ?? Number.NaN;

/** One vertex's slice of an attribute, so an assertion can name a corner. */
const slice = (values: Float32Array, vertex: number, size: number): number[] =>
  Array.from({ length: size }, (_unused, offset) => at(values, vertex * size + offset));

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const asVec3 = (values: readonly number[]): Vec3 => [
  values[0] ?? Number.NaN,
  values[1] ?? Number.NaN,
  values[2] ?? Number.NaN,
];

const key = (values: readonly number[]): string =>
  values.map((value) => value.toFixed(6)).join(',');

/** Faces and corners per face, from the tables the shapes are written as. */
const SHAPES: readonly (readonly [SolidKind, number, number])[] = [
  ['tetrahedron', 4, 3],
  ['cube', 6, 4],
  ['octahedron', 8, 3],
];

describe('a solid, tessellated', () => {
  it.each(SHAPES)(
    'gives %s one copy of each corner per face that touches it',
    (kind, faces, corners) => {
      const mesh = tessellateSolid(SOLID_SHAPES[kind]);

      // Not `shape.vertices.length`: flat shading needs the duplication, and a
      // mesh that has quietly started sharing corners is a mesh that has
      // quietly started shading smoothly.
      expect(mesh.positions).toHaveLength(faces * corners);
      expect(mesh.normals).toHaveLength(faces * corners);
      expect(mesh.uvs).toHaveLength(faces * corners);
      expect(mesh.offsets).toHaveLength(faces * corners);
      // A fan over a convex face: two triangles for a quad, one for a triangle.
      expect(mesh.indices).toHaveLength(faces * (corners - 2) * 3);
    },
  );

  it.each(SHAPES)('puts every %s corner on the unit sphere', (kind) => {
    for (const position of tessellateSolid(SOLID_SHAPES[kind]).positions) {
      // The scale is a uniform and the bounding radius is a placement field, so
      // the mesh itself has to be unit — that equality is what makes the
      // depth-separation check in `buildAmbientGeometry` a real guarantee.
      expect(Math.hypot(...position)).toBeCloseTo(1, 12);
    }
  });

  /**
   * The flat-shading test. A cube corner belongs to three faces, so it must
   * exist three times with three different normals; if it existed once, the
   * three faces would share a normal and the cube would have no hard edges —
   * the exact bug that cannot be seen in a headless test any other way.
   */
  it('duplicates a shared corner once per face, with a different normal each time', () => {
    const mesh = tessellateSolid(SOLID_SHAPES.cube);
    const byPosition = new Map<string, string[]>();

    for (let vertex = 0; vertex < mesh.positions.length; vertex += 1) {
      const position = mesh.positions[vertex] ?? [0, 0, 0];
      const normal = mesh.normals[vertex] ?? [0, 0, 0];
      const seen = byPosition.get(key(position)) ?? [];
      seen.push(key(normal));
      byPosition.set(key(position), seen);
    }

    expect(byPosition.size).toBe(8);
    for (const normals of byPosition.values()) {
      expect(normals).toHaveLength(3);
      expect(new Set(normals).size).toBe(3);
    }
  });

  it.each(SHAPES)(
    'gives %s one normal per face and no vertex to two of them',
    (kind, faces, corners) => {
      const mesh = tessellateSolid(SOLID_SHAPES[kind]);
      const byNormal = new Map<string, number>();

      for (const normal of mesh.normals) {
        byNormal.set(key(normal), (byNormal.get(key(normal)) ?? 0) + 1);
      }

      expect(byNormal.size).toBe(faces);
      for (const count of byNormal.values()) expect(count).toBe(corners);
    },
  );

  /**
   * Winding is computed from the geometry rather than declared in the face
   * table, so this checks the computation: every triangle comes out
   * counter-clockwise seen from outside, whichever way round the table wrote
   * the cycle.
   */
  it.each(SHAPES)('winds every %s triangle outward', (kind) => {
    const mesh = tessellateSolid(SOLID_SHAPES[kind]);

    for (let triangle = 0; triangle * 3 < mesh.indices.length; triangle += 1) {
      const corner = (offset: number): Vec3 =>
        mesh.positions[mesh.indices[triangle * 3 + offset] ?? -1] ?? [0, 0, 0];
      const a = corner(0);
      const b = corner(1);
      const c = corner(2);
      const face = cross(subtract(b, a), subtract(c, a));
      const centre: Vec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];

      // Outward, and the same direction as the normal the vertices carry —
      // the shader lights and culls with the stored one, so a disagreement
      // between the two would light a face the culler had already thrown away.
      expect(dot(face, centre)).toBeGreaterThan(0);
      const stored = mesh.normals[mesh.indices[triangle * 3] ?? -1] ?? [0, 0, 0];
      const size = Math.hypot(...face);
      expect(dot([face[0] / size, face[1] / size, face[2] / size], stored)).toBeCloseTo(
        1,
        10,
      );
    }
  });

  /** What the vertex shader's back-face test reads. */
  it.each(SHAPES)('puts every %s vertex on its own face plane', (kind) => {
    const mesh = tessellateSolid(SOLID_SHAPES[kind]);

    for (let vertex = 0; vertex < mesh.positions.length; vertex += 1) {
      const position = mesh.positions[vertex] ?? [0, 0, 0];
      const normal = mesh.normals[vertex] ?? [0, 0, 0];
      const offset = mesh.offsets[vertex] ?? Number.NaN;

      expect(dot(normal, position)).toBeCloseTo(offset, 10);
      // Positive: the plane is in front of the origin, which is what makes the
      // solid convex around the camera-facing test the shader does.
      expect(offset).toBeGreaterThan(0);
    }
  });

  it.each(SHAPES)(
    'centres the cover on each %s facet, inside the sleeve',
    (kind, faces, corners) => {
      const mesh = tessellateSolid(SOLID_SHAPES[kind]);

      for (let face = 0; face < faces; face += 1) {
        let sumU = 0;
        let sumV = 0;
        for (let corner = 0; corner < corners; corner += 1) {
          const uv = mesh.uvs[face * corners + corner] ?? [Number.NaN, Number.NaN];
          expect(uv[0]).toBeGreaterThanOrEqual(0);
          expect(uv[0]).toBeLessThanOrEqual(1);
          expect(uv[1]).toBeGreaterThanOrEqual(0);
          expect(uv[1]).toBeLessThanOrEqual(1);
          sumU += uv[0];
          sumV += uv[1];
        }
        // The projection is centred on the face, so the crop is centred on the
        // cover — a facet showing a corner of the sleeve would read as an error.
        expect(sumU / corners).toBeCloseTo(0.5, 10);
        expect(sumV / corners).toBeCloseTo(0.5, 10);
      }
    },
  );

  it.each(SHAPES)('has no NaN anywhere in %s', (kind) => {
    const mesh = tessellateSolid(SOLID_SHAPES[kind]);
    const numbers = [
      ...mesh.positions.flat(),
      ...mesh.normals.flat(),
      ...mesh.uvs.flat(),
      ...mesh.offsets,
    ];

    for (const value of numbers) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('a face table written the wrong way round', () => {
  /**
   * Winding is computed rather than declared, so a table whose cycles all run
   * the other way must come out identical. This is the assertion that the
   * hand-written face tables above cannot silently invert one solid.
   */
  it('comes out with the same outward faces as the table it inverts', () => {
    const forwards = tessellateSolid(SOLID_SHAPES.cube);
    const backwards = tessellateSolid({
      vertices: SOLID_SHAPES.cube.vertices,
      faces: SOLID_SHAPES.cube.faces.map((face) => [...face].reverse()),
    });

    expect(backwards.normals).toHaveLength(forwards.normals.length);
    for (let vertex = 0; vertex < backwards.normals.length; vertex += 1) {
      const normal = backwards.normals[vertex] ?? [0, 0, 0];
      const position = backwards.positions[vertex] ?? [0, 0, 0];
      const offset = backwards.offsets[vertex] ?? Number.NaN;
      expect(dot(normal, position)).toBeCloseTo(offset, 10);
      expect(offset).toBeGreaterThan(0);
    }
    // Same set of faces, whichever way the table wrote them.
    expect(new Set(backwards.normals.map(key))).toEqual(
      new Set(forwards.normals.map(key)),
    );
  });
});

describe('a shape the tessellator cannot use', () => {
  it('refuses a face with no area', () => {
    expect(() =>
      tessellateSolid({
        vertices: [
          [1, 0, 0],
          [-1, 0, 0],
        ],
        faces: [[0, 1]],
      }),
    ).toThrow(/three corners/);
  });

  it('refuses a face naming a corner the solid has not', () => {
    expect(() => tessellateSolid({ vertices: [[1, 0, 0]], faces: [[0, 1, 2]] })).toThrow(
      /no element/,
    );
  });

  /**
   * The assumption the whole back-face test rests on: the solid is convex and
   * wrapped around the origin, so every face plane is in front of it. A face
   * through the origin has no outward side, and the shader would cull it in
   * half. Better a build error than a solid that flickers inside out.
   */
  it('refuses a face whose plane passes through the origin', () => {
    expect(() =>
      tessellateSolid({
        vertices: [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
        ],
        faces: [[0, 1, 2]],
      }),
    ).toThrow(/not convex/);
  });
});

describe('the scene mesh', () => {
  const vertexCount = attributeData(AMBIENT_MESH, ATTRIBUTE_POSITION).length / 3;

  it('is the field quad plus five solids: 100 vertices, 42 triangles', () => {
    // 4 + 12 + 24 + 24 + 12 + 24, and one draw call for all of it. The whole
    // budget argument for this scene is that it is nearly free on the vertex
    // side and one screen of textured fill on the fragment side.
    expect(vertexCount).toBe(100);
    expect(indicesOf(AMBIENT_MESH)).toHaveLength(126);
    expect(AMBIENT_MESH.count).toBe(126);
    expect(AMBIENT_SOLIDS).toHaveLength(5);
  });

  it('fills every attribute for every vertex', () => {
    const sizes: readonly (readonly [number, number])[] = [
      [ATTRIBUTE_POSITION, 3],
      [ATTRIBUTE_FACE, 4],
      [ATTRIBUTE_UV, 2],
      [ATTRIBUTE_HOME, 3],
      [ATTRIBUTE_SPIN, 4],
      [ATTRIBUTE_TRAIT, 4],
    ];

    for (const [location, size] of sizes) {
      const data = attributeData(AMBIENT_MESH, location);
      expect(data.length).toBe(vertexCount * size);
      for (const value of data) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('draws the field first, and marks it so the shader takes the other path', () => {
    const traits = attributeData(AMBIENT_MESH, ATTRIBUTE_TRAIT);

    for (let vertex = 0; vertex < 4; vertex += 1) {
      expect(at(traits, vertex * 4 + 3)).toBe(1);
    }
    for (let vertex = 4; vertex < vertexCount; vertex += 1) {
      expect(at(traits, vertex * 4 + 3)).toBe(0);
    }
    expect(Array.from(indicesOf(AMBIENT_MESH).slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('references only vertices that exist, and fits in 16 bits', () => {
    for (const index of indicesOf(AMBIENT_MESH)) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertexCount);
      expect(index).toBeLessThan(65536);
    }
  });

  /**
   * The mesh-level statement of flat shading: a triangle's three corners agree
   * about their face and their solid. If a triangle ever spanned two faces the
   * shader's per-face back-face test would disagree with itself across the
   * primitive and stretch it to the corner of the screen.
   */
  it('keeps every triangle inside one face of one solid', () => {
    const faces = attributeData(AMBIENT_MESH, ATTRIBUTE_FACE);
    const homes = attributeData(AMBIENT_MESH, ATTRIBUTE_HOME);
    const indices = indicesOf(AMBIENT_MESH);

    for (let triangle = 2; triangle * 3 < indices.length; triangle += 1) {
      const corners = [0, 1, 2].map((offset) => at(indices, triangle * 3 + offset));
      const planes = corners.map((vertex) => key(slice(faces, vertex, 4)));
      const solids = corners.map((vertex) => key(slice(homes, vertex, 3)));

      expect(new Set(planes).size).toBe(1);
      expect(new Set(solids).size).toBe(1);
    }
  });

  /**
   * The painter's algorithm, which is the whole hidden-surface story between
   * solids. Far first, every time, in the order the index buffer names them.
   */
  it('emits the solids far to near, whatever order the roster is written in', () => {
    const shuffled = [...AMBIENT_SOLIDS].sort((one, other) => one.depth - other.depth);
    const mesh = buildAmbientGeometry(shuffled);
    const homes = attributeData(mesh, ATTRIBUTE_HOME);
    const indices = indicesOf(mesh);

    const depths: number[] = [];
    for (let triangle = 2; triangle * 3 < indices.length; triangle += 1) {
      const depth = -at(homes, at(indices, triangle * 3) * 3 + 2);
      if (depths[depths.length - 1] !== depth) depths.push(depth);
    }

    expect(depths).toHaveLength(AMBIENT_SOLIDS.length);
    for (let solid = 1; solid < depths.length; solid += 1) {
      expect(at(new Float32Array(depths), solid)).toBeLessThan(
        at(new Float32Array(depths), solid - 1),
      );
    }
  });

  it('normalises the spin axis, so no solid rotates by NaN', () => {
    const spins = attributeData(AMBIENT_MESH, ATTRIBUTE_SPIN);

    for (let vertex = 4; vertex < vertexCount; vertex += 1) {
      const axis = asVec3(slice(spins, vertex, 4));
      expect(Math.hypot(...axis)).toBeCloseTo(1, 6);
    }
  });

  /**
   * The rule that makes the fixed draw order safe: two solids can only be
   * painter-sorted if a plane across the view axis separates them, so their
   * depth spans must stay apart at the largest scale a preset may ask for.
   */
  it('keeps the roster apart in depth at the biggest a preset can make it', () => {
    const worst = SIZE_CEILING * (1 + SWELL_CEILING);
    const sorted = [...AMBIENT_SOLIDS].sort((one, other) => other.depth - one.depth);

    for (let solid = 1; solid < sorted.length; solid += 1) {
      const far = sorted[solid - 1];
      const near = sorted[solid];
      if (far === undefined || near === undefined) throw new Error('roster hole');
      expect(far.depth - near.depth).toBeGreaterThan((far.radius + near.radius) * worst);
    }
    const nearest = sorted[sorted.length - 1];
    if (nearest === undefined) throw new Error('roster hole');
    expect(nearest.depth - nearest.radius * worst).toBeGreaterThan(0.5);
  });
});

describe('a roster the scene cannot draw', () => {
  const solid = (over: Partial<SolidPlacement>): SolidPlacement => ({
    kind: 'cube',
    x: 0,
    y: 0,
    depth: 20,
    radius: 1,
    spinAxis: [0, 1, 0],
    spinRate: 0.02,
    driftPhase: 0,
    driftRate: 0.02,
    ...over,
  });

  it('refuses an empty field', () => {
    expect(() => buildAmbientGeometry([])).toThrow(RangeError);
  });

  it('refuses depth spans that could touch, rather than z-fighting on the panel', () => {
    expect(() =>
      buildAmbientGeometry([solid({ depth: 20 }), solid({ depth: 22 })]),
    ).toThrow(/overlap in depth/);
    // Far enough apart for the same pair to be fine: the rule is a distance,
    // not a taboo on two solids at similar depths.
    expect(() =>
      buildAmbientGeometry([solid({ depth: 20 }), solid({ depth: 26 })]),
    ).not.toThrow();
  });

  it('refuses a solid that could reach through the near plane', () => {
    expect(() => buildAmbientGeometry([solid({ depth: 1, radius: 1 })])).toThrow(
      /near plane/,
    );
  });

  it('refuses a spin axis with no direction', () => {
    expect(() => buildAmbientGeometry([solid({ spinAxis: [0, 0, 0] })])).toThrow(
      /normalise/,
    );
  });

  it('refuses a solid with no size or no place', () => {
    expect(() => buildAmbientGeometry([solid({ radius: 0 })])).toThrow(/radius/);
    expect(() => buildAmbientGeometry([solid({ x: Number.NaN })])).toThrow(/home/);
    expect(() => buildAmbientGeometry([solid({ depth: Number.NaN })])).toThrow(/depth/);
    expect(() => buildAmbientGeometry([solid({ driftRate: Number.NaN })])).toThrow(
      /rates/,
    );
  });

  it('refuses a mesh too big for a 16-bit index rather than drawing garbage', () => {
    // 24 vertices a cube, so this is a few hundred over the line — and it is
    // checked before the separation rule, because "too many solids" is the
    // more useful diagnosis when a roster is generated rather than written.
    const many = Array.from({ length: 2800 }, (_unused, index) =>
      solid({ depth: 20 + index * 10 }),
    );

    expect(() => buildAmbientGeometry(many)).toThrow(/over 16 bits/);
  });
});

describe('the ambient scene', () => {
  const sources = [AMBIENT_SCENE.vertex, AMBIENT_SCENE.fragment];

  const declaredUniforms = (source: string): readonly (readonly string[])[] =>
    [...source.matchAll(UNIFORM)].map(([, precision, type, name]) => [
      name ?? '',
      type ?? '',
      precision ?? '',
    ]);

  it('is named the way a preset names it, and draws the mesh built above', () => {
    expect(AMBIENT_SCENE.id).toBe('ambient');
    expect(AMBIENT_SCENE.geometry).toBe(AMBIENT_MESH);
  });

  /** A leading newline in a template literal is a compile error on hardware. */
  it('starts both shaders with the version directive', () => {
    for (const source of sources) {
      expect(source.startsWith('#version 300 es\n')).toBe(true);
    }
  });

  it('declares a uniform for every parameter it advertises', () => {
    const source = sources.join('\n');
    for (const name of Object.keys(AMBIENT_SCENE.params)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(AMBIENT_SCENE.params).map(paramUniformName),
    ]);

    for (const source of sources) {
      const declared = declaredUniforms(source);
      expect(declared.length).toBeGreaterThan(0);
      for (const [name] of declared) expect(allowed).toContain(name);
    }
  });

  /**
   * The link failure precision.test.ts exists for, checked here too because
   * this scene is not in the catalogue until it is registered — and the bug it
   * catches is invisible until something with a GPU tries to link the program.
   */
  it('declares every shared uniform at the same precision in both stages', () => {
    const inVertex = new Map(
      declaredUniforms(AMBIENT_SCENE.vertex).map(([name, , precision]) => [
        name,
        precision,
      ]),
    );
    const inFragment = new Map(
      declaredUniforms(AMBIENT_SCENE.fragment).map(([name, , precision]) => [
        name,
        precision,
      ]),
    );
    const shared = [...inVertex.keys()].filter((name) => inFragment.has(name));

    expect(shared).toContain('uIntensity');
    for (const name of shared) {
      expect(inVertex.get(name)).toBe(inFragment.get(name));
      // Explicit, not inherited: the two files' defaults differ, so a shared
      // uniform without a qualifier is the bug waiting to happen.
      expect(inVertex.get(name)).not.toBe('');
    }
  });

  it('binds motion to the beat grid rather than to luminance (D-071)', () => {
    expect(AMBIENT_SCENE.vertex).toContain('uBeat');
    expect(AMBIENT_SCENE.vertex).toContain('sin(uPhase * kTau)');
    // Nothing beat-driven in the fragment stage: the beat moves solids, it
    // does not flash them.
    expect(AMBIENT_SCENE.fragment).not.toContain('uBeat');
    expect(AMBIENT_SCENE.fragment).not.toContain('uPhase');
  });

  it('lets the user dial the scene down to its calmest', () => {
    // Every rate is scaled by the dial, and both beat-driven terms vanish with
    // it — at zero the field is slow rather than stopped.
    expect(AMBIENT_SCENE.vertex).toContain('mix(kCalm, 1.0, uIntensity)');
    expect(AMBIENT_SCENE.vertex).toContain('uSwell * uIntensity * uBeat');
  });

  it('makes the album the source in both halves of the picture', () => {
    expect(AMBIENT_SCENE.fragment).toContain('texture(uArt, vUv)');
    expect(AMBIENT_SCENE.fragment).toContain('uAccent');
    expect(AMBIENT_SCENE.fragment).toContain('uBackdrop');
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(AMBIENT_SCENE.params)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  /**
   * The coupling that keeps the painter's ordering true. `buildAmbientGeometry`
   * proves the depth bands hold at exactly these two ceilings, so a preset must
   * not be able to ask for more than the roster was checked against.
   */
  it('caps size and swell at the values the depth check was made against', () => {
    expect(AMBIENT_SCENE.params['size']?.max).toBe(SIZE_CEILING);
    expect(AMBIENT_SCENE.params['swell']?.max).toBe(SWELL_CEILING);
  });

  /**
   * Not an aesthetic choice like the tunnel's: no render target in the pipeline
   * has a depth attachment, so the test would be a comparison against a buffer
   * that is not there. The scene sorts itself instead.
   */
  it('runs without a depth buffer, because there is not one to run with', () => {
    expect(AMBIENT_SCENE.depthTest).toBe(false);
    expect(AMBIENT_SCENE.vertex).toContain('vec4(2.0, 2.0, 2.0, 1.0)');
  });

  it('binds its attributes where the vertex shader declares them', () => {
    const declared: readonly (readonly [number, number, string])[] = [
      [ATTRIBUTE_POSITION, 3, 'vec3 aPosition'],
      [ATTRIBUTE_FACE, 4, 'vec4 aFace'],
      [ATTRIBUTE_UV, 2, 'vec2 aUv'],
      [ATTRIBUTE_HOME, 3, 'vec3 aHome'],
      [ATTRIBUTE_SPIN, 4, 'vec4 aSpin'],
      [ATTRIBUTE_TRAIT, 4, 'vec4 aTrait'],
    ];

    for (const [location, , declaration] of declared) {
      expect(AMBIENT_SCENE.vertex).toContain(
        `layout(location = ${String(location)}) in ${declaration};`,
      );
    }
    expect(
      AMBIENT_MESH.attributes.map((attribute) => [attribute.location, attribute.size]),
    ).toEqual(declared.map(([location, size]) => [location, size]));
  });

  it('has no discard and no data-dependent loop', () => {
    for (const source of sources) {
      expect(source).not.toContain('discard');
      expect(source).not.toContain('for (');
      expect(source).not.toContain('while');
    }
  });
});
