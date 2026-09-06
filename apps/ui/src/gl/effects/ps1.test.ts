import { describe, expect, it } from 'vitest';
import type { PassDefinition } from '../passes.js';
import { TUNNEL_SCENE } from '../scenes/tunnel.js';
import { paramUniformName } from '../uniforms.js';
import { PS1_ARTEFACTS, PS1_PASSES } from './ps1.js';

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

const each = (assert: (pass: PassDefinition) => void): void => {
  for (const pass of PS1_PASSES) assert(pass);
};

describe('the PS1 post passes', () => {
  it('names each pass the way a preset names it, and only once', () => {
    const ids = PS1_PASSES.map((pass) => pass.id);

    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * A leading newline from a template literal is a compile error, and one that
   * only shows up on a device with a GPU.
   */
  it('starts every shader with the version directive', () => {
    each((pass) => {
      expect(pass.fragment.startsWith('#version 300 es\n')).toBe(true);
      expect(pass.fragment).toContain('precision mediump float;');
    });
  });

  it('declares a uniform for every parameter it advertises', () => {
    each((pass) => {
      for (const name of Object.keys(pass.params)) {
        expect(name).toMatch(/^[a-z]+$/);
        expect(pass.fragment).toContain(`uniform float ${paramUniformName(name)};`);
      }
    });
  });

  /**
   * The expensive typo: a uniform the shader reads that nothing ever sets is
   * zero, with no error anywhere — `uLevels = 0` is a black screen on the Pi
   * and a passing test suite here. Nothing may be read that the pipeline does
   * not fill.
   */
  it('reads nothing but the contract and its own parameters', () => {
    each((pass) => {
      const allowed = new Set([
        ...CONTRACT,
        ...Object.keys(pass.params).map(paramUniformName),
      ]);
      const declared = declaredUniforms(pass.fragment);

      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(allowed).toContain(name);
    });
  });

  it('keeps every default inside the range a preset may set', () => {
    each((pass) => {
      for (const param of Object.values(pass.params)) {
        expect(param.min).toBeLessThan(param.max);
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
      }
    });
  });

  /**
   * These filter the frame beneath them, so they are chain passes and not
   * overlays — an overlay is given no `uTexture` at all (D-062).
   */
  it('filters the chain rather than compositing over it', () => {
    each((pass) => {
      expect(pass.overlay).toBeUndefined();
      expect(pass.fragment).toContain('uniform sampler2D uTexture;');
    });
  });

  it('has no discard and no data-dependent loop', () => {
    each((pass) => {
      expect(pass.fragment).not.toContain('discard');
      expect(pass.fragment).not.toContain('for (');
      expect(pass.fragment).not.toContain('while');
    });
  });
});

describe('15-bit colour', () => {
  const pass = PS1_PASSES.find((candidate) => candidate.id === 'fifteenbit');

  it('quantises and dithers in the same pass', () => {
    // Either half alone is wrong: quantising without dither gives flat bands,
    // dithering without quantising is grain.
    expect(pass?.fragment).toContain('kBayer');
    expect(pass?.fragment).toContain('floor(colour * levels + 0.5) / levels');
  });

  it('defaults to five bits a channel — 32 levels, which is 31 steps', () => {
    expect(pass?.params['levels']?.default).toBe(31);
  });

  /**
   * Locked to the pixel grid of the surface being drawn. A dither keyed off
   * `vUv` would swim across the picture whenever the degrader moved the render
   * scale.
   */
  it('keys the pattern to the pixel grid, not to the texture coordinate', () => {
    expect(pass?.fragment).toContain('gl_FragCoord');
  });
});

describe('240p output', () => {
  const pass = PS1_PASSES.find((candidate) => candidate.id === 'twoforty');

  it('defaults to the console line count', () => {
    expect(pass?.params['lines']?.default).toBe(240);
  });

  /**
   * Square cells. A 16:9 240-line frame is 427 columns; stretching 320 across
   * it reads as a broken aspect ratio rather than as a console.
   */
  it('derives its column count from the aspect ratio of the surface', () => {
    expect(pass?.fragment).toContain('uResolution.x / max(uResolution.y, 1.0)');
    expect(pass?.fragment).toContain('floor(vUv * cells)');
  });

  it('never asks for more lines than the surface has', () => {
    expect(pass?.fragment).toContain('clamp(uLines, 1.0, max(uResolution.y, 1.0))');
  });
});

/**
 * The claim in PS1_MODE.md is that all six artefacts are individually
 * toggleable. Four of them are not post-processing, so the switches are spread
 * across two files — which is exactly the arrangement that rots quietly. This
 * resolves every one of them against the real scene and the real passes.
 */
describe('all six artefacts have a switch', () => {
  it('covers the six in PS1_MODE.md exactly once each', () => {
    expect(PS1_ARTEFACTS.map((artefact) => artefact.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('resolves every switch to something that exists', () => {
    for (const artefact of PS1_ARTEFACTS) {
      if (artefact.stage === 'post') {
        expect(PS1_PASSES.map((pass) => pass.id)).toContain(artefact.toggle);
      } else if (artefact.stage === 'scene-state') {
        // The only artefact that is pipeline state rather than a shader: no
        // depth buffer, which is a field on the scene and cannot be a param.
        expect(artefact.toggle).toBe('depthTest');
        expect(TUNNEL_SCENE.depthTest).toBe(false);
      } else {
        expect(Object.keys(TUNNEL_SCENE.params)).toContain(artefact.toggle);
      }
    }
  });

  /**
   * "Off" has to be reachable. A parameter whose minimum is above zero, or a
   * pass with no way out of the chain, is an artefact that is on for ever.
   */
  it('lets a preset turn each scene-stage artefact off', () => {
    for (const artefact of PS1_ARTEFACTS) {
      if (artefact.stage === 'post' || artefact.stage === 'scene-state') continue;
      expect(TUNNEL_SCENE.params[artefact.toggle]?.min).toBe(0);
    }
  });
});
