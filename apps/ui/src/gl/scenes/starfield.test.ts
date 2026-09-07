import { describe, expect, it } from 'vitest';
import type { GeometrySpec } from '../gl-context.js';
import { paramUniformName } from '../uniforms.js';
import {
  ATTRIBUTE_CORNER,
  ATTRIBUTE_STAR,
  STARFIELD_GEOMETRY_OPTIONS,
  STARFIELD_MESH,
  STARFIELD_SCENE,
  STAR_CORNERS,
  buildStarfieldGeometry,
  type StarfieldGeometryOptions,
} from './starfield.js';

/**
 * The field is generated, so the interesting assertions are about its
 * *distribution* rather than about any one star: a starfield that clumps, or
 * whose depth correlates with screen position, still renders — it just looks
 * obviously computed, which is the failure this file exists to catch.
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
  if (spec.indices === undefined) throw new Error('the starfield mesh must be indexed');
  return spec.indices;
};

const at = (values: Float32Array | Uint16Array, index: number): number =>
  values[index] ?? Number.NaN;

const CORNERS = STAR_CORNERS.length;

/** One value per star, read off the first corner of each quad. */
const perStar = (spec: GeometrySpec, component: number): readonly number[] => {
  const data = attributeData(spec, ATTRIBUTE_STAR);
  const stars = data.length / (4 * CORNERS);
  return Array.from({ length: stars }, (_unused, star) =>
    at(data, star * CORNERS * 4 + component),
  );
};

const small: StarfieldGeometryOptions = { lattice: 8, layers: 3, seed: 12345 };

describe('the star mesh', () => {
  it('is two triangles a star, because the context only draws triangles', () => {
    // `GlContext.draw` issues gl.TRIANGLES and nothing else — there is no
    // gl.POINTS to fall back on, and adding one would mean editing the single
    // file in this directory that touches WebGL.
    const mesh = buildStarfieldGeometry(small);
    const stars = small.lattice * small.lattice;

    expect(attributeData(mesh, ATTRIBUTE_STAR).length).toBe(stars * CORNERS * 4);
    expect(attributeData(mesh, ATTRIBUTE_CORNER).length).toBe(stars * CORNERS * 2);
    expect(indicesOf(mesh).length).toBe(stars * 6);
    expect(mesh.count).toBe(indicesOf(mesh).length);
  });

  it('is 1024 stars and 4096 vertices at its defaults', () => {
    const { lattice } = STARFIELD_GEOMETRY_OPTIONS;

    expect(lattice * lattice).toBe(1024);
    expect(attributeData(STARFIELD_MESH, ATTRIBUTE_STAR).length / 4).toBe(4096);
    expect(STARFIELD_MESH.count).toBe(1024 * 6);
  });

  it('gives all four corners of a star the same star', () => {
    const mesh = buildStarfieldGeometry(small);
    const data = attributeData(mesh, ATTRIBUTE_STAR);
    const corners = attributeData(mesh, ATTRIBUTE_CORNER);
    const stars = small.lattice * small.lattice;

    for (let star = 0; star < stars; star += 1) {
      for (let corner = 0; corner < CORNERS; corner += 1) {
        const vertex = star * CORNERS + corner;
        for (let component = 0; component < 4; component += 1) {
          expect(at(data, vertex * 4 + component)).toBe(
            at(data, star * CORNERS * 4 + component),
          );
        }
        // The quad's own coordinate is what shapes the star in the fragment
        // shader and what the beat streak is built in.
        expect([at(corners, vertex * 2), at(corners, vertex * 2 + 1)]).toEqual([
          ...(STAR_CORNERS[corner] ?? []),
        ]);
      }
    }
  });

  it('has no NaN in it', () => {
    const mesh = buildStarfieldGeometry(small);

    for (const data of [
      attributeData(mesh, ATTRIBUTE_STAR),
      attributeData(mesh, ATTRIBUTE_CORNER),
    ]) {
      for (const value of data) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('builds the same field every run, so a test of it is not a coin toss', () => {
    const first = attributeData(buildStarfieldGeometry(small), ATTRIBUTE_STAR);
    const again = attributeData(buildStarfieldGeometry(small), ATTRIBUTE_STAR);
    const other = attributeData(
      buildStarfieldGeometry({ ...small, seed: 999 }),
      ATTRIBUTE_STAR,
    );

    expect([...again]).toEqual([...first]);
    expect([...other]).not.toEqual([...first]);
  });

  it('refuses a field it could not index in 16 bits, or could not lay out', () => {
    expect(() => buildStarfieldGeometry({ ...small, lattice: 200 })).toThrow(RangeError);
    expect(() => buildStarfieldGeometry({ ...small, lattice: 1 })).toThrow(RangeError);
    expect(() => buildStarfieldGeometry({ ...small, layers: 0 })).toThrow(RangeError);
    expect(() => buildStarfieldGeometry({ ...small, lattice: 8.5 })).toThrow(RangeError);
  });
});

describe('where the stars are', () => {
  const mesh = buildStarfieldGeometry(small);
  const xs = perStar(mesh, 0);
  const ys = perStar(mesh, 1);

  it('fills the field without clumping: exactly one star per lattice cell', () => {
    // A jittered lattice rather than uniform random. With a thousand samples,
    // uniform random leaves holes and clusters big enough to see as structure.
    const seen = new Set<string>();
    for (let star = 0; star < xs.length; star += 1) {
      const x = xs[star] ?? Number.NaN;
      const y = ys[star] ?? Number.NaN;
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(1);
      const column = Math.min(
        small.lattice - 1,
        Math.floor(((x + 1) / 2) * small.lattice),
      );
      const row = Math.min(small.lattice - 1, Math.floor(((y + 1) / 2) * small.lattice));
      seen.add(`${String(column)}:${String(row)}`);
    }

    expect(seen.size).toBe(xs.length);
  });

  it('jitters inside the cell rather than sitting on the lattice', () => {
    // A bare lattice is a grid of stars, which is worse than a clump.
    const exact = xs.filter((x, star) => {
      const cell = ((x + 1) / 2) * small.lattice;
      return Number.isInteger(cell) && Number.isInteger((ys[star] ?? 0.5) * 2);
    });

    expect(exact.length).toBe(0);
  });
});

describe('how deep the stars are', () => {
  const mesh = buildStarfieldGeometry(small);
  const depths = perStar(mesh, 2);

  it('spans the range instead of clustering in it', () => {
    // Stratified: one depth per 1/stars slice, so every part of the field is
    // occupied and no sheet of stars arrives at once.
    expect(Math.min(...depths)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...depths)).toBeLessThan(1);
    expect(Math.min(...depths)).toBeLessThan(1 / depths.length);
    expect(Math.max(...depths)).toBeGreaterThan(1 - 2 / depths.length);

    const buckets = Array.from({ length: 10 }, () => 0);
    for (const depth of depths) {
      const bucket = Math.min(9, Math.floor(depth * 10));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    const expected = depths.length / 10;
    for (const count of buckets) {
      expect(count).toBeGreaterThanOrEqual(Math.floor(expected));
      expect(count).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    }
  });

  it('carries no correlation with where the star is on screen', () => {
    // The one arrangement that looks obviously generated: unshuffled strata
    // over a lattice put the whole field on a diagonal plane. Measured on the
    // real 1024-star field, where the sampling error of a correlation is about
    // 0.03 — on the eight-by-eight test mesh it is 0.13, and the assertion
    // would be measuring noise rather than the shuffle.
    const full = perStar(STARFIELD_MESH, 2);
    const xs = perStar(STARFIELD_MESH, 0);
    const mean = (values: readonly number[]): number =>
      values.reduce((total, value) => total + value, 0) / values.length;
    const meanDepth = mean(full);
    const meanX = mean(xs);
    let covariance = 0;
    let varianceDepth = 0;
    let varianceX = 0;
    for (let star = 0; star < full.length; star += 1) {
      const depth = (full[star] ?? 0) - meanDepth;
      const x = (xs[star] ?? 0) - meanX;
      covariance += depth * x;
      varianceDepth += depth * depth;
      varianceX += x * x;
    }

    expect(Math.abs(covariance / Math.sqrt(varianceDepth * varianceX))).toBeLessThan(
      0.12,
    );
  });
});

describe('the parallax layers', () => {
  const mesh = buildStarfieldGeometry(small);
  const layers = perStar(mesh, 3);

  it('shares the stars out evenly, and names each layer by an index', () => {
    const counts = Array.from({ length: small.layers }, () => 0);
    for (const layer of layers) {
      expect(Number.isInteger(layer)).toBe(true);
      expect(layer).toBeGreaterThanOrEqual(0);
      expect(layer).toBeLessThan(small.layers);
      counts[layer] = (counts[layer] ?? 0) + 1;
    }

    const expected = layers.length / small.layers;
    for (const count of counts) {
      expect(Math.abs(count - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('does not stripe them across the lattice', () => {
    // `index % layers` over a lattice paints diagonal bands of speed, which
    // reads as three moving sheets rather than as depth.
    const firstRow = layers.slice(0, small.lattice);

    expect(new Set(firstRow).size).toBeGreaterThan(1);
  });
});

describe('the index buffer', () => {
  it('references only vertices that exist, and fits in 16 bits', () => {
    const mesh = buildStarfieldGeometry(small);
    const vertices = small.lattice * small.lattice * CORNERS;

    for (const index of indicesOf(mesh)) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertices);
    }
    for (const index of indicesOf(STARFIELD_MESH)) expect(index).toBeLessThan(65536);
  });

  it('winds every triangle the same way', () => {
    const mesh = buildStarfieldGeometry(small);
    const corners = attributeData(mesh, ATTRIBUTE_CORNER);
    const indices = indicesOf(mesh);
    // In the quad's own coordinates: on screen a star is rotated to face its
    // direction of travel, so screen-space orientation is not the invariant.
    const cross = (triangle: number): number => {
      const corner = (offset: number): readonly [number, number] => {
        const vertex = at(indices, triangle * 3 + offset);
        return [at(corners, vertex * 2), at(corners, vertex * 2 + 1)];
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

  it('covers each star with exactly its four corners', () => {
    const indices = indicesOf(buildStarfieldGeometry(small));

    for (let star = 0; star < indices.length / 6; star += 1) {
      const used = new Set(
        Array.from({ length: 6 }, (_unused, offset) => at(indices, star * 6 + offset)),
      );
      const base = star * CORNERS;

      expect(used).toEqual(new Set([base, base + 1, base + 2, base + 3]));
    }
  });
});

describe('the starfield scene', () => {
  const sources = [STARFIELD_SCENE.vertex, STARFIELD_SCENE.fragment];

  it('is named the way a preset names it', () => {
    expect(STARFIELD_SCENE.id).toMatch(/^[a-z]+$/);
    expect(STARFIELD_SCENE.geometry).toBe(STARFIELD_MESH);
  });

  it('starts both shaders with the version directive', () => {
    for (const source of sources)
      expect(source.startsWith('#version 300 es\n')).toBe(true);
  });

  it('declares a uniform for every parameter it advertises', () => {
    const source = sources.join('\n');
    for (const name of Object.keys(STARFIELD_SCENE.params)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(STARFIELD_SCENE.params).map(paramUniformName),
    ]);

    for (const source of sources) {
      const declared = declaredUniforms(source);
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(allowed).toContain(name);
    }
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(STARFIELD_SCENE.params)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  /**
   * A generic starfield is a screensaver. This one samples the cover once per
   * star — a 32 x 32 point sampling of the artwork, scattered through depth —
   * and takes both its colour and its visible density from it.
   */
  it('samples the album cover once per star, in the vertex shader', () => {
    expect(STARFIELD_SCENE.vertex).toContain('uniform sampler2D uArt;');
    expect(STARFIELD_SCENE.vertex).toContain('texture(uArt, aStar.xy * 0.5 + 0.5)');
    expect(STARFIELD_SCENE.vertex).toContain('uTint');
    expect(STARFIELD_SCENE.vertex).toContain('uDensity');
  });

  /** D-071: the beat moves things. Luminance is capped globally, motion is not. */
  it('streaks on the beat instead of brightening, and conserves the light', () => {
    expect(STARFIELD_SCENE.vertex).toContain('float stretch = 1.0 + uWarp * uBeat');
    expect(STARFIELD_SCENE.vertex).toContain('sqrt(stretch)');
  });

  it('has a defined direction at the vanishing point', () => {
    // normalize() of the centre star's position is a division by zero, and one
    // NaN vertex takes its whole quad with it.
    expect(STARFIELD_SCENE.vertex).toContain('radius > 0.0001');
  });

  it('runs without a depth buffer, because there is not one to run with', () => {
    expect(STARFIELD_SCENE.depthTest).toBe(false);
  });

  it('binds its attributes where the vertex shader declares them', () => {
    expect(STARFIELD_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_STAR)}) in vec4 aStar;`,
    );
    expect(STARFIELD_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_CORNER)}) in vec2 aCorner;`,
    );
    expect(
      STARFIELD_MESH.attributes.map((attribute) => [attribute.location, attribute.size]),
    ).toEqual([
      [ATTRIBUTE_STAR, 4],
      [ATTRIBUTE_CORNER, 2],
    ]);
  });

  /**
   * The scene stage draws unblended, so a star's quad has to fall to the
   * cleared background at its edges rather than being cut out with `discard`.
   */
  it('has no discard and no data-dependent loop', () => {
    for (const source of sources) {
      expect(source).not.toContain('discard');
      expect(source).not.toContain('for (');
      expect(source).not.toContain('while');
    }
  });
});
