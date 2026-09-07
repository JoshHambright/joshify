/**
 * What can be tested about a fractal without a GPU.
 *
 * Not how it looks — nothing here renders. But almost every decision in the
 * scene is a *number*, and the numbers are the part that goes wrong quietly:
 * a parameter walk that wanders out of the connected region turns the picture
 * to dust, an iteration bound picked by eye is either a black screen of cost
 * or a mush of missing detail, and a bailout that is one constant too small
 * throws away pixels nobody will be able to point at.
 *
 * So the arithmetic lives in TypeScript beside the shader, the shader is
 * generated from it, and this file measures rather than asserts taste. The
 * iteration-budget test in particular is a *measurement*: it reports how much
 * of the screen changes between one bound and another, so lowering the bound
 * to save time cannot happen without the suite saying what it costs.
 */
import { describe, expect, it } from 'vitest';
import { paramUniformName } from '../uniforms.js';
import {
  ATTRIBUTE_POSITION,
  BAILOUT_SQUARED,
  CARDIOID_INSET,
  DEFAULT_STEPS,
  FRACTAL_GEOMETRY,
  FRACTAL_PARAMS,
  FRACTAL_SCENE,
  MAX_ITERATIONS,
  PLANE_SCALE,
  TRAP_RADIUS,
  insideMainCardioid,
  juliaParameter,
  orbitTrap,
  type Complex,
} from './fractal.js';

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

const TAU = Math.PI * 2;

/** The panel, in portrait, at the half render scale that is the default. */
const PANEL_ASPECT = 720 / 1280;

/**
 * A grid over the default window, in the same coordinates the shader builds:
 * the aspect goes on x, the scale is the half-height.
 */
const gridPoints = (resolution: number): readonly Complex[] => {
  const points: Complex[] = [];
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const u = (column + 0.5) / resolution - 0.5;
      const v = (row + 0.5) / resolution - 0.5;
      points.push([u * PLANE_SCALE * PANEL_ASPECT, v * PLANE_SCALE]);
    }
  }
  return points;
};

/** Somewhere on the walk, not at a symmetry point that would flatter it. */
const SAMPLE_ANGLES = [0.2, 2.4, 4.6] as const;

/** How much of the screen the trap field differs on between two bounds. */
const fieldDisagreement = (coarse: number, fine: number): number => {
  const points = gridPoints(96);
  const c = juliaParameter(0.8, CARDIOID_INSET);
  let differing = 0;
  for (const point of points) {
    const a = orbitTrap(point, c, coarse).nearest;
    const b = orbitTrap(point, c, fine).nearest;
    if (Math.abs(a - b) > 1e-3) differing += 1;
  }
  return differing / points.length;
};

describe('the parameter walk', () => {
  /**
   * The whole reason for using the cardioid's own parameterisation rather
   * than a hand-drawn loop: inside the main cardioid the map has an
   * attracting fixed point, so the Julia set is a connected quasicircle. It
   * cannot fall to dust at any point of the walk — and that is checked over
   * the entire revolution, not at a few spot values, because the failure a
   * hand-picked path has is that somebody nudges one number.
   */
  it('stays strictly inside the main cardioid for the whole revolution', () => {
    for (let step = 0; step < 2048; step += 1) {
      const [re, im] = juliaParameter((step / 2048) * TAU, CARDIOID_INSET);
      expect(insideMainCardioid(re, im)).toBe(true);
    }
  });

  it('stays inside at every inset a preset may set', () => {
    const {
      min,
      max,
      default: fallback,
    } = FRACTAL_PARAMS['inset'] ?? {
      min: 0,
      max: 0,
      default: 0,
    };
    // `min` is 0, which is the boundary itself and excluded by the strict
    // test below; every inset above it must be interior.
    for (const inset of [fallback, max, (min + max) / 2, 0.001]) {
      for (let step = 0; step < 256; step += 1) {
        const [re, im] = juliaParameter((step / 256) * TAU, inset);
        expect(insideMainCardioid(re, im)).toBe(true);
      }
    }
  });

  it('lands exactly on the boundary at zero inset', () => {
    for (const theta of SAMPLE_ANGLES) {
      const [re, im] = juliaParameter(theta, 0);
      const q = (re - 0.25) * (re - 0.25) + im * im;
      // The cardioid's defining equation, to floating-point exactness — the
      // parameterisation is the boundary, not an approximation of it.
      expect(q * (q + (re - 0.25)) - 0.25 * im * im).toBeCloseTo(0, 12);
      // Strictly inside is false on the boundary, which is what makes the
      // interior test above mean something.
      expect(insideMainCardioid(re, im)).toBe(false);
    }
  });

  /**
   * The bailout is `|z| > 2`, which is only exact while `|c| < 2`. Above that
   * an orbit past 2 can still be pulled back, and the trap would miss
   * approaches the picture depends on.
   */
  it('keeps |c| far enough under 2 for the bailout to be exact', () => {
    let largest = 0;
    for (let step = 0; step < 512; step += 1) {
      const [re, im] = juliaParameter((step / 512) * TAU, CARDIOID_INSET);
      largest = Math.max(largest, Math.hypot(re, im));
    }
    expect(largest).toBeLessThan(0.75);
    expect(largest).toBeLessThan(Math.sqrt(BAILOUT_SQUARED));
  });

  it('closes on itself, so the walk never jumps', () => {
    for (const theta of SAMPLE_ANGLES) {
      const [re, im] = juliaParameter(theta, CARDIOID_INSET);
      const [wrappedRe, wrappedIm] = juliaParameter(theta + TAU, CARDIOID_INSET);
      expect(wrappedRe).toBeCloseTo(re, 12);
      expect(wrappedIm).toBeCloseTo(im, 12);
    }
  });

  /** A path that collapsed to a point would pass every test above. */
  it('actually travels', () => {
    const path = Array.from({ length: 64 }, (_unused, step) =>
      juliaParameter((step / 64) * TAU, CARDIOID_INSET),
    );
    const res = path.map(([re]) => re);
    const ims = path.map(([, im]) => im);

    expect(Math.max(...res) - Math.min(...res)).toBeGreaterThan(0.6);
    expect(Math.max(...ims) - Math.min(...ims)).toBeGreaterThan(0.6);
  });
});

describe('the orbit trap', () => {
  const c = juliaParameter(0.8, CARDIOID_INSET);

  it('traps the origin at the origin, and never escapes from it', () => {
    const result = orbitTrap([0, 0], c, MAX_ITERATIONS);

    expect(result.nearest).toBe(0);
    expect(result.trap).toEqual([0, 0]);
    // Inside the cardioid the orbit of 0 converges, so it runs the full bound.
    expect(result.iterations).toBe(MAX_ITERATIONS);
  });

  it('leaves immediately from far outside, rather than iterating to no end', () => {
    const result = orbitTrap([10, 0], c, MAX_ITERATIONS);

    expect(result.iterations).toBe(0);
    // The closest approach is the starting point itself: it only got further.
    expect(result.nearest).toBeCloseTo(10, 6);
  });

  it('never returns a non-finite distance anywhere on the window', () => {
    for (const theta of SAMPLE_ANGLES) {
      const walked = juliaParameter(theta, CARDIOID_INSET);
      for (const point of gridPoints(24)) {
        const { nearest, trap, iterations } = orbitTrap(point, walked, MAX_ITERATIONS);
        expect(Number.isFinite(nearest)).toBe(true);
        expect(Number.isFinite(trap[0])).toBe(true);
        expect(Number.isFinite(trap[1])).toBe(true);
        expect(iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
      }
    }
  });

  it('reports the distance of the point it reports the position of', () => {
    for (const point of gridPoints(16)) {
      const { nearest, trap } = orbitTrap(point, c, MAX_ITERATIONS);
      expect(Math.hypot(trap[0], trap[1])).toBeCloseTo(nearest, 6);
    }
  });
});

describe('the iteration budget', () => {
  /**
   * The bound is 48 because that is where the picture stops changing — not
   * because it is a round number. These two figures are the argument, and
   * they are measured here so that lowering the bound cannot happen quietly.
   */
  it('is converged at the compiled bound: 48 agrees with 192 almost everywhere', () => {
    expect(fieldDisagreement(MAX_ITERATIONS, 192)).toBeLessThan(0.01);
  });

  it('is not merely generous: a third of the bound loses real picture', () => {
    expect(fieldDisagreement(12, MAX_ITERATIONS)).toBeGreaterThan(0.05);
  });

  /** What a preset buys by dialling `steps` down to its default. */
  it('costs about a percent of the screen to stop at the default steps', () => {
    const cost = fieldDisagreement(DEFAULT_STEPS, MAX_ITERATIONS);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.03);
  });

  /**
   * The docblock's cost table claims a mean depth of roughly half the bound
   * and about 45% of the screen inside the set. Both drive the honest answer
   * about what the escape `break` is worth on a tiler, so both are pinned.
   */
  it('runs about half the bound in the mean, with the set filling ~45%', () => {
    const points = gridPoints(64);
    let total = 0;
    let interior = 0;
    let samples = 0;
    for (const theta of SAMPLE_ANGLES) {
      const walked = juliaParameter(theta, CARDIOID_INSET);
      for (const point of points) {
        const { iterations } = orbitTrap(point, walked, MAX_ITERATIONS);
        total += iterations;
        if (iterations === MAX_ITERATIONS) interior += 1;
        samples += 1;
      }
    }

    expect(total / samples).toBeGreaterThan(18);
    expect(total / samples).toBeLessThan(32);
    expect(interior / samples).toBeGreaterThan(0.3);
    expect(interior / samples).toBeLessThan(0.6);
  });

  /**
   * The claim the whole scene rests on: the cover is not a garnish on a
   * corner of the frame. At the default trap radius a large minority of the
   * screen carries a cover sample at full weight.
   */
  it('catches a third to a half of the screen in the trap at the defaults', () => {
    for (const theta of SAMPLE_ANGLES) {
      const walked = juliaParameter(theta, CARDIOID_INSET);
      const points = gridPoints(64);
      const caught = points.filter(
        (point) => orbitTrap(point, walked, DEFAULT_STEPS).nearest < TRAP_RADIUS,
      ).length;

      expect(caught / points.length).toBeGreaterThan(0.2);
      expect(caught / points.length).toBeLessThan(0.7);
    }
  });
});

describe('the fractal scene', () => {
  const sources = [FRACTAL_SCENE.vertex, FRACTAL_SCENE.fragment];

  it('is named the way a preset names it', () => {
    expect(FRACTAL_SCENE.id).toMatch(/^[a-z]+$/);
    expect(FRACTAL_SCENE.geometry).toBe(FRACTAL_GEOMETRY);
    expect(FRACTAL_SCENE.params).toBe(FRACTAL_PARAMS);
  });

  /** A leading newline from a template literal is a compile error on device. */
  it('starts both shaders with the version directive', () => {
    for (const source of sources) {
      expect(source.startsWith('#version 300 es\n')).toBe(true);
    }
  });

  it('declares a uniform for every parameter it advertises', () => {
    const source = sources.join('\n');
    for (const name of Object.keys(FRACTAL_PARAMS)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(source).toContain(`uniform float ${paramUniformName(name)};`);
    }
  });

  /**
   * A uniform the shader reads but nothing sets is zero, silently — and a
   * fractal with `uScale = 0` is one flat colour with no error anywhere.
   */
  it('reads nothing but the contract and its own parameters', () => {
    const allowed = new Set([
      ...CONTRACT,
      ...Object.keys(FRACTAL_PARAMS).map(paramUniformName),
    ]);

    for (const source of sources) {
      for (const name of declaredUniforms(source)) expect(allowed).toContain(name);
    }
    expect(declaredUniforms(FRACTAL_SCENE.fragment).length).toBeGreaterThan(0);
  });

  it('keeps every default inside the range a preset may set', () => {
    for (const param of Object.values(FRACTAL_PARAMS)) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
    }
  });

  it('carries the same defaults the TypeScript reasons about', () => {
    expect(FRACTAL_PARAMS['scale']?.default).toBe(PLANE_SCALE);
    expect(FRACTAL_PARAMS['steps']?.default).toBe(DEFAULT_STEPS);
    expect(FRACTAL_PARAMS['steps']?.max).toBe(MAX_ITERATIONS);
    expect(FRACTAL_PARAMS['trap']?.default).toBe(TRAP_RADIUS);
    expect(FRACTAL_PARAMS['inset']?.default).toBe(CARDIOID_INSET);
  });

  it('binds its one attribute where the vertex shader declares it', () => {
    expect(FRACTAL_SCENE.vertex).toContain(
      `layout(location = ${String(ATTRIBUTE_POSITION)}) in vec2 aPosition;`,
    );
    expect(
      FRACTAL_GEOMETRY.attributes.map((attribute) => [
        attribute.location,
        attribute.size,
      ]),
    ).toEqual([[ATTRIBUTE_POSITION, 2]]);
    expect(FRACTAL_GEOMETRY.count).toBe(3);
    expect(FRACTAL_GEOMETRY.indices).toBeUndefined();
  });
});

describe('the shader, as GLSL', () => {
  const { fragment, vertex } = FRACTAL_SCENE;
  /**
   * The executable part: comments and declarations stripped, so a claim about
   * what the shader *does* cannot be satisfied by a line explaining it.
   */
  const code = fragment.replace(/\/\/[^\n]*/g, '').replace(/^\s*uniform\b[^;]*;/gm, '');

  it('compiles the iteration bound in as a constant, not a uniform', () => {
    expect(fragment).toContain(`const int kMaxSteps = ${String(MAX_ITERATIONS)};`);
    expect(fragment).toContain('for (i = 0; i < kMaxSteps; i++) {');
    // `steps` may only stop short of the bound; it can never extend it.
    expect(fragment).toContain('if (i >= limit) break;');
    // Against the stripped body, so a comment mentioning either word is not
    // mistaken for the shader doing it.
    expect(code).not.toContain('while');
    expect(code).not.toContain('discard');
  });

  it('bails out at the constant the TypeScript proved exact', () => {
    expect(fragment).toContain(`const float kBailout = ${BAILOUT_SQUARED.toFixed(1)};`);
    expect(fragment).toContain('if (d > kBailout) break;');
  });

  /**
   * The precision decision, pinned in both directions. The orbit is `highp`
   * because fp16 cannot separate adjacent pixels and overflows two iterations
   * past the bailout; colour stays `mediump` because it is a texture sample
   * and three mixes.
   */
  it('iterates in highp over a mediump file default', () => {
    expect(fragment).toContain('precision mediump float;');
    expect(fragment).toContain('highp vec2 z = p;');
    expect(fragment).toContain('highp float nearest = x2 + y2;');
    expect(fragment).toContain('in highp vec2 vUv;');
  });

  /**
   * `uTime` is the one uniform carrying a precision qualifier, and that is
   * only safe because the vertex stage declares no uniforms to disagree with
   * it — a mismatch across stages is a **link** failure on hardware, which no
   * headless test can see (`precision.test.ts`). If the vertex shader ever
   * grows a uniform, this is the test that says so.
   */
  it('qualifies uTime highp, and has no vertex uniform to clash with', () => {
    expect(fragment).toContain('uniform highp float uTime;');
    expect(declaredUniforms(vertex)).toEqual([]);
  });

  /**
   * The thesis: the album cover is read at the trapped orbit point. Without
   * this line the scene is a 1993 screensaver, which is the thing it exists
   * not to be.
   */
  it('samples the album cover at the trapped coordinate', () => {
    expect(fragment).toContain('clamp(trap / (2.0 * radius) + 0.5, 0.0, 1.0)');
    expect(fragment).toContain('texture(uArt, trapUv)');
  });

  /**
   * D-071 caps beat-driven luminance centrally, so the beat is spent on
   * geometry here: it opens the trap and kicks the rotation. Neither
   * expression multiplies a colour.
   */
  it('spends the beat on the trap radius and the spin, never on brightness', () => {
    expect(fragment).toContain('uTrap * (1.0 + uBeat * uIntensity * uSwell)');
    expect(fragment).toContain('mod(uTime * uSpin, kTau) + uBeat * uIntensity * uKick');
  });

  /**
   * At `uIntensity = 0` the scene is at its calmest: every beat- and
   * phase-driven term falls away and only the slow base drift is left. The
   * check is that no such term appears without it.
   */
  it('gates every reactive term on uIntensity', () => {
    const reactive = [...code.matchAll(/^.*\bu(?:Beat|Phase)\b.*$/gm)].map(
      ([line]) => line,
    );

    expect(reactive.length).toBeGreaterThan(2);
    for (const line of reactive) expect(line).toContain('uIntensity');
  });

  /** uTime is unbounded seconds; every use of it is wrapped before trig. */
  it('wraps time into a turn before taking a sine of it', () => {
    const uses = [...code.matchAll(/uTime/g)].length;
    const wrapped = [...code.matchAll(/mod\(uTime \* u\w+, kTau\)/g)].length;

    expect(uses).toBeGreaterThan(1);
    expect(wrapped).toBe(uses);
  });
});
