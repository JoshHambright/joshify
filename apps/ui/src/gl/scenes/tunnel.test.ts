import { describe, expect, it } from 'vitest';
import type { GeometrySpec } from '../gl-context.js';
import { paramUniformName } from '../uniforms.js';
import {
  ATTRIBUTE_RING,
  ATTRIBUTE_UV,
  TUNNEL_GEOMETRY_OPTIONS,
  TUNNEL_MESH,
  TUNNEL_SCENE,
  buildTunnelGeometry,
  type TunnelGeometryOptions,
} from './tunnel.js';

/**
 * None of this can be tested by looking at it, and CI has no GPU. What is left
 * is the arithmetic — which is also where the bugs are, because a mesh that is
 * one vertex out or a UV that is a fraction off does not fail, it just looks
 * subtly wrong in a way nobody can point at.
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
  if (spec.indices === undefined) throw new Error('the tunnel mesh must be indexed');
  return spec.indices;
};

const at = (values: Float32Array | Uint16Array, index: number): number =>
  values[index] ?? Number.NaN;

/** A small mesh, so an assertion can name every vertex it expects. */
const small: TunnelGeometryOptions = {
  rings: 4,
  segments: 6,
  repeatsAround: 2,
  repeatsPerRing: 1,
};

describe('the ring mesh', () => {
  it('builds one more ring than there are gaps, and closes each ring', () => {
    const mesh = buildTunnelGeometry(small);
    const vertices = (small.rings + 1) * (small.segments + 1);

    expect(attributeData(mesh, ATTRIBUTE_RING).length).toBe(vertices * 3);
    expect(attributeData(mesh, ATTRIBUTE_UV).length).toBe(vertices * 2);
    // Two triangles per quad, and a quad for every gap in both directions.
    expect(indicesOf(mesh).length).toBe(small.rings * small.segments * 6);
    expect(mesh.count).toBe(indicesOf(mesh).length);
  });

  it('is the spike mesh at its defaults: ~1600 vertices, one draw call', () => {
    const rings = TUNNEL_GEOMETRY_OPTIONS.rings;
    const segments = TUNNEL_GEOMETRY_OPTIONS.segments;

    expect(attributeData(TUNNEL_MESH, ATTRIBUTE_RING).length / 3).toBe(
      (rings + 1) * (segments + 1),
    );
    expect(TUNNEL_MESH.count).toBe(rings * segments * 6);
  });

  it('puts every vertex on the unit circle, at its own ring', () => {
    const mesh = buildTunnelGeometry(small);
    const positions = attributeData(mesh, ATTRIBUTE_RING);

    for (let ring = 0; ring <= small.rings; ring += 1) {
      for (let segment = 0; segment <= small.segments; segment += 1) {
        const vertex = ring * (small.segments + 1) + segment;
        const x = at(positions, vertex * 3);
        const y = at(positions, vertex * 3 + 1);
        // The radius is a uniform, so the mesh itself is a unit tube; scaling
        // it here would make `uRadius` a multiplier of a magic number. Six
        // places, because these are the Float32Array the GPU will read.
        expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
        expect(at(positions, vertex * 3 + 2)).toBe(ring);
      }
    }
  });

  it('closes the ring on itself rather than leaving a gap', () => {
    const mesh = buildTunnelGeometry(small);
    const positions = attributeData(mesh, ATTRIBUTE_RING);
    const last = small.segments;

    expect(at(positions, 0)).toBeCloseTo(at(positions, last * 3), 12);
    expect(at(positions, 1)).toBeCloseTo(at(positions, last * 3 + 1), 12);
  });

  it('has no NaN in it for any ring index', () => {
    const mesh = buildTunnelGeometry(small);

    for (const data of [
      attributeData(mesh, ATTRIBUTE_RING),
      attributeData(mesh, ATTRIBUTE_UV),
    ]) {
      for (const value of data) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('the texture wrap (P5-25)', () => {
  /**
   * The scroll wrap is the whole trick: the mesh never moves, the shader
   * scrolls it by `mod(time, one ring)`, and so ring `n` is drawn where ring
   * `n+1` stood a moment earlier. That substitution is invisible if and only
   * if consecutive rings carry the same texture content — a whole number of
   * copies of the cover apart.
   */
  it('steps V by a whole number of covers between rings, so the wrap has no seam', () => {
    const mesh = buildTunnelGeometry(small);
    const uvs = attributeData(mesh, ATTRIBUTE_UV);
    const vOf = (ring: number): number => at(uvs, ring * (small.segments + 1) * 2 + 1);

    for (let ring = 0; ring < small.rings; ring += 1) {
      const step = vOf(ring + 1) - vOf(ring);
      expect(step).toBe(small.repeatsPerRing);
      expect(Number.isInteger(step)).toBe(true);
      // What the shader actually samples, once fract() has wrapped it: the
      // ring that takes another's place samples the same texels.
      expect(vOf(ring + 1) % 1).toBeCloseTo(vOf(ring) % 1, 12);
    }
  });

  it('gives every vertex in a ring the same V, so the tube does not shear', () => {
    const mesh = buildTunnelGeometry(small);
    const uvs = attributeData(mesh, ATTRIBUTE_UV);

    for (let ring = 0; ring <= small.rings; ring += 1) {
      const first = at(uvs, ring * (small.segments + 1) * 2 + 1);
      for (let segment = 0; segment <= small.segments; segment += 1) {
        const vertex = ring * (small.segments + 1) + segment;
        expect(at(uvs, vertex * 2 + 1)).toBe(first);
      }
    }
  });

  /**
   * The circumference has a seam too — the vertex at `segments` is the vertex
   * at `0` again, one lap of U later. A whole number of copies around is what
   * lands it on the same texel.
   */
  it('spans a whole number of covers around the ring, so the seam matches', () => {
    const mesh = buildTunnelGeometry(small);
    const uvs = attributeData(mesh, ATTRIBUTE_UV);

    for (let ring = 0; ring <= small.rings; ring += 1) {
      const start = ring * (small.segments + 1);
      const span = at(uvs, (start + small.segments) * 2) - at(uvs, start * 2);
      expect(span).toBe(small.repeatsAround);
      expect(at(uvs, (start + small.segments) * 2) % 1).toBeCloseTo(
        at(uvs, start * 2) % 1,
        12,
      );
    }
  });

  it('spaces U evenly around the ring', () => {
    const mesh = buildTunnelGeometry(small);
    const uvs = attributeData(mesh, ATTRIBUTE_UV);
    const step = small.repeatsAround / small.segments;

    for (let segment = 0; segment <= small.segments; segment += 1) {
      expect(at(uvs, segment * 2)).toBeCloseTo(segment * step, 6);
    }
  });

  it('refuses a mesh whose repeats would put a ratchet in the tunnel', () => {
    expect(() => buildTunnelGeometry({ ...small, repeatsPerRing: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => buildTunnelGeometry({ ...small, repeatsAround: 0 })).toThrow(RangeError);
  });
});

describe('the index buffer', () => {
  it('references only vertices that exist, and fits in 16 bits', () => {
    const mesh = buildTunnelGeometry(small);
    const vertices = (small.rings + 1) * (small.segments + 1);

    for (const index of indicesOf(mesh)) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertices);
    }
    for (const index of indicesOf(TUNNEL_MESH)) expect(index).toBeLessThan(65536);
  });

  it('winds every triangle the same way', () => {
    const mesh = buildTunnelGeometry(small);
    const indices = indicesOf(mesh);
    const perRing = small.segments + 1;
    // Orientation is measured in (segment, ring) parameter space rather than
    // in the projected picture: the tube is closed, so half of any screen-
    // space test would be facing away and the sign would flip legitimately.
    const cross = (triangle: number): number => {
      const corner = (offset: number): readonly [number, number] => {
        const vertex = at(indices, triangle * 3 + offset);
        return [vertex % perRing, Math.floor(vertex / perRing)];
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
   * Artefact 04: no depth buffer, and `GlContext` has no face culling either,
   * so draw order is the only thing deciding what is in front. Back to front
   * is the painter's algorithm the PSX ran on the CPU.
   */
  it('draws the far end of the tube first', () => {
    const mesh = buildTunnelGeometry(small);
    const indices = indicesOf(mesh);
    const perRing = small.segments + 1;
    const quads = indices.length / 6;
    const ringOf = (quad: number): number => Math.floor(at(indices, quad * 6) / perRing);

    expect(ringOf(0)).toBe(small.rings - 1);
    for (let quad = 1; quad < quads; quad += 1) {
      expect(ringOf(quad)).toBeLessThanOrEqual(ringOf(quad - 1));
    }
    expect(ringOf(quads - 1)).toBe(0);
  });

  it('covers each quad with exactly its four corners', () => {
    const mesh = buildTunnelGeometry(small);
    const indices = indicesOf(mesh);
    const perRing = small.segments + 1;

    for (let quad = 0; quad < indices.length / 6; quad += 1) {
      const corners = new Set(
        Array.from({ length: 6 }, (_unused, offset) => at(indices, quad * 6 + offset)),
      );
      const near = Math.min(...corners);

      expect(corners).toEqual(
        new Set([near, near + 1, near + perRing, near + perRing + 1]),
      );
    }
  });

  it('refuses a mesh too big for a 16-bit index, rather than wrapping silently', () => {
    expect(() => buildTunnelGeometry({ ...small, rings: 4000, segments: 40 })).toThrow(
      RangeError,
    );
    expect(() => buildTunnelGeometry({ ...small, segments: 2 })).toThrow(RangeError);
    expect(() => buildTunnelGeometry({ ...small, rings: 0 })).toThrow(RangeError);
  });
});

describe('the tunnel scene', () => {
  const sources = [TUNNEL_SCENE.vertex, TUNNEL_SCENE.fragment];

  it('is named the way a preset names it', () => {
    expect(TUNNEL_SCENE.id).toMatch(/^[a-z]+$/);
    expect(TUNNEL_SCENE.geometry).toBe(TUNNEL_MESH);
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
    for (const name of Object.keys(TUNNEL_SCENE.params)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  /**
   * The one that matters most: a uniform the shader reads but nothing sets is
   * zero, silently, and a tunnel with `uRadius = 0` is a black screen with no
   * error anywhere.
   */
  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(TUNNEL_SCENE.params).map(paramUniformName),
    ]);

    for (const source of sources) {
      const declared = declaredUniforms(source);
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(allowed).toContain(name);
    }
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(TUNNEL_SCENE.params)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  /** Artefact 04 is a property of the scene, not a pass. */
  it('runs without a depth buffer', () => {
    expect(TUNNEL_SCENE.depthTest).toBe(false);
  });

  it('binds its attributes where the vertex shader declares them', () => {
    expect(TUNNEL_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_RING)}) in vec3 aRing;`,
    );
    expect(TUNNEL_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_UV)}) in vec2 aUv;`,
    );
    expect(
      TUNNEL_MESH.attributes.map((attribute) => [attribute.location, attribute.size]),
    ).toEqual([
      [ATTRIBUTE_RING, 3],
      [ATTRIBUTE_UV, 2],
    ]);
  });

  /**
   * The near-ring fade. Without it the geometry the camera is inside slides
   * sideways as the curve animates, and the tunnel reads as swimming rather
   * than bending — the failure PS1_MODE.md and the spike both call out.
   */
  it('eases the curve in from the camera', () => {
    expect(TUNNEL_SCENE.vertex).toContain('smoothstep(0.0, kCurveFade, -z)');
    expect(TUNNEL_SCENE.vertex).toContain('* ease');
  });

  /** Artefact 02 has to cancel the interpolator, in both halves or neither. */
  it('carries the affine UV across the interpolator premultiplied by w', () => {
    expect(TUNNEL_SCENE.vertex).toContain('vUv = aUv * vW;');
    expect(TUNNEL_SCENE.fragment).toContain('fract(vUv / vW)');
  });

  /**
   * The album texture is created clamped by the pipeline. Tiling with fract()
   * rather than leaning on GL_REPEAT is what stops that being a tube smeared
   * with one edge texel.
   */
  it('tiles the album art in the shader rather than trusting the wrap mode', () => {
    expect(TUNNEL_SCENE.fragment).toContain('uArt');
    expect(TUNNEL_SCENE.fragment).toContain('fract(');
  });

  it('has no discard and no data-dependent loop', () => {
    for (const source of sources) {
      expect(source).not.toContain('discard');
      expect(source).not.toContain('for (');
      expect(source).not.toContain('while');
    }
  });
});
