import { describe, expect, it } from 'vitest';
import {
  BAND_COUNT,
  buildFrameUniforms,
  clamp01,
  normaliseBands,
  paramUniformName,
  paramUniforms,
  UNIT_ART,
  UNIT_PREV,
  UNIT_TEXTURE,
  type FrameContext,
} from './uniforms.js';

const context = (over: Partial<FrameContext> = {}): FrameContext => ({
  reactivity: { timeSeconds: 12.5, beat: 0.5, phase: 0.25, energy: 0.25, bands: [] },
  accent: [1, 0.5, 0],
  foreground: [1, 1, 1],
  intensity: 0.75,
  resolution: { width: 360, height: 640 },
  ...over,
});

describe('the block every shader reads', () => {
  it('names and types the contract the reactivity provider fills', () => {
    const uniforms = buildFrameUniforms(context());

    expect(uniforms['uTime']).toEqual({ kind: 'float', value: 12.5 });
    expect(uniforms['uBeat']).toEqual({ kind: 'float', value: 0.5 });
    expect(uniforms['uEnergy']).toEqual({ kind: 'float', value: 0.25 });
    expect(uniforms['uIntensity']).toEqual({ kind: 'float', value: 0.75 });
    expect(uniforms['uAccent']).toEqual({ kind: 'vec3', value: [1, 0.5, 0] });
    expect(uniforms['uForeground']).toEqual({ kind: 'vec3', value: [1, 1, 1] });
    expect(uniforms['uBands']?.kind).toBe('floats');
  });

  // The samplers are a fixed layout for the life of the engine; a pass that
  // sampled unit 2 expecting the album art would read last frame instead.
  it('pins the texture units so a shader can rely on them', () => {
    const uniforms = buildFrameUniforms(context());

    expect(uniforms['uTexture']).toEqual({ kind: 'sampler', value: UNIT_TEXTURE });
    expect(uniforms['uArt']).toEqual({ kind: 'sampler', value: UNIT_ART });
    expect(uniforms['uPrev']).toEqual({ kind: 'sampler', value: UNIT_PREV });
    expect([UNIT_TEXTURE, UNIT_ART, UNIT_PREV]).toEqual([0, 1, 2]);
  });

  /**
   * A pass running at half scale that believes it is full size samples half a
   * texel off — which never fails, it just looks slightly soft forever.
   */
  it('reports the size being rendered now, not the panel', () => {
    const uniforms = buildFrameUniforms(
      context({ resolution: { width: 360, height: 640 } }),
    );

    expect(uniforms['uResolution']).toEqual({ kind: 'vec2', value: [360, 640] });
    expect(uniforms['uTexel']).toEqual({ kind: 'vec2', value: [1 / 360, 1 / 640] });
  });

  it('rounds a fractional size and never reports a zero one', () => {
    const uniforms = buildFrameUniforms(
      context({ resolution: { width: 360.4, height: 0.2 } }),
    );

    expect(uniforms['uResolution']).toEqual({ kind: 'vec2', value: [360, 1] });
  });

  // Time is monotonic and unbounded on purpose: a shader that wants a phase
  // wraps it itself, and clamping it here would freeze every effect at 1.0.
  it('leaves time unclamped', () => {
    const uniforms = buildFrameUniforms(
      context({
        reactivity: { timeSeconds: 4_000, beat: 0, phase: 0, energy: 0, bands: [] },
      }),
    );

    expect(uniforms['uTime']).toEqual({ kind: 'float', value: 4_000 });
  });
});

describe('surviving a provider having a bad moment', () => {
  /**
   * NaN through a uniform is a black frame with no error anywhere — the worst
   * failure shape there is. A division by a zero BPM produces one, and Tier 1
   * divides by a BPM it looked up over the network.
   */
  it('replaces a non-finite value with zero rather than passing it on', () => {
    const uniforms = buildFrameUniforms(
      context({
        reactivity: {
          timeSeconds: Number.NaN,
          beat: Infinity,
          phase: Number.NaN,
          energy: -Infinity,
          bands: [],
        },
      }),
    );

    expect(uniforms['uTime']).toEqual({ kind: 'float', value: 0 });
    expect(uniforms['uBeat']).toEqual({ kind: 'float', value: 0 });
    expect(uniforms['uEnergy']).toEqual({ kind: 'float', value: 0 });
  });

  it('clamps the 0..1 signals at both ends', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);

    const uniforms = buildFrameUniforms(
      context({
        reactivity: { timeSeconds: 0, beat: 4, phase: -2, energy: -1, bands: [] },
        intensity: 9,
        accent: [-1, 2, 0.5],
      }),
    );

    expect(uniforms['uBeat']).toEqual({ kind: 'float', value: 1 });
    expect(uniforms['uEnergy']).toEqual({ kind: 'float', value: 0 });
    expect(uniforms['uIntensity']).toEqual({ kind: 'float', value: 1 });
    expect(uniforms['uAccent']).toEqual({ kind: 'vec3', value: [0, 1, 0.5] });
  });

  /**
   * `uniform1fv` writes as many elements as it is given, so a short array
   * leaves the tail holding whatever the last preset wrote — an eight-band
   * provider would show a permanently frozen top octave.
   */
  it('always sends exactly sixteen bands, however many it was given', () => {
    expect(normaliseBands([]).length).toBe(BAND_COUNT);
    expect(normaliseBands([0.5, 0.5]).slice(2)).toEqual(Array(14).fill(0));
    expect(normaliseBands(Array(30).fill(0.3) as number[]).length).toBe(BAND_COUNT);
    expect(normaliseBands([2, -2, Number.NaN])[0]).toBe(1);
    expect(normaliseBands([2, -2, Number.NaN])[1]).toBe(0);
    expect(normaliseBands([2, -2, Number.NaN])[2]).toBe(0);
  });
});

describe('preset parameters reaching their shader', () => {
  // This mapping is the whole reason a preset can be data: `{"amount": 0.4}`
  // in JSON becomes `uAmount` in GLSL with nothing in between knowing the name.
  it('prefixes and capitalises, so a param needs no code to reach a uniform', () => {
    expect(paramUniformName('amount')).toBe('uAmount');
    expect(paramUniformName('zoom')).toBe('uZoom');
    expect(paramUniformName('blockSize')).toBe('uBlockSize');
  });

  it('sends every parameter as a float, and a broken one as zero', () => {
    expect(paramUniforms({ amount: 0.4, decay: Number.NaN })).toEqual({
      uAmount: { kind: 'float', value: 0.4 },
      uDecay: { kind: 'float', value: 0 },
    });
  });

  it('has nothing to say about a pass with no parameters', () => {
    expect(paramUniforms({})).toEqual({});
  });
});

/**
 * The flash floor, applied where no effect can bypass it (D-071).
 *
 * `flash.test.ts` proves the arithmetic over the whole tempo range; this
 * proves the arithmetic is actually reaching the shader.
 */
describe('the flash floor', () => {
  const beatAt = (bpm: number | null): number => {
    const uniforms = buildFrameUniforms(
      context({
        reactivity: { timeSeconds: 1, beat: 1, phase: 0, energy: 0.5, bands: [] },
        ...(bpm === null ? {} : { bpm }),
      }),
    );
    const value = uniforms['uBeat'];
    return value?.kind === 'float' ? value.value : Number.NaN;
  };

  it('leaves ordinary tempos at full depth', () => {
    expect(beatAt(128)).toBe(1);
    expect(beatAt(174)).toBe(1);
  });

  // 200 BPM is drum and bass, not an exotic case.
  it('attenuates a pulse that would flash more than three times a second', () => {
    expect(beatAt(200)).toBeLessThan(0.1);
    expect(beatAt(200)).toBeGreaterThan(0);
  });

  // Tier 0 has no tempo to police against, and its pulse is slow by
  // construction (D-063).
  it('passes a procedural pulse through when no tempo is known', () => {
    expect(beatAt(null)).toBe(1);
  });
});
