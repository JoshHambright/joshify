import { describe, expect, it } from 'vitest';
import type { GeometrySpec } from '../gl-context.js';
import { paramUniformName } from '../uniforms.js';
import {
  ATTRIBUTE_CELL,
  ATTRIBUTE_UV,
  MIRROR_PERIOD_COVERS,
  TERRAIN_GEOMETRY_OPTIONS,
  TERRAIN_MESH,
  TERRAIN_SCENE,
  buildTerrainGeometry,
  mirrorCoordinate,
  terrainWrapRows,
  type TerrainGeometryOptions,
} from './terrain.js';

/**
 * CI has no GPU, and a heightfield cannot be checked by looking at it anyway —
 * a landscape that is subtly wrong still looks like a landscape. What is left
 * is the arithmetic, which is also where the bugs are: a grid one vertex out, a
 * V step a fraction off, or a fold that does not actually fold.
 */

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
  /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*(?:\[\d+])?\s*;/gm;

const declaredUniforms = (source: string): readonly string[] =>
  [...source.matchAll(UNIFORM)].map(([, name]) => name ?? '');

const attributeData = (spec: GeometrySpec, location: number): Float32Array => {
  const found = spec.attributes.find((attribute) => attribute.location === location);
  if (found === undefined)
    throw new Error(`no attribute at location ${String(location)}`);
  return found.data;
};

const indicesOf = (spec: GeometrySpec): Uint16Array => {
  if (spec.indices === undefined) throw new Error('the terrain mesh must be indexed');
  return spec.indices;
};

const at = (values: Float32Array | Uint16Array, index: number): number =>
  values[index] ?? Number.NaN;

/** A small grid, so an assertion can name every vertex it expects. */
const small: TerrainGeometryOptions = { columns: 6, rows: 4, rowsPerCover: 2 };
const perRow = small.columns + 1;

describe('the grid mesh', () => {
  it('builds one more line of vertices than there are cells, in both axes', () => {
    const mesh = buildTerrainGeometry(small);
    const vertices = (small.columns + 1) * (small.rows + 1);

    expect(attributeData(mesh, ATTRIBUTE_CELL).length).toBe(vertices * 2);
    expect(attributeData(mesh, ATTRIBUTE_UV).length).toBe(vertices * 2);
    // Two triangles per cell.
    expect(indicesOf(mesh).length).toBe(small.rows * small.columns * 6);
    expect(mesh.count).toBe(indicesOf(mesh).length);
  });

  it('is 6305 vertices and 12288 triangles at its defaults', () => {
    const { columns, rows } = TERRAIN_GEOMETRY_OPTIONS;

    expect(attributeData(TERRAIN_MESH, ATTRIBUTE_CELL).length / 2).toBe(
      (columns + 1) * (rows + 1),
    );
    expect((columns + 1) * (rows + 1)).toBe(6305);
    expect(TERRAIN_MESH.count / 3).toBe(12288);
  });

  it('centres the strip on the flight path and numbers the rows from the camera', () => {
    const mesh = buildTerrainGeometry(small);
    const cells = attributeData(mesh, ATTRIBUTE_CELL);
    const half = small.columns / 2;

    for (let row = 0; row <= small.rows; row += 1) {
      for (let column = 0; column <= small.columns; column += 1) {
        const vertex = row * perRow + column;
        const x = at(cells, vertex * 2);
        // Cells are one world unit square, which is what lets the fragment
        // shader draw its grid lines straight off this coordinate.
        expect(x).toBe(column - half);
        expect(x).toBeGreaterThanOrEqual(-half);
        expect(x).toBeLessThanOrEqual(half);
        expect(at(cells, vertex * 2 + 1)).toBe(row);
      }
    }
  });

  it('has no NaN in it', () => {
    const mesh = buildTerrainGeometry(small);

    for (const data of [
      attributeData(mesh, ATTRIBUTE_CELL),
      attributeData(mesh, ATTRIBUTE_UV),
    ]) {
      for (const value of data) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('refuses a grid that is not a grid', () => {
    expect(() => buildTerrainGeometry({ ...small, columns: 1 })).toThrow(RangeError);
    expect(() => buildTerrainGeometry({ ...small, rows: 0 })).toThrow(RangeError);
    expect(() => buildTerrainGeometry({ ...small, columns: 6.5 })).toThrow(RangeError);
  });
});

describe('the fold', () => {
  /**
   * Mirroring rather than repeating is what stops a tiled cover putting a cliff
   * across the landscape — a repeat is discontinuous at every tile edge, and a
   * discontinuity in a heightfield is a wall.
   */
  it('leaves the cover alone over its own range', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      expect(mirrorCoordinate(value)).toBeCloseTo(value, 12);
    }
  });

  it('reflects rather than repeating past the edge, so it is continuous', () => {
    expect(mirrorCoordinate(1.25)).toBeCloseTo(0.75, 12);
    expect(mirrorCoordinate(1.999)).toBeCloseTo(0.001, 12);
    // The join either side of the seam agrees to as many places as it is asked.
    expect(mirrorCoordinate(1 - 1e-6)).toBeCloseTo(mirrorCoordinate(1 + 1e-6), 5);
  });

  it('repeats exactly every two covers, in both directions', () => {
    for (const value of [0.1, 0.4, 0.93, 1.6]) {
      expect(mirrorCoordinate(value + MIRROR_PERIOD_COVERS)).toBeCloseTo(
        mirrorCoordinate(value),
        12,
      );
      expect(mirrorCoordinate(value - MIRROR_PERIOD_COVERS)).toBeCloseTo(
        mirrorCoordinate(value),
        12,
      );
    }
  });

  it('stays inside the cover for any coordinate at all', () => {
    for (const value of [-9.3, -1, 0, 3.7, 40.25]) {
      expect(mirrorCoordinate(value)).toBeGreaterThanOrEqual(0);
      expect(mirrorCoordinate(value)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the texture wrap', () => {
  const mesh = buildTerrainGeometry(small);
  const uvs = attributeData(mesh, ATTRIBUTE_UV);
  const vOf = (row: number): number => at(uvs, row * perRow * 2 + 1);

  /**
   * The same trick and the same obligation as the tunnel. The mesh stands
   * still; the shader scrolls it by `fract(travel)` of a cell and adds
   * `floor(travel)` rows to V, so a recycled vertex carries the terrain of the
   * row it replaced. What has to be proved is the *counter's* wrap: `travel` is
   * taken modulo `2 * rowsPerCover` rows so it cannot grow until its fractional
   * part quantises, and that substitution is invisible only if two covers of V
   * is exactly the period of the fold.
   */
  it('steps V by one row of cover between rows', () => {
    for (let row = 0; row < small.rows; row += 1) {
      expect(vOf(row + 1) - vOf(row)).toBeCloseTo(1 / small.rowsPerCover, 12);
    }
  });

  it('wraps the travel counter at exactly the mirror period, so nothing jumps', () => {
    const wrap = terrainWrapRows(small);

    expect(wrap).toBe(small.rowsPerCover * MIRROR_PERIOD_COVERS);
    // What the shader actually samples, once the fold has been applied: a
    // vertex whose V has been shifted by a whole wrap reads the same texels.
    for (let row = 0; row <= small.rows; row += 1) {
      const shifted = vOf(row) + wrap / small.rowsPerCover;
      expect(mirrorCoordinate(shifted)).toBeCloseTo(mirrorCoordinate(vOf(row)), 12);
    }
  });

  it('keeps the shader constant and the wrap in step', () => {
    // The vertex shader carries the wrap as a literal. If the two ever
    // disagree, the landscape jumps once every wrap and nothing else says so.
    expect(TERRAIN_SCENE.vertex).toContain(
      `const float kWrapRows = ${terrainWrapRows().toFixed(5)};`,
    );
  });

  it('gives every vertex in a row the same V, so the land does not shear', () => {
    for (let row = 0; row <= small.rows; row += 1) {
      for (let column = 0; column <= small.columns; column += 1) {
        expect(at(uvs, (row * perRow + column) * 2 + 1)).toBe(vOf(row));
      }
    }
  });

  it('spans exactly one cover across the strip, with no lateral tiling', () => {
    for (let column = 0; column <= small.columns; column += 1) {
      const u = at(uvs, column * 2);
      // Six places, because this is the Float32Array the GPU will read.
      expect(u).toBeCloseTo(column / small.columns, 6);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a fractional rowsPerCover, which would jump on every wrap', () => {
    expect(() => buildTerrainGeometry({ ...small, rowsPerCover: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => buildTerrainGeometry({ ...small, rowsPerCover: 0 })).toThrow(RangeError);
  });
});

describe('the index buffer', () => {
  it('references only vertices that exist, and fits in 16 bits', () => {
    const mesh = buildTerrainGeometry(small);
    const vertices = (small.columns + 1) * (small.rows + 1);

    for (const index of indicesOf(mesh)) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertices);
    }
    for (const index of indicesOf(TERRAIN_MESH)) expect(index).toBeLessThan(65536);
  });

  it('winds every triangle the same way', () => {
    const indices = indicesOf(buildTerrainGeometry(small));
    // Measured in (column, row) parameter space rather than on screen: the
    // heightfield is displaced in the vertex shader, and a triangle over a cliff
    // can legitimately flip its projected orientation.
    const cross = (triangle: number): number => {
      const corner = (offset: number): readonly [number, number] => {
        const vertex = at(indices, triangle * 3 + offset);
        return [vertex % perRow, Math.floor(vertex / perRow)];
      };
      const [ax, ay] = corner(0);
      const [bx, by] = corner(1);
      const [cx, cy] = corner(2);
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    };

    const first = Math.sign(cross(0));
    expect(first).not.toBe(0);
    for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
      expect(Math.sign(cross(triangle))).toBe(first);
    }
  });

  /**
   * There is no depth attachment on the chain's render targets, so draw order
   * is the only thing deciding what is in front. Back to front is exact for a
   * heightfield — cells occupy disjoint slices of z — which is why this scene
   * can run without a depth buffer at all rather than merely getting away with
   * it.
   */
  it('draws the horizon first and the camera last', () => {
    const indices = indicesOf(buildTerrainGeometry(small));
    const quads = indices.length / 6;
    const rowOf = (quad: number): number => Math.floor(at(indices, quad * 6) / perRow);

    expect(rowOf(0)).toBe(small.rows - 1);
    for (let quad = 1; quad < quads; quad += 1) {
      expect(rowOf(quad)).toBeLessThanOrEqual(rowOf(quad - 1));
    }
    expect(rowOf(quads - 1)).toBe(0);
  });

  it('covers each cell with exactly its four corners', () => {
    const indices = indicesOf(buildTerrainGeometry(small));

    for (let quad = 0; quad < indices.length / 6; quad += 1) {
      const corners = new Set(
        Array.from({ length: 6 }, (_unused, offset) => at(indices, quad * 6 + offset)),
      );
      const near = Math.min(...corners);

      expect(corners).toEqual(new Set([near, near + 1, near + perRow, near + perRow + 1]));
    }
  });

  it('refuses a mesh too big for a 16-bit index rather than wrapping silently', () => {
    expect(() => buildTerrainGeometry({ ...small, columns: 400, rows: 400 })).toThrow(
      RangeError,
    );
  });
});

describe('the terrain scene', () => {
  const sources = [TERRAIN_SCENE.vertex, TERRAIN_SCENE.fragment];

  it('is named the way a preset names it', () => {
    expect(TERRAIN_SCENE.id).toMatch(/^[a-z]+$/);
    expect(TERRAIN_SCENE.geometry).toBe(TERRAIN_MESH);
  });

  /**
   * A leading newline from a template literal is a compile error, and one that
   * only appears on a device with a GPU.
   */
  it('starts both shaders with the version directive', () => {
    for (const source of sources)
      expect(source.startsWith('#version 300 es\n')).toBe(true);
  });

  it('declares a uniform for every parameter it advertises', () => {
    const source = sources.join('\n');
    for (const name of Object.keys(TERRAIN_SCENE.params)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  /**
   * A uniform the shader reads but nothing sets is zero, silently — and a
   * terrain with `uHeight = 0` is a flat grey plain with no error anywhere.
   */
  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(TERRAIN_SCENE.params).map(paramUniformName),
    ]);

    for (const source of sources) {
      const declared = declaredUniforms(source);
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(allowed).toContain(name);
    }
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(TERRAIN_SCENE.params)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  /**
   * The whole scene rests on this: the height has to be known before the vertex
   * is placed, so the *vertex* shader samples the cover. GLES 3.0 guarantees at
   * least 16 vertex texture units (GLES 2.0 guaranteed none), and `uArt` is a
   * program-scoped sampler bound to a unit by `pipeline.ts`, so the vertex stage
   * sees the same texture the fragment stage does.
   */
  it('displaces the mesh with a vertex texture fetch of the album cover', () => {
    expect(TERRAIN_SCENE.vertex).toContain('uniform sampler2D uArt;');
    expect(TERRAIN_SCENE.vertex).toContain('texture(uArt,');
  });

  it('low-passes the cover and takes its gradient from the same taps', () => {
    // Five taps: the centre plus four arms, which are also the two differences
    // the lighting needs. One without the other would be a bug in the trade.
    expect(TERRAIN_SCENE.vertex).toContain('vec3 relief(vec2 uv)');
    expect(TERRAIN_SCENE.vertex).toContain('(right - left)');
    expect(TERRAIN_SCENE.vertex).toContain('(front - back)');
  });

  it('folds the cover in both stages rather than tiling it', () => {
    for (const source of sources) expect(source).toContain('mirrorUv');
  });

  /** The far edge has to dissolve, or the mesh ends in a line across the sky. */
  it('fogs the distance and then fades it to the cleared background', () => {
    expect(TERRAIN_SCENE.fragment).toContain('uFog');
    expect(TERRAIN_SCENE.fragment).toContain('kMeshDepth');
  });

  /**
   * `createFramebuffer` attaches colour only, so a depth test on a chain target
   * is a no-op that reads like a guarantee. The index order is the occlusion.
   */
  it('runs without a depth buffer, because there is not one to run with', () => {
    expect(TERRAIN_SCENE.depthTest).toBe(false);
  });

  it('binds its attributes where the vertex shader declares them', () => {
    expect(TERRAIN_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_CELL)}) in vec2 aCell;`,
    );
    expect(TERRAIN_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_UV)}) in vec2 aUv;`,
    );
    expect(
      TERRAIN_MESH.attributes.map((attribute) => [attribute.location, attribute.size]),
    ).toEqual([
      [ATTRIBUTE_CELL, 2],
      [ATTRIBUTE_UV, 2],
    ]);
  });

  it('has no discard and no data-dependent loop', () => {
    for (const source of sources) {
      expect(source).not.toContain('discard');
      expect(source).not.toContain('for (');
      expect(source).not.toContain('while');
    }
  });

  /** `half` is reserved in GLSL ES 3.00 and the compiler is right to say so. */
  it('uses no reserved word as an identifier', () => {
    for (const source of sources) {
      for (const reserved of ['half', 'input', 'output', 'sizeof', 'union']) {
        expect(source).not.toMatch(new RegExp(`\\b(?:float|vec[234]|int)\\s+${reserved}\\b`));
      }
    }
  });
});
