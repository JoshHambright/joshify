import { describe, expect, it } from 'vitest';
import { isOk } from '@joshify/core';
import {
  FLAT_SCENE,
  parsePreset,
  type Catalogue,
  type PassDefinition,
} from '../passes.js';
import { paramUniformName } from '../uniforms.js';
import {
  BAYER_4X4,
  BLOOM_PASS,
  DITHER_PASS,
  HALFTONE_PASS,
  LOFI_PASSES,
  bayerMatrix,
} from './lofi.js';

/**
 * You cannot test how a shader looks, and CI has no GL at all — so what is
 * asserted here is everything that can be wrong about a pass *before* it
 * reaches a GPU. The one that earns its keep is the uniform audit: a shader
 * that reads `uTexlel` compiles cleanly, links cleanly, samples a
 * never-written uniform and draws a black screen, on a Pi, in a room, with
 * nothing anywhere saying why.
 */

/** The contract in `uniforms.ts`. Anything else a pass declares is its own. */
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

/**
 * Comments are stripped before anything is counted or matched. A GLSL comment
 * saying why the pass does not `discard` would otherwise fail the assertion
 * that it does not discard, and a uniform named in prose would be audited as
 * if it were declared.
 */
const glslCode = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');

const UNIFORM_DECLARATION =
  /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*(?:\[\s*\d+\s*\])?\s*;/gm;

const declaredUniforms = (source: string): readonly string[] =>
  [...glslCode(source).matchAll(UNIFORM_DECLARATION)].map(([, name]) => name ?? '');

const paramNames = (pass: PassDefinition): readonly string[] => Object.keys(pass.params);

const catalogue: Catalogue = { scenes: [FLAT_SCENE], passes: LOFI_PASSES };

describe('the analog lofi family', () => {
  it('exports exactly the passes the catalogue expects to register', () => {
    expect(LOFI_PASSES.map((pass) => pass.id)).toEqual([
      'vhs',
      'crt',
      'dither',
      'posterize',
      'bloom',
      'halftone',
    ]);
  });

  /**
   * The preset parser splits ids out of text and assumes they are plain words;
   * an id with punctuation or a capital in it would round-trip through a
   * preset file wrong in a way nothing else would notice.
   */
  it('gives every pass a unique, lowercase, letters-only id', () => {
    const ids = LOFI_PASSES.map((pass) => pass.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it('registers as a catalogue and parses as a chain', () => {
    const result = parsePreset(
      {
        id: 'lofi',
        scene: 'flat',
        chain: LOFI_PASSES.map((pass) => ({ pass: pass.id })),
      },
      catalogue,
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.chain.map((step) => step.pass)).toEqual(
      LOFI_PASSES.map((pass) => pass.id),
    );
  });

  it('resolves every pass to its declared defaults', () => {
    for (const pass of LOFI_PASSES) {
      const result = parsePreset(
        { id: 'p', scene: 'flat', chain: [{ pass: pass.id }] },
        catalogue,
      );
      const expected = Object.fromEntries(
        Object.entries(pass.params).map(([name, param]) => [name, param.default]),
      );

      expect(isOk(result) && result.value.chain[0]?.params).toEqual(expected);
    }
  });

  /**
   * These filter what the stage before them drew, which is exactly what an
   * overlay may not do (D-062) — an overlay gets no `uTexture` at all.
   */
  it('declares nothing in the family as an overlay', () => {
    for (const pass of LOFI_PASSES) expect(pass.overlay).toBeUndefined();
  });
});

describe('shader preamble', () => {
  /**
   * `#version` must be the very first characters of the source. A leading
   * newline from a template literal is a compile error that only appears on a
   * device with a GPU.
   */
  it('starts every fragment source with the version directive', () => {
    for (const pass of LOFI_PASSES) {
      expect(pass.fragment.startsWith('#version 300 es\n')).toBe(true);
    }
  });

  /**
   * `highp` fragment work is a real cost on a VideoCore VII. It is used here
   * only as a local qualifier on raster coordinates, never as the default.
   */
  it('defaults every fragment shader to mediump', () => {
    for (const pass of LOFI_PASSES) {
      expect(pass.fragment).toContain('precision mediump float;');
      expect(pass.fragment).not.toContain('precision highp float;');
    }
  });

  /**
   * A `discard` drags a whole tile down a slow path on a tile-based GPU, and a
   * data-dependent loop bound serialises against the worst fragment in the
   * group. This family has neither — bloom's nine taps are written out.
   */
  it('uses no discard and no loops', () => {
    for (const pass of LOFI_PASSES) {
      expect(glslCode(pass.fragment)).not.toMatch(/\bdiscard\b/);
      expect(glslCode(pass.fragment)).not.toMatch(/\b(?:for|while)\s*\(/);
    }
  });
});

describe('the uniform contract', () => {
  /**
   * The catch this file exists for. A misspelled uniform is not a compile
   * error — it links, it reads zero, and the pass renders black or does
   * nothing at all, with no diagnostic anywhere.
   */
  it('declares no uniform outside the contract or the pass own parameters', () => {
    for (const pass of LOFI_PASSES) {
      const own = new Set(paramNames(pass).map(paramUniformName));
      for (const name of declaredUniforms(pass.fragment)) {
        expect(
          CONTRACT.has(name) || own.has(name),
          `${pass.id} declares unknown uniform ${name}`,
        ).toBe(true);
      }
    }
  });

  /**
   * The other direction: a parameter with no uniform is a slider a preset can
   * set and the shader can never read.
   */
  it('declares a float uniform for every parameter a pass advertises', () => {
    for (const pass of LOFI_PASSES) {
      const declared = new Set(declaredUniforms(pass.fragment));
      for (const name of paramNames(pass)) {
        const uniform = paramUniformName(name);
        expect(declared.has(uniform), `${pass.id} never declares ${uniform}`).toBe(true);
        expect(pass.fragment).toContain(`uniform float ${uniform};`);
      }
    }
  });

  /**
   * `uIntensity` is the user's dial and the lever the legibility floor
   * (P5-16) pulls. A pass that ignores it cannot be turned down.
   */
  it('reads uIntensity in every pass', () => {
    for (const pass of LOFI_PASSES) {
      expect(declaredUniforms(pass.fragment)).toContain('uIntensity');
      // Declared and unread would still be a dead dial.
      const uses = glslCode(pass.fragment).split('uIntensity').length - 1;
      expect(uses).toBeGreaterThan(1);
    }
  });
});

describe('parameter ranges', () => {
  it('puts every default inside its own bounds', () => {
    for (const pass of LOFI_PASSES) {
      for (const [name, param] of Object.entries(pass.params)) {
        expect(param.min, `${pass.id}.${name}`).toBeLessThan(param.max);
        expect(param.default, `${pass.id}.${name}`).toBeGreaterThanOrEqual(param.min);
        expect(param.default, `${pass.id}.${name}`).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it('gives every pass at least one parameter to tune', () => {
    for (const pass of LOFI_PASSES) {
      expect(paramNames(pass).length).toBeGreaterThan(0);
    }
  });

  /**
   * Both are legibility caps, not taste: a halftone cell wider than 24 texels
   * eats text whole, and a phosphor mask over 0.8 clips highlights to a single
   * channel. They are asserted so a later "just a bit stronger" has to argue
   * with a test.
   */
  it('caps the two parameters that are legibility limits', () => {
    expect(HALFTONE_PASS.params['scale']?.max).toBe(24);
    expect(LOFI_PASSES.find((pass) => pass.id === 'crt')?.params['mask']?.max).toBe(0.8);
  });
});

describe('the Bayer matrix', () => {
  /**
   * Generated, not transcribed — so what is checked is that it *is* a dither
   * matrix, rather than that one copy of sixteen numbers matches another.
   */
  it('is a permutation of 0..n-1 with every threshold distinct', () => {
    for (const size of [2, 4, 8]) {
      const matrix = bayerMatrix(size);
      expect(matrix.length).toBe(size * size);
      expect(new Set(matrix).size).toBe(size * size);
      expect([...matrix].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size * size }, (_unused, index) => index),
      );
    }
  });

  it('bottoms out at the single-cell matrix', () => {
    expect(bayerMatrix(1)).toEqual([0]);
  });

  // The 2x2 seed is the one value worth pinning by hand; everything larger
  // follows from it and is covered by the permutation property above.
  it('builds the canonical 2x2 and 4x4 matrices', () => {
    expect(bayerMatrix(2)).toEqual([0, 2, 3, 1]);
    expect(BAYER_4X4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });

  /**
   * The shader gets the matrix by string interpolation, so the numbers in the
   * source and the numbers in the data can drift apart without anything
   * failing to compile. This is the only assertion that would catch it.
   */
  it('interpolates exactly that matrix into the dither shader', () => {
    const literal = /float\[16\]\(([^)]*)\)/.exec(glslCode(DITHER_PASS.fragment));
    expect(literal).not.toBeNull();
    const values = (literal?.[1] ?? '').split(',').map((part) => Number(part.trim()));

    expect(values).toEqual([...BAYER_4X4]);
  });
});

describe('cost', () => {
  /**
   * The budget is six passes a frame. Bloom is the one pass that is worth more
   * than one of those slots, and the count is asserted so a "just one more
   * ring" has to be a deliberate change to a number here as well.
   */
  it('keeps bloom to nine taps', () => {
    const code = glslCode(BLOOM_PASS.fragment);
    const taps = code.split('texture(uTexture').length - 1;
    // 8 ring taps are made through `highlight`, which fetches once; plus the
    // centre fetch, plus the fetch inside `highlight` itself.
    expect(taps).toBe(2);
    expect(code.split('highlight(vUv').length - 1).toBe(8);
  });

  it('keeps every other pass to at most three fetches', () => {
    for (const pass of LOFI_PASSES) {
      if (pass.id === 'bloom') continue;
      expect(
        glslCode(pass.fragment).split('texture(uTexture').length - 1,
      ).toBeLessThanOrEqual(3);
    }
  });
});
