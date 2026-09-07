import { describe, expect, it } from 'vitest';
import type { GeometrySpec } from '../gl-context.js';
import { paramUniformName } from '../uniforms.js';
import {
  ATTRIBUTE_CORNER,
  ATTRIBUTE_FORM,
  BEAT_LIFT,
  BOB_AMPLITUDE,
  MAX_LANE_EXCURSION,
  REEF_GEOMETRY_OPTIONS,
  REEF_MESH,
  REEF_SCENE,
  ROLE_FORM,
  ROLE_WATER,
  buildReefGeometry,
  layoutReefLanes,
  type ReefGeometryOptions,
} from './reef.js';

/**
 * Nothing here can be tested by looking at it, and CI has no GPU. What is left
 * is the arithmetic and the contract — which is where the bugs are anyway. Two
 * classes in particular:
 *
 *  - **the lane packing**, because the scene stage draws with blending off into
 *    a target with no depth attachment, so two overlapping billboards would
 *    have one erasing the other with the water it drew itself;
 *  - **the calm guarantee**, because "no strobe" is only true for as long as
 *    `uBeat` stays out of the fragment stage, and that is one careless edit
 *    away at any time.
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
  /^\s*uniform\s+(?:(highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*(?:\[\d+])?\s*;/gm;

const declaredUniforms = (source: string): readonly string[] =>
  [...source.matchAll(UNIFORM)].map(([, , name]) => name ?? '');

/** Name to declared precision, for the uniforms that carry one explicitly. */
const explicitPrecisions = (source: string): ReadonlyMap<string, string> =>
  new Map(
    [...source.matchAll(UNIFORM)]
      .filter(([, precision]) => precision !== undefined)
      .map(([, precision, name]) => [name ?? '', precision ?? '']),
  );

const attributeData = (spec: GeometrySpec, location: number): Float32Array => {
  const found = spec.attributes.find((attribute) => attribute.location === location);
  if (found === undefined)
    throw new Error(`no attribute at location ${String(location)}`);
  return found.data;
};

const indicesOf = (spec: GeometrySpec): Uint16Array => {
  if (spec.indices === undefined) throw new Error('the reef mesh must be indexed');
  return spec.indices;
};

const at = (values: Float32Array | Uint16Array, index: number): number =>
  values[index] ?? Number.NaN;

/** Lines of a shader that mention a given uniform. */
const linesUsing = (source: string, name: string): readonly string[] =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .filter((line) => new RegExp(`\\b${name}\\b`).test(line));

/** A small layout, so an assertion can name every lane it expects. */
const small: ReefGeometryOptions = { forms: 3, clearance: 0.04, spread: 0.9 };

describe('the lane layout', () => {
  it('gives every form its own lane, deterministically', () => {
    const lanes = layoutReefLanes(small);

    expect(lanes).toHaveLength(small.forms);
    expect(lanes).toEqual(layoutReefLanes(small));
  });

  it('spreads depth and phase over 0..1 without repeating either', () => {
    const lanes = layoutReefLanes({ ...small, forms: 8 });

    for (const lane of lanes) {
      expect(lane.depth).toBeGreaterThanOrEqual(0);
      expect(lane.depth).toBeLessThan(1);
      expect(lane.phase).toBeGreaterThanOrEqual(0);
      expect(lane.phase).toBeLessThan(1);
    }
    expect(new Set(lanes.map((lane) => lane.depth)).size).toBe(8);
    // Depth and phase step by *different* irrationals: the same one for both
    // would make every form enter the frame in size order.
    expect(new Set(lanes.map((lane) => lane.phase)).size).toBe(8);
    expect(lanes.map((lane) => lane.phase)).not.toEqual(lanes.map((lane) => lane.depth));
  });

  it('tiles the whole spread, bottom to top, with no gap between lanes', () => {
    const lanes = layoutReefLanes(small);
    const height = (lane: (typeof lanes)[number]): number =>
      (lane.halfSize * (1 + MAX_LANE_EXCURSION) + small.clearance) * 2;

    const first = lanes[0];
    const last = lanes[lanes.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    expect(first.centre - height(first) / 2).toBeCloseTo(-small.spread, 12);
    expect(last.centre + height(last) / 2).toBeCloseTo(small.spread, 12);
    for (let index = 1; index < lanes.length; index += 1) {
      const below = lanes[index - 1];
      const above = lanes[index];
      if (below === undefined || above === undefined) continue;
      expect(below.centre + height(below) / 2).toBeCloseTo(
        above.centre - height(above) / 2,
        12,
      );
    }
  });

  /**
   * The invariant the whole mesh rests on. A billboard is opaque and draws its
   * own background, so it is invisible over the water — and lethal over another
   * form, which it would erase. The excursion has to be part of the sum: a form
   * bobs and takes a beat lift, and a layout that only clears its resting body
   * fails on the first loud track.
   */
  it('keeps forms apart even at the top of their bob and a full beat lift', () => {
    for (const forms of [1, 2, 5, 9]) {
      const lanes = layoutReefLanes({ ...REEF_GEOMETRY_OPTIONS, forms });
      const reach = (lane: (typeof lanes)[number]): number =>
        lane.halfSize * (1 + MAX_LANE_EXCURSION);

      for (const [index, lane] of lanes.entries()) {
        for (const other of lanes.slice(index + 1)) {
          expect(Math.abs(lane.centre - other.centre)).toBeGreaterThanOrEqual(
            reach(lane) + reach(other),
          );
        }
      }
    }
  });

  it('leaves the requested clearance between neighbours at their closest', () => {
    const lanes = layoutReefLanes(small);

    for (let index = 1; index < lanes.length; index += 1) {
      const below = lanes[index - 1];
      const above = lanes[index];
      if (below === undefined || above === undefined) continue;
      const clear =
        above.centre -
        above.halfSize * (1 + MAX_LANE_EXCURSION) -
        (below.centre + below.halfSize * (1 + MAX_LANE_EXCURSION));
      expect(clear).toBeCloseTo(small.clearance * 2, 12);
    }
  });

  it('makes near forms bigger than far ones, which is what sells the depth', () => {
    const lanes = [...layoutReefLanes({ ...small, forms: 6 })].sort(
      (a, b) => a.depth - b.depth,
    );

    for (let index = 1; index < lanes.length; index += 1) {
      const nearer = lanes[index - 1];
      const further = lanes[index];
      if (nearer === undefined || further === undefined) continue;
      expect(nearer.halfSize).toBeGreaterThan(further.halfSize);
    }
  });

  it('refuses a layout whose forms would be smudges rather than silhouettes', () => {
    expect(() => layoutReefLanes({ ...small, forms: 40 })).toThrow(RangeError);
    expect(() => layoutReefLanes({ ...small, clearance: 0.4 })).toThrow(RangeError);
    expect(() => layoutReefLanes({ ...small, spread: 0.02 })).toThrow(RangeError);
  });

  it('refuses nonsense options rather than building a mesh from them', () => {
    expect(() => layoutReefLanes({ ...small, forms: 0 })).toThrow(RangeError);
    expect(() => layoutReefLanes({ ...small, forms: 2.5 })).toThrow(RangeError);
    expect(() => layoutReefLanes({ ...small, clearance: 0 })).toThrow(RangeError);
    expect(() => layoutReefLanes({ ...small, spread: Number.NaN })).toThrow(RangeError);
  });

  /** The shader applies exactly this much motion; the layout reserves it. */
  it('budgets for the bob and the lift the vertex shader actually applies', () => {
    expect(MAX_LANE_EXCURSION).toBeCloseTo(BOB_AMPLITUDE + BEAT_LIFT, 12);
    expect(REEF_SCENE.vertex).toContain(
      `const float kBob = ${BOB_AMPLITUDE.toFixed(3)};`,
    );
    expect(REEF_SCENE.vertex).toContain(`const float kLift = ${BEAT_LIFT.toFixed(3)};`);
  });
});

describe('the reef mesh', () => {
  it('is one water triangle plus a quad per form', () => {
    const mesh = buildReefGeometry(small);

    expect(attributeData(mesh, ATTRIBUTE_CORNER).length).toBe((3 + small.forms * 4) * 3);
    expect(attributeData(mesh, ATTRIBUTE_FORM).length).toBe((3 + small.forms * 4) * 4);
    expect(indicesOf(mesh).length).toBe(3 + small.forms * 6);
    expect(mesh.count).toBe(indicesOf(mesh).length);
  });

  it('covers the clip square with the first three vertices', () => {
    const corners = attributeData(buildReefGeometry(small), ATTRIBUTE_CORNER);
    const vertex = (index: number): readonly [number, number] => [
      at(corners, index * 3),
      at(corners, index * 3 + 1),
    ];
    const [a, b, c] = [vertex(0), vertex(1), vertex(2)];
    const side = (
      from: readonly [number, number],
      to: readonly [number, number],
      point: readonly [number, number],
    ): number =>
      (to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0]);

    // Every corner of the viewport is inside the triangle, so nothing is left
    // showing the clear colour.
    for (const corner of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      expect(side(a, b, corner)).toBeGreaterThanOrEqual(0);
      expect(side(b, c, corner)).toBeGreaterThanOrEqual(0);
      expect(side(c, a, corner)).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks the water plane and the billboards with different roles', () => {
    const mesh = buildReefGeometry(small);
    const corners = attributeData(mesh, ATTRIBUTE_CORNER);

    for (let vertex = 0; vertex < 3; vertex += 1) {
      expect(at(corners, vertex * 3 + 2)).toBe(ROLE_WATER);
    }
    for (let vertex = 3; vertex < 3 + small.forms * 4; vertex += 1) {
      expect(at(corners, vertex * 3 + 2)).toBe(ROLE_FORM);
      // The billboard's corners are the unit square: the fragment shader reads
      // them as the form's own coordinate system, so a corner outside it would
      // put part of the shape past the edge of the quad that carries it.
      expect(Math.abs(at(corners, vertex * 3))).toBe(1);
      expect(Math.abs(at(corners, vertex * 3 + 1))).toBe(1);
    }
  });

  it('gives all four corners of a quad the same form, and every form a quad', () => {
    const mesh = buildReefGeometry(small);
    const forms = attributeData(mesh, ATTRIBUTE_FORM);
    // The builder emits far end first, which is the order to compare against.
    const lanes = [...layoutReefLanes(small)].sort((a, b) => b.depth - a.depth);
    const formAt = (vertex: number): readonly number[] =>
      [0, 1, 2, 3].map((offset) => at(forms, vertex * 4 + offset));

    for (const [form, lane] of lanes.entries()) {
      const base = 3 + form * 4;
      for (let corner = 0; corner < 4; corner += 1) {
        expect(formAt(base + corner)).toEqual(formAt(base));
      }
      // Six places: these are the Float32Array the GPU will read, not the
      // doubles the layout computed.
      const [phase, halfSize, centre, depth] = formAt(base);
      expect(phase).toBeCloseTo(lane.phase, 6);
      expect(halfSize).toBeCloseTo(lane.halfSize, 6);
      expect(centre).toBeCloseTo(lane.centre, 6);
      expect(depth).toBeCloseTo(lane.depth, 6);
    }
  });

  it('gives the water plane a form of zeroes it never reads', () => {
    const forms = attributeData(buildReefGeometry(small), ATTRIBUTE_FORM);

    for (let index = 0; index < 12; index += 1) expect(at(forms, index)).toBe(0);
  });

  it('references only vertices that exist, and fits in 16 bits', () => {
    const mesh = buildReefGeometry(small);
    const vertices = 3 + small.forms * 4;

    for (const index of indicesOf(mesh)) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertices);
    }
    for (const index of indicesOf(REEF_MESH)) expect(index).toBeLessThan(65536);
  });

  it('winds every triangle the same way', () => {
    const mesh = buildReefGeometry(small);
    const indices = indicesOf(mesh);
    const corners = attributeData(mesh, ATTRIBUTE_CORNER);
    // Corner space maps to clip space by a positive scale for a billboard and
    // by identity for the water plane, so neither flips orientation and one
    // measurement covers both.
    const cross = (triangle: number): number => {
      const corner = (offset: number): readonly [number, number] => {
        const vertex = at(indices, triangle * 3 + offset);
        return [at(corners, vertex * 3), at(corners, vertex * 3 + 1)];
      };
      const [ax, ay] = corner(0);
      const [bx, by] = corner(1);
      const [cx, cy] = corner(2);
      return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    };

    for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
      expect(cross(triangle)).toBeGreaterThan(0);
    }
  });

  /**
   * Draw order is the only thing that would decide overlap if the lane
   * invariant were ever relaxed — there is no depth buffer and no blending at
   * the scene stage. The water first, then the painter's algorithm.
   */
  it('draws the water first and then the forms from far to near', () => {
    const mesh = buildReefGeometry({ ...small, forms: 6 });
    const indices = indicesOf(mesh);
    const forms = attributeData(mesh, ATTRIBUTE_FORM);
    const depthOfQuad = (quad: number): number =>
      at(forms, at(indices, 3 + quad * 6) * 4 + 3);

    expect([at(indices, 0), at(indices, 1), at(indices, 2)]).toEqual([0, 1, 2]);
    for (let quad = 1; quad < 6; quad += 1) {
      expect(depthOfQuad(quad)).toBeLessThanOrEqual(depthOfQuad(quad - 1));
    }
  });

  it('has no NaN in it, at any form count', () => {
    for (const forms of [1, 5, 9]) {
      const mesh = buildReefGeometry({ ...REEF_GEOMETRY_OPTIONS, forms });
      for (const data of [
        attributeData(mesh, ATTRIBUTE_CORNER),
        attributeData(mesh, ATTRIBUTE_FORM),
      ]) {
        for (const value of data) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('is the default layout at its defaults', () => {
    expect(REEF_MESH.count).toBe(3 + REEF_GEOMETRY_OPTIONS.forms * 6);
    expect(attributeData(REEF_MESH, ATTRIBUTE_CORNER).length / 3).toBe(
      3 + REEF_GEOMETRY_OPTIONS.forms * 4,
    );
  });
});

describe('the reef scene', () => {
  const sources = [REEF_SCENE.vertex, REEF_SCENE.fragment];

  it('is named the way a preset names it', () => {
    expect(REEF_SCENE.id).toMatch(/^[a-z]+$/);
    expect(REEF_SCENE.geometry).toBe(REEF_MESH);
  });

  /**
   * A leading newline from a template literal is a compile error, and one that
   * only appears on a device with a GPU.
   */
  it('starts both shaders with the version directive', () => {
    for (const source of sources)
      expect(source.startsWith('#version 300 es\n')).toBe(true);
  });

  it('runs the fragment stage at mediump, because it is all colour', () => {
    expect(REEF_SCENE.fragment).toContain('\nprecision mediump float;\n');
  });

  it('declares a uniform for every parameter it advertises', () => {
    const source = sources.join('\n');
    for (const name of Object.keys(REEF_SCENE.params)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  /**
   * A uniform the shader reads but nothing sets is zero, silently — and a reef
   * with no light in it is a black screen with no error anywhere.
   */
  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(REEF_SCENE.params).map(paramUniformName),
    ]);

    for (const source of sources) {
      const declared = declaredUniforms(source);
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(allowed).toContain(name);
    }
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(REEF_SCENE.params)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  /** The chain's targets carry no depth attachment (D-070). */
  it('runs without a depth buffer', () => {
    expect(REEF_SCENE.depthTest).toBe(false);
  });

  it('binds its attributes where the vertex shader declares them', () => {
    expect(REEF_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_CORNER)}) in vec3 aCorner;`,
    );
    expect(REEF_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_FORM)}) in vec4 aForm;`,
    );
    expect(
      REEF_MESH.attributes.map((attribute) => [attribute.location, attribute.size]),
    ).toEqual([
      [ATTRIBUTE_CORNER, 3],
      [ATTRIBUTE_FORM, 4],
    ]);
  });

  it('has no discard and no data-dependent loop', () => {
    for (const source of sources) {
      expect(source).not.toContain('discard');
      expect(source).not.toContain('for (');
      expect(source).not.toContain('while');
    }
  });

  /**
   * `precision.test.ts` walks the catalogue, but this scene is registered by
   * somebody else, so the check is repeated locally: a uniform used in both
   * stages at two precisions fails to **link**, on hardware, invisibly to
   * every headless test that is not this one.
   */
  it('declares its shared uniforms at one precision in both stages', () => {
    const inVertex = declaredUniforms(REEF_SCENE.vertex);
    const inFragment = new Set(declaredUniforms(REEF_SCENE.fragment));
    const shared = inVertex.filter((name) => inFragment.has(name));
    const vertexPrecision = explicitPrecisions(REEF_SCENE.vertex);
    const fragmentPrecision = explicitPrecisions(REEF_SCENE.fragment);

    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) {
      // Explicit on both sides, not merely equal: the two files have different
      // defaults, so an unqualified shared uniform is a link error waiting for
      // somebody to change one of them.
      expect(vertexPrecision.get(name)).toBe('mediump');
      expect(fragmentPrecision.get(name)).toBe('mediump');
    }
  });
});

describe('the calm guarantee (D-018)', () => {
  /**
   * The load-bearing test in this file. `uBeat` reaching the stage that decides
   * colour is how a calm mode becomes a strobe, and it is one line's carelessness
   * away at all times. Absence is checked rather than intent, because absence is
   * the thing that cannot be argued with.
   */
  it('keeps the beat and the clock out of the fragment shader entirely', () => {
    expect(REEF_SCENE.fragment).not.toContain('uBeat');
    expect(REEF_SCENE.fragment).not.toContain('uTime');
  });

  /** And the beat may only reach two places in the stage that does see it. */
  it('spends the beat on a position and a phase, and nothing else', () => {
    const uses = linesUsing(REEF_SCENE.vertex, 'uBeat').filter(
      (line) => !line.includes('uniform'),
    );

    expect(uses).toHaveLength(2);
    for (const line of uses)
      expect(line.trim()).toMatch(/^float (lift|nudge) = uBeat \*/);
  });

  /**
   * Intensity 0 is *still*, not blank: every motion term is scaled by it, and
   * no light term is.
   */
  it('scales every motion term by the intensity dial', () => {
    for (const term of ['float speed =', 'float bob =', 'float flow =']) {
      const line = linesUsing(REEF_SCENE.vertex, 'uIntensity').find((candidate) =>
        candidate.includes(term),
      );
      expect(line, `${term} must be scaled by uIntensity`).toBeDefined();
    }
    // The swim flex too, which is on the following line of its own statement.
    expect(REEF_SCENE.vertex).toContain('uTime * kSwim * uIntensity');
  });

  it('leaves the water lit when the intensity dial is at zero', () => {
    // The one place intensity touches light is a swell with a floor, so a
    // still scene is still a lit one.
    expect(REEF_SCENE.fragment).toContain('float swell = 0.75 + 0.25 * uIntensity;');
  });

  /** A silhouette darkens multiplicatively, so it cannot brighten a pixel. */
  it('makes the silhouettes take light away rather than add it', () => {
    const uses = linesUsing(REEF_SCENE.fragment, 'mask').filter((line) =>
      line.includes('colour'),
    );

    expect(uses).toHaveLength(1);
    for (const line of uses) expect(line.trim()).toMatch(/^colour \*= mix\(1\.0, /);
  });

  /**
   * The album is the light: turn `uArt` off and there is nothing lighting the
   * scene. A reef that ignores the cover is a generic aquarium screensaver.
   */
  it('lights the water from the album, refracted through the caustic warp', () => {
    expect(REEF_SCENE.fragment).toContain('texture(uArt, artUv)');
    expect(REEF_SCENE.fragment).toContain('vec2 artUv = clamp(0.5 + w * kArtScale');
    // `w` is the warped domain — the same field the caustics are built from,
    // which is what makes this refraction rather than decoration.
    expect(REEF_SCENE.fragment).toContain('vec2 w = p + warp * kWarpAmount;');
    expect(REEF_SCENE.fragment).toContain(
      'mix(uAccent, texture(uArt, artUv).rgb, uTint)',
    );
  });
});
