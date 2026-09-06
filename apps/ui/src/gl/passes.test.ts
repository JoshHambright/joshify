import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@joshify/core';
import {
  BUILT_IN_CATALOGUE,
  DEFAULT_PRESET_JSON,
  FLAT_SCENE,
  FULLSCREEN_TRIANGLE,
  MAX_CHAIN_LENGTH,
  parsePreset,
  parsePresetJson,
  resolveParams,
  type Catalogue,
} from './passes.js';
import { paramUniformName } from './uniforms.js';

/**
 * A catalogue with a scene that is not a quad and a pass that is an overlay,
 * because the whole claim of this file is that neither needs code of its own.
 */
const catalogue: Catalogue = {
  scenes: [
    FLAT_SCENE,
    {
      id: 'tube',
      vertex: '#version 300 es\nvoid main() {}\n',
      fragment: '#version 300 es\nvoid main() {}\n',
      geometry: {
        attributes: [{ location: 0, size: 3, data: new Float32Array([0, 0, 0]) }],
        indices: new Uint16Array([0, 0, 0]),
        count: 3,
      },
      depthTest: true,
      params: { speed: { default: 4, min: 0, max: 20 } },
    },
  ],
  passes: [
    ...BUILT_IN_CATALOGUE.passes,
    {
      id: 'bars',
      fragment: '#version 300 es\nvoid main() {}\n',
      params: { gain: { default: 1, min: 0, max: 4 } },
      overlay: true,
    },
  ],
};

const parsed = (raw: unknown) => parsePreset(raw, catalogue);

describe('a preset is data', () => {
  it('reads a scene and an ordered chain out of plain JSON', () => {
    const result = parsed(DEFAULT_PRESET_JSON);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.scene).toBe('flat');
    expect(result.value.chain.map((step) => step.pass)).toEqual(['feedback', 'grain']);
    expect(result.value.name).toBe('Ghost');
  });

  it('accepts a scene with its own geometry and depth without special-casing it', () => {
    const result = parsed({ id: 'n2o', scene: 'tube', sceneParams: { speed: 9 } });

    expect(isOk(result) && result.value.sceneParams).toEqual({ speed: 9 });
  });

  it('falls back to the id when the preset has no display name', () => {
    const result = parsed({ id: 'bare', scene: 'flat' });

    expect(isOk(result) && result.value.name).toBe('bare');
  });

  it('treats a missing chain as an empty one, so a scene alone is a preset', () => {
    const result = parsed({ id: 'bare', scene: 'flat' });

    expect(isOk(result) && result.value.chain).toEqual([]);
  });
});

describe('parameters', () => {
  it('fills in every default the shader declares', () => {
    const result = parsed({ id: 'p', scene: 'flat', chain: [{ pass: 'grain' }] });

    expect(isOk(result) && result.value.chain[0]?.params).toEqual({ amount: 0.16 });
    expect(isOk(result) && result.value.sceneParams).toEqual({ flash: 0.15 });
  });

  /**
   * Presets outlive shaders. One written against a version where the pass took
   * a `wobble` should still load — silently, because there is nothing the
   * person looking at the screen could do about it.
   */
  it('drops a parameter the shader no longer has', () => {
    const result = parsed({
      id: 'p',
      scene: 'flat',
      chain: [{ pass: 'grain', params: { amount: 0.2, wobble: 3 } }],
    });

    expect(isOk(result) && result.value.chain[0]?.params).toEqual({ amount: 0.2 });
  });

  it('clamps a value the shader could not use rather than refusing the preset', () => {
    expect(
      resolveParams({ amount: { default: 0.1, min: 0, max: 0.5 } }, { amount: 9 }),
    ).toEqual({ amount: 0.5 });
    expect(
      resolveParams({ amount: { default: 0.1, min: 0, max: 0.5 } }, { amount: -9 }),
    ).toEqual({ amount: 0 });
  });

  it('uses the default for a parameter that is not a usable number', () => {
    expect(
      resolveParams({ amount: { default: 0.1, min: 0, max: 1 } }, { amount: 'loud' }),
    ).toEqual({ amount: 0.1 });
    expect(
      resolveParams({ amount: { default: 0.1, min: 0, max: 1 } }, { amount: Number.NaN }),
    ).toEqual({ amount: 0.1 });
  });
});

describe('overlays', () => {
  /**
   * An overlay in the middle of the chain would mean upscaling to draw it and
   * downscaling to carry on — more expensive than the whole chain around it.
   * Moving it is the only sane reading of what the preset meant.
   */
  it('moves a sharp pass to the end, keeping the rest in order', () => {
    const result = parsed({
      id: 'p',
      scene: 'flat',
      chain: [{ pass: 'bars' }, { pass: 'feedback' }, { pass: 'grain' }],
    });

    expect(isOk(result) && result.value.chain.map((step) => step.pass)).toEqual([
      'feedback',
      'grain',
      'bars',
    ]);
  });
});

describe('a preset that cannot be drawn', () => {
  // These are data errors, not bugs: a preset arrives from a file, so it comes
  // back as a Result the caller can fall back from rather than a throw inside
  // a render loop.
  it('names the scene it could not find', () => {
    const result = parsed({ id: 'p', scene: 'reef' });

    expect(isErr(result) && result.error).toEqual({
      reason: 'unknown-scene',
      detail: 'reef',
    });
  });

  it('names the pass it could not find', () => {
    const result = parsed({ id: 'p', scene: 'flat', chain: [{ pass: 'pixelsort' }] });

    expect(isErr(result) && result.error).toEqual({
      reason: 'unknown-pass',
      detail: 'pixelsort',
    });
  });

  /**
   * The budget is six passes a frame. A preset with nine is a mistake made in
   * a text editor — the degrader exists for a Pi having a bad second, not to
   * paper over a chain that was never going to fit.
   */
  it('refuses a chain longer than the frame budget', () => {
    const chain = Array.from({ length: MAX_CHAIN_LENGTH + 1 }, () => ({ pass: 'grain' }));
    const result = parsed({ id: 'p', scene: 'flat', chain });

    expect(isErr(result) && result.error.reason).toBe('chain-too-long');
  });

  it('rejects the shapes that are not a preset at all', () => {
    for (const raw of [null, 42, 'flat', [], { scene: 'flat' }, { id: 'p' }]) {
      expect(isErr(parsed(raw))).toBe(true);
    }
  });

  it('rejects a chain that is not a list, and an entry that names no pass', () => {
    expect(isErr(parsed({ id: 'p', scene: 'flat', chain: 'grain' }))).toBe(true);
    expect(isErr(parsed({ id: 'p', scene: 'flat', chain: [{ params: {} }] }))).toBe(true);
    expect(isErr(parsed({ id: 'p', scene: 'flat', chain: ['grain'] }))).toBe(true);
  });
});

describe('presets as files', () => {
  it('parses the text a preset file actually is', () => {
    const result = parsePresetJson(JSON.stringify(DEFAULT_PRESET_JSON), catalogue);

    expect(isOk(result) && result.value.id).toBe('ghost');
  });

  it('reports a truncated file as malformed rather than throwing at the caller', () => {
    const result = parsePresetJson('{"id": "gho', catalogue);

    expect(isErr(result) && result.error).toEqual({
      reason: 'malformed',
      detail: 'not JSON',
    });
  });
});

describe('the built-in catalogue', () => {
  const sources = [
    FLAT_SCENE.vertex,
    FLAT_SCENE.fragment,
    ...BUILT_IN_CATALOGUE.passes.map((pass) => pass.fragment),
  ];

  /**
   * `#version` must be the very first characters of the source — a leading
   * newline from a prettier template literal is a compile error, and one that
   * only shows up on a device with a GPU.
   */
  it('starts every shader with the version directive', () => {
    for (const source of sources) {
      expect(source.startsWith('#version 300 es\n')).toBe(true);
    }
  });

  /**
   * The data-to-uniform mapping only works if the names agree; a param the
   * shader never reads is a slider that does nothing, and nothing would say so.
   */
  it('declares a uniform for every parameter a pass advertises', () => {
    for (const pass of BUILT_IN_CATALOGUE.passes) {
      for (const name of Object.keys(pass.params)) {
        expect(pass.fragment).toContain(paramUniformName(name));
      }
    }
    for (const scene of BUILT_IN_CATALOGUE.scenes) {
      for (const name of Object.keys(scene.params)) {
        expect(scene.fragment).toContain(paramUniformName(name));
      }
    }
  });

  // One triangle, not two: it covers the viewport with a single primitive and
  // no diagonal seam for a tile-based GPU to rasterise twice.
  it('covers the screen with one triangle', () => {
    expect(FULLSCREEN_TRIANGLE.count).toBe(3);
    expect(FULLSCREEN_TRIANGLE.attributes[0]?.data.length).toBe(6);
  });

  it('parses its own default preset', () => {
    expect(isOk(parsePreset(DEFAULT_PRESET_JSON, BUILT_IN_CATALOGUE))).toBe(true);
  });
});
