/**
 * What can be tested about a shader in Node, where there is no GL at all.
 *
 * Not how it looks — nothing here can see a pixel. What it *can* do is check
 * the two things that fail silently on hardware and are invisible in review:
 *
 * 1. **A misspelled uniform.** `uForground` compiles, links, is never bound,
 *    reads as zero, and the pass goes black on the Pi with no error anywhere.
 *    Every uniform a shader declares must be in the contract (uniforms.ts) or
 *    be one of that pass's own declared parameters, with the right type. That
 *    check is written once and run over the whole family.
 * 2. **The overlay invariant.** An overlay is given no `uTexture` by the
 *    pipeline (D-062), so an overlay that samples one samples the blank
 *    texture — again, no error, just a pass that quietly does nothing. And the
 *    mirror of it: a pass in the scaled chain that never reads its input has
 *    thrown the frame away.
 *
 * Everything else here is the same kind of check: cheap, mechanical, and
 * aimed at the failures that do not announce themselves.
 */
import { describe, expect, it } from 'vitest';
import { isOk } from '@joshify/core';
import {
  BARS_PASS,
  CLASSIC_PASSES,
  KALEIDO_PASS,
  PARTICLES_PASS,
  SCOPE_PASS,
} from './classics.js';
import { BUILT_IN_CATALOGUE, parsePreset, type Catalogue } from '../passes.js';
import { BAND_COUNT, paramUniformName } from '../uniforms.js';

/** The uniform contract, by name and by GLSL type. Additions are not ours. */
const CONTRACT: Readonly<Record<string, string>> = {
  uTime: 'float',
  uBeat: 'float',
  uPhase: 'float',
  uEnergy: 'float',
  uBands: 'float',
  uIntensity: 'float',
  uAccent: 'vec3',
  uForeground: 'vec3',
  uResolution: 'vec2',
  uTexel: 'vec2',
  uTexture: 'sampler2D',
  uArt: 'sampler2D',
  uPrev: 'sampler2D',
};

interface Declaration {
  readonly type: string;
  readonly name: string;
  readonly size: number | null;
}

const DECLARATION = /uniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;

const declarations = (source: string): readonly Declaration[] =>
  [...source.matchAll(DECLARATION)].map((match) => ({
    type: match[1] ?? '',
    name: match[2] ?? '',
    size: match[3] === undefined ? null : Number(match[3]),
  }));

/** Occurrences of an identifier, declaration included. Used means at least 2. */
const mentions = (source: string, name: string): number =>
  [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;

/** The header of every `for` in the source, so its bounds can be inspected. */
const loopHeaders = (source: string): readonly string[] =>
  [...source.matchAll(/for\s*\(([^)]*)\)/g)].map((match) => match[1] ?? '');

const named = (pass: { readonly id: string }): string => pass.id;

describe('the family', () => {
  it('is the four Winamp classics, and bars is among them', () => {
    expect(CLASSIC_PASSES.map(named)).toEqual(['bars', 'scope', 'kaleido', 'particles']);
  });

  it('gives every pass an id that is unique, lowercase and letters only', () => {
    const ids = CLASSIC_PASSES.map(named);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });
});

describe.each(CLASSIC_PASSES.map((pass) => [pass.id, pass] as const))(
  '%s',
  (_id, pass) => {
    const source = pass.fragment;
    const paramUniforms = Object.keys(pass.params).map(paramUniformName);

    it('opens with the version directive, on the first line', () => {
      // A `#version` that is not the first line is a compile error on Mesa
      // V3D, and one this repo would only meet on the device.
      expect(source.startsWith('#version 300 es\n')).toBe(true);
    });

    it('declares the precision GLES 3.1 on a VideoCore VII wants', () => {
      expect(source).toContain('precision mediump float;');
      expect(source).toContain('void main(');
    });

    it('declares a uniform for every parameter it exposes', () => {
      for (const uniform of paramUniforms) {
        expect(source).toContain(`uniform float ${uniform};`);
      }
    });

    // The check this file exists for: a typo'd uniform name is never a compile
    // error, never a link error, and reads as zero on hardware.
    it('declares nothing that is not in the contract or one of its own params', () => {
      for (const declaration of declarations(source)) {
        const expected = CONTRACT[declaration.name];
        if (expected === undefined) {
          expect(paramUniforms).toContain(declaration.name);
          expect(declaration.type).toBe('float');
        } else {
          expect(declaration.type).toBe(expected);
        }
      }
    });

    it('uses every uniform it declares', () => {
      for (const declaration of declarations(source)) {
        expect(mentions(source, declaration.name)).toBeGreaterThan(1);
      }
    });

    it('reads the spectrum, at exactly the width the contract fixes', () => {
      const bands = declarations(source).find((entry) => entry.name === 'uBands');

      expect(bands?.size).toBe(BAND_COUNT);
      expect(mentions(source, 'uBands')).toBeGreaterThan(1);
    });

    // Every pass has to answer the dial, and at zero every pass has to vanish:
    // for an overlay that means fully transparent, for a filter it means
    // handing its input back untouched.
    it('answers the intensity dial', () => {
      expect(mentions(source, 'uIntensity')).toBeGreaterThan(1);
    });

    it('keeps its parameter defaults inside their own bounds', () => {
      for (const [name, param] of Object.entries(pass.params)) {
        expect(param.min, name).toBeLessThan(param.max);
        expect(param.default, name).toBeGreaterThanOrEqual(param.min);
        expect(param.default, name).toBeLessThanOrEqual(param.max);
      }
    });

    it('does not discard', () => {
      // On a tile-based GPU a discard anywhere in a shader turns off early
      // depth for the whole draw, and every pass here covers its target.
      expect(source).not.toMatch(/\bdiscard\b/);
    });

    it('bounds every loop with a literal', () => {
      for (const header of loopHeaders(source)) {
        expect(header).toMatch(/[<>]=?\s*\d+/);
        // Nothing uniform-driven in a loop header: that is the data-dependent
        // bound the Pi cannot afford and the compiler cannot unroll.
        for (const declaration of declarations(source)) {
          expect(header).not.toContain(declaration.name);
        }
      }
    });
  },
);

describe('overlay or filter, and never both', () => {
  /**
   * The invariant this family is most likely to get wrong, in both
   * directions. An overlay is handed no `uTexture` (D-062), so one that
   * samples it samples a blank texture and disappears; a pass in the scaled
   * chain that never samples it has silently dropped the frame.
   */
  it('keeps overlays off the chain input and filters on it', () => {
    for (const pass of CLASSIC_PASSES) {
      if (pass.overlay === true) {
        expect(pass.fragment, pass.id).not.toContain('uTexture');
      } else {
        expect(pass.fragment, pass.id).toContain('uniform sampler2D uTexture;');
        expect(mentions(pass.fragment, 'uTexture'), pass.id).toBeGreaterThan(1);
      }
    }
  });

  it('draws the bars and the trace at panel resolution', () => {
    // Both are drawn geometry with edges a single pixel wide; a half-res
    // upscale of a 1px edge is mush.
    expect(BARS_PASS.overlay).toBe(true);
    expect(SCOPE_PASS.overlay).toBe(true);
  });

  it('leaves the kaleidoscope and the particles inside the chain', () => {
    // The kaleidoscope re-samples what is beneath it, so it *cannot* be an
    // overlay. The particles could have been, and are not: soft blobs lose
    // nothing to the upscale, and in the chain a feedback pass downstream
    // turns them into trails.
    expect(KALEIDO_PASS.overlay).toBeUndefined();
    expect(PARTICLES_PASS.overlay).toBeUndefined();
  });
});

describe('the bars, specifically', () => {
  it('finds its band from a coordinate rather than a loop', () => {
    expect(loopHeaders(BARS_PASS.fragment)).toEqual([]);
    expect(BARS_PASS.fragment).toContain('int index = clamp(int(slot), 0, 15);');
  });

  it('takes its colour only from the contrast-corrected palette', () => {
    // Bars sit on artwork. uAccent and uForeground are corrected against it
    // server-side (P3-04); anything else here would be a colour we invented.
    expect(mentions(BARS_PASS.fragment, 'uAccent')).toBeGreaterThan(1);
    expect(mentions(BARS_PASS.fragment, 'uForeground')).toBeGreaterThan(1);
    expect(BARS_PASS.fragment).not.toMatch(/vec3\(\s*[\d.]+\s*,/);
  });

  it('measures its edges in panel texels, which is what an overlay is for', () => {
    expect(mentions(BARS_PASS.fragment, 'uTexel')).toBeGreaterThan(1);
  });
});

describe('the oscilloscope, specifically', () => {
  it('resynthesises one harmonic per band, with a bound the contract fixes', () => {
    const headers = loopHeaders(SCOPE_PASS.fragment);

    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(`<= ${String(BAND_COUNT)}`);
  });

  it('travels a whole period per beat, so uPhase wraps invisibly', () => {
    expect(mentions(SCOPE_PASS.fragment, 'uPhase')).toBeGreaterThan(1);
  });
});

describe('the particles, specifically', () => {
  it('searches exactly the home cell and its eight neighbours', () => {
    const headers = loopHeaders(PARTICLES_PASS.fragment);

    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain('< 9');
  });

  it('cannot drift a particle out of the cell that bound rests on', () => {
    // The neighbourhood is exact only while a particle stays in its own cell,
    // which is a property of this parameter's range and nothing else.
    const rise = PARTICLES_PASS.params['rise'];

    expect(rise?.min).toBeGreaterThanOrEqual(-1);
    expect(rise?.max).toBeLessThanOrEqual(1);
  });
});

describe('the catalogue takes the family as data', () => {
  // Built from the real catalogue rather than a stub, minus anything it
  // already holds under one of our ids -- so this keeps working the day the
  // family is registered into `BUILT_IN_CATALOGUE` for real.
  const ours = new Set(CLASSIC_PASSES.map(named));
  const catalogue: Catalogue = {
    scenes: BUILT_IN_CATALOGUE.scenes,
    passes: [
      ...BUILT_IN_CATALOGUE.passes.filter((pass) => !ours.has(pass.id)),
      ...CLASSIC_PASSES,
    ],
  };

  it('parses a preset naming all four, and hoists the overlays to the end', () => {
    const result = parsePreset(
      {
        id: 'classics',
        scene: 'flat',
        chain: [
          { pass: 'bars' },
          { pass: 'kaleido', params: { segments: 8 } },
          { pass: 'scope' },
          { pass: 'particles' },
        ],
      },
      catalogue,
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.chain.map((step) => step.pass)).toEqual([
      'kaleido',
      'particles',
      'bars',
      'scope',
    ]);
  });

  it('fills in each pass’s declared defaults', () => {
    const result = parsePreset(
      { id: 'p', scene: 'flat', chain: [{ pass: 'kaleido' }] },
      catalogue,
    );

    expect(isOk(result) && result.value.chain[0]?.params).toEqual({
      segments: 6,
      spin: 0.09,
      pulse: 0.18,
      mix: 1,
    });
  });
});
