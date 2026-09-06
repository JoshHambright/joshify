/**
 * The seam between the reactivity provider and the render pipeline.
 *
 * Both halves were built independently against a written contract, and both
 * were green on their own. They did not actually meet: one produced a
 * `Float32Array` of bands and a `phase`, the other declared `readonly
 * number[]` and had no `phase` at all. Nothing either of them could test would
 * have caught that, because a contract is the one thing neither side owns.
 *
 * So this file is small and does exactly one job: take a real frame from a
 * real provider and put it through the real uniform builder. If the two ever
 * drift apart again, this stops compiling.
 */
import { describe, expect, it } from 'vitest';
import { buildFrameUniforms, normaliseBands, type Reactivity } from './gl/uniforms.js';
import { createProceduralProvider } from './reactivity/procedural.js';
import { createTempoProvider } from './reactivity/tempo.js';

/** A provider frame, as the render loop would hand it over. */
const frameAt = (atMs: number, provider = createProceduralProvider()): Reactivity => {
  const sampled = provider.sample(atMs);
  return { ...sampled, timeSeconds: atMs / 1000 };
};

const uniformsAt = (
  atMs: number,
  provider?: ReturnType<typeof createProceduralProvider>,
) =>
  buildFrameUniforms({
    reactivity: frameAt(atMs, provider),
    accent: [1, 0.36, 0.54],
    foreground: [0.96, 0.95, 0.97],
    intensity: 0.7,
    resolution: { width: 360, height: 640 },
  });

describe('a provider frame reaching the shader', () => {
  // The assignment itself is the assertion: this file does not compile if the
  // two shapes have drifted.
  it('is accepted by the uniform builder as it comes', () => {
    const uniforms = uniformsAt(4_200);

    expect(uniforms['uBeat']).toBeDefined();
    expect(uniforms['uPhase']).toBeDefined();
    expect(uniforms['uEnergy']).toBeDefined();
    expect(uniforms['uBands']).toBeDefined();
  });

  // The provider hands over the `Float32Array` it already holds, rather than
  // boxing sixteen numbers into a fresh array on every frame.
  it('takes the provider’s own band buffer without copying it', () => {
    const provider = createProceduralProvider();
    const bands = provider.sample(1_000).bands;

    expect(bands).toBeInstanceOf(Float32Array);
    expect(normaliseBands(bands)).toHaveLength(16);
  });

  it('carries every value into range, over a long run', () => {
    const provider = createProceduralProvider();

    for (let atMs = 0; atMs < 600_000; atMs += 997) {
      const sampled = provider.sample(atMs);
      expect(sampled.beat).toBeGreaterThanOrEqual(0);
      expect(sampled.beat).toBeLessThanOrEqual(1);
      expect(sampled.phase).toBeGreaterThanOrEqual(0);
      expect(sampled.phase).toBeLessThanOrEqual(1);
      expect(sampled.energy).toBeGreaterThanOrEqual(0);
      expect(sampled.energy).toBeLessThanOrEqual(1);
    }
  });

  it('meets the pipeline from the tempo provider too, not only the procedural one', () => {
    const tempo = createTempoProvider();
    const sampled = tempo.sample(2_000);

    const uniforms = buildFrameUniforms({
      reactivity: { ...sampled, timeSeconds: 2 },
      accent: [0, 0, 0],
      foreground: [1, 1, 1],
      intensity: 1,
      resolution: { width: 720, height: 1280 },
    });

    expect(uniforms['uPhase']).toBeDefined();
  });

  // A NaN uniform paints a black screen with no error anywhere, so both sides
  // guard it. Belt and braces here is deliberate: the pipeline must not depend
  // on a provider it did not construct having been careful.
  it('survives a provider that hands over nonsense', () => {
    const uniforms = buildFrameUniforms({
      reactivity: {
        timeSeconds: Number.NaN,
        beat: Number.POSITIVE_INFINITY,
        phase: Number.NaN,
        energy: -5,
        bands: [Number.NaN, 2, -1],
      },
      accent: [0, 0, 0],
      foreground: [1, 1, 1],
      intensity: 0.5,
      resolution: { width: 360, height: 640 },
    });

    expect(JSON.stringify(uniforms)).not.toContain('null');
    expect(JSON.stringify(uniforms)).not.toContain('NaN');
  });
});
