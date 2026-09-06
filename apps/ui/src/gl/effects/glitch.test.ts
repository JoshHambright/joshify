import { describe, expect, it } from 'vitest';
import { isOk } from '@joshify/core';
import {
  BUILT_IN_CATALOGUE,
  MAX_CHAIN_LENGTH,
  parsePreset,
  type Catalogue,
  type PassDefinition,
} from '../passes.js';
import { paramUniformName } from '../uniforms.js';
import {
  BITCRUSH_PASS,
  BLOCKSHIFT_PASS,
  DROPOUT_PASS,
  GLITCH_PASSES,
  RGBSPLIT_PASS,
  SMEAR_PASS,
  TEAR_PASS,
} from './glitch.js';

/**
 * None of this can test how a shader *looks* — there is no GL in CI, and a
 * screenshot test on a Pi is not a unit test. What it can test is the thing
 * that actually breaks: the contract between a `PassDefinition`'s data and the
 * GLSL text beside it. A parameter the shader never declares is a slider that
 * does nothing; a uniform the shader declares that nobody binds is a black
 * screen on hardware and silence everywhere else. Both are one typo away at
 * all times, and both are visible from Node.
 */

/**
 * The uniform block from `uniforms.ts`. Written out rather than imported
 * because the point of the check is to catch the two lists drifting apart —
 * deriving this from the same source it is meant to police would assert
 * nothing.
 */
const CONTRACT: ReadonlySet<string> = new Set([
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

/** `uniform float uAmount;` and `uniform float uBands[16];` alike. */
const UNIFORM_DECLARATION = /^\s*uniform\s+\w+\s+(\w+)\s*(?:\[\s*\d+\s*\])?\s*;/gm;

const declaredUniforms = (source: string): readonly string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(UNIFORM_DECLARATION)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
};

const occurrences = (source: string, identifier: string): number =>
  source.match(new RegExp(`\\b${identifier}\\b`, 'g'))?.length ?? 0;

const paramNames = (pass: PassDefinition): readonly string[] => Object.keys(pass.params);

/** Every test below runs over the whole family; none of them names a pass. */
const each = (run: (pass: PassDefinition) => void): void => {
  for (const pass of GLITCH_PASSES) run(pass);
};

const catalogue: Catalogue = {
  scenes: BUILT_IN_CATALOGUE.scenes,
  passes: GLITCH_PASSES,
};

describe('the family is a set of passes the catalogue can hold', () => {
  it('exports each pass exactly once, in the documented order', () => {
    expect(GLITCH_PASSES).toEqual([
      RGBSPLIT_PASS,
      BLOCKSHIFT_PASS,
      SMEAR_PASS,
      TEAR_PASS,
      DROPOUT_PASS,
      BITCRUSH_PASS,
    ]);
  });

  /**
   * The preset parser splits an id on nothing and the artwork route validates
   * one against a letters-only pattern, so an id with a capital or a digit is
   * a pass that loads in a test and 404s on the device. `rgbSplit` would be
   * the obvious mistake; `rgbsplit` is the id.
   */
  it('names every pass in lowercase letters, with no two the same', () => {
    const ids = GLITCH_PASSES.map((pass) => pass.id);

    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('parses as a preset chain, defaults and all', () => {
    const result = parsePreset(
      {
        id: 'datamosh',
        scene: 'flat',
        chain: GLITCH_PASSES.map((pass) => ({ pass: pass.id })),
      },
      catalogue,
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.chain.map((step) => step.pass)).toEqual(
      GLITCH_PASSES.map((pass) => pass.id),
    );
    expect(result.value.chain[0]?.params).toEqual({ amount: 0.008, radial: 0.4 });
  });

  /**
   * Six passes and a six-pass budget: the whole family in one chain is exactly
   * the limit, so a seventh effect here would need a preset to leave one out
   * rather than being quietly dropped.
   */
  it('fits the frame budget as a single chain', () => {
    expect(GLITCH_PASSES.length).toBeLessThanOrEqual(MAX_CHAIN_LENGTH);
  });

  /** These filter the scene. An overlay gets no `uTexture` and could not. */
  it('leaves every pass inside the scaled chain rather than over it', () => {
    each((pass) => {
      expect(pass.overlay).toBeUndefined();
      expect(pass.fragment).toContain('uniform sampler2D uTexture;');
    });
  });
});

describe('every shader agrees with the uniform contract', () => {
  /**
   * `#version` must be the first characters in the source — not the first
   * non-blank line. A leading newline is a compile error that only appears on
   * a device with a GPU.
   */
  it('opens with the version directive and the precision it costs', () => {
    each((pass) => {
      expect(
        pass.fragment.startsWith('#version 300 es\nprecision mediump float;\n'),
      ).toBe(true);
    });
  });

  it('writes one output, from one entry point', () => {
    each((pass) => {
      expect(pass.fragment).toContain('out vec4 fragColour;');
      expect(occurrences(pass.fragment, 'main')).toBe(1);
    });
  });

  it('declares a uniform for every parameter it advertises', () => {
    each((pass) => {
      for (const name of paramNames(pass)) {
        expect(pass.fragment).toContain(`uniform float ${paramUniformName(name)};`);
      }
    });
  });

  /**
   * The one that earns its keep. Nothing at runtime complains about a uniform
   * nobody sets: `getUniformLocation` returns null, the pipeline skips it, the
   * value is zero, and the pass renders black on the Pi and nowhere else. A
   * `uBnads` typo is caught here or in a dark room.
   */
  it('declares no uniform outside the contract and its own parameters', () => {
    each((pass) => {
      const allowed = new Set([...CONTRACT, ...paramNames(pass).map(paramUniformName)]);

      for (const name of declaredUniforms(pass.fragment)) {
        expect({ pass: pass.id, uniform: name, allowed: allowed.has(name) }).toEqual({
          pass: pass.id,
          uniform: name,
          allowed: true,
        });
      }
    });
  });

  /**
   * The mirror image: a declared uniform that is never read is dead weight the
   * pipeline still looks up every frame, and — if it is a parameter — a slider
   * in the preset UI that moves nothing.
   */
  it('reads every uniform it declares', () => {
    each((pass) => {
      for (const name of declaredUniforms(pass.fragment)) {
        expect({
          pass: pass.id,
          uniform: name,
          read: occurrences(pass.fragment, name) > 1,
        }).toEqual({ pass: pass.id, uniform: name, read: true });
      }
    });
  });
});

describe('what a tile-based GPU cannot afford', () => {
  /**
   * `discard` forces the tiler to keep a fragment's coverage undecided, which
   * costs far more on a VideoCore VII than the fragment it skips. Nothing in a
   * full-screen post pass needs it — an alpha of zero says the same thing.
   */
  it('never discards', () => {
    each((pass) => {
      expect(pass.fragment).not.toContain('discard');
    });
  });

  /**
   * A loop whose bound comes from a uniform cannot be unrolled and makes the
   * shader's cost a property of the music. The only loop in the family is
   * `smear`'s, and its bound is a literal.
   */
  it('loops only over constant bounds', () => {
    each((pass) => {
      expect(pass.fragment).not.toContain('while');
      for (const match of pass.fragment.matchAll(/for\s*\(([^)]*)\)/g)) {
        expect(match[1] ?? '').toMatch(/^int \w+ = \d+; \w+ < \d+; \+\+\w+$/);
      }
    });
  });
});

describe('the dial and the beat', () => {
  /**
   * A pass that ignores `uIntensity` is a pass the legibility floor (P5-16)
   * cannot turn down, so the floor would have to drop it from the chain
   * instead — a visible pop rather than a fade.
   */
  it('gives uIntensity something to do in every pass', () => {
    each((pass) => {
      expect(occurrences(pass.fragment, 'uIntensity')).toBeGreaterThan(1);
    });
  });

  /**
   * The exact-pass-through guarantee at `uIntensity == 0` is arithmetic, not
   * assertable from Node — but the hazard it defends against is. `hash21`
   * returns a mediump float that can round to 1.0, so `step(1.0 - gate, pick)`
   * is not reliably zero when `gate` is. Every pass that gates on a hash must
   * therefore multiply the result by the `on` guard.
   */
  it('guards every hash gate against a mediump 1.0', () => {
    each((pass) => {
      const gates = occurrences(pass.fragment, 'hash21') > 0;
      if (!gates) return;
      expect(pass.fragment).toContain('float on = step(0.0001, uIntensity);');
      expect(occurrences(pass.fragment, 'step')).toBeGreaterThan(1);
      expect(pass.fragment).toContain('* on;');
    });
  });

  /**
   * The whole point of Phase 5. An effect that fires on `uTime` alone is a
   * screensaver, and the three-tier provider exists so that it does not have
   * to be one.
   */
  it('binds every pass to the music, not to the clock', () => {
    each((pass) => {
      const musical = ['uBeat', 'uPhase', 'uBands', 'uEnergy'].filter(
        (name) => occurrences(pass.fragment, name) > 1,
      );

      expect({ pass: pass.id, musical: musical.length > 0 }).toEqual({
        pass: pass.id,
        musical: true,
      });
    });
  });

  /**
   * `uTime` is allowed exactly once in the family, animating the speckle
   * inside an event `uBeat` has already triggered. If it turns up anywhere
   * else, something has started running on a clock.
   */
  it('keeps the clock to the one place it is justified', () => {
    const onTheClock = GLITCH_PASSES.filter(
      (pass) => occurrences(pass.fragment, 'uTime') > 0,
    ).map((pass) => pass.id);

    expect(onTheClock).toEqual(['dropout']);
  });
});

describe('parameters are a range a preset can be trusted with', () => {
  it('puts every default inside its own bounds', () => {
    each((pass) => {
      for (const [name, param] of Object.entries(pass.params)) {
        expect({ pass: pass.id, name, ...param }).toEqual({
          pass: pass.id,
          name,
          default: expect.any(Number) as number,
          min: expect.any(Number) as number,
          max: expect.any(Number) as number,
        });
        expect(param.min).toBeLessThan(param.max);
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
      }
    });
  });

  /**
   * A parameter is a float uniform, so a range that is not finite reaches the
   * GPU as a NaN and takes the frame with it (`uniforms.ts` only sanitises the
   * values a preset supplies, not the bounds a shader declares).
   */
  it('bounds everything with real numbers', () => {
    each((pass) => {
      for (const param of Object.values(pass.params)) {
        expect(Number.isFinite(param.default)).toBe(true);
        expect(Number.isFinite(param.min)).toBe(true);
        expect(Number.isFinite(param.max)).toBe(true);
      }
    });
  });

  /**
   * Sizes are in pixels of the stage being rendered, and a sub-pixel block is
   * a hash evaluated per fragment for nothing — the most expensive way
   * available to render the input unchanged.
   */
  it('never lets a pixel size fall below one pixel', () => {
    for (const pass of [BLOCKSHIFT_PASS, DROPOUT_PASS, TEAR_PASS]) {
      for (const [name, param] of Object.entries(pass.params)) {
        if (name === 'block' || name === 'height')
          expect(param.min).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
