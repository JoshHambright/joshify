/**
 * A uniform used in both stages must carry the same precision in both.
 *
 * GLSL ES says so, and the consequence is a **link** failure — not a compile
 * failure, not a warning, and not something any amount of reading the two
 * shaders separately will reveal. It cost a black screen: the tunnel's vertex
 * shader declares `precision highp float`, its fragment shader `mediump`, and
 * `uBeat` inherited a different default in each. Every headless test passed.
 *
 * So this walks every scene in the catalogue and compares the precision each
 * uniform is declared with on both sides. It is a lint, not a render, and it
 * catches the whole class rather than the one instance.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CATALOGUE } from './passes.js';

type Precision = 'lowp' | 'mediump' | 'highp';

/** The file-level default, from `precision <p> float;`. */
const defaultPrecision = (source: string): Precision => {
  const match = /^\s*precision\s+(lowp|mediump|highp)\s+float\s*;/m.exec(source);
  return (match?.[1] as Precision | undefined) ?? 'mediump';
};

/**
 * Every uniform a stage declares, with the precision it ends up at — its own
 * qualifier if it has one, the file default otherwise. Sampler types are
 * skipped: their precision is fixed by the implementation, not the source.
 */
const uniformPrecisions = (source: string): Map<string, Precision> => {
  const found = new Map<string, Precision>();
  const pattern =
    /^\s*uniform\s+(?:(lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm;
  const fallback = defaultPrecision(source);
  let match = pattern.exec(source);
  while (match !== null) {
    const [, explicit, type, name] = match;
    if (type !== undefined && name !== undefined && !type.startsWith('sampler')) {
      found.set(name, (explicit as Precision | undefined) ?? fallback);
    }
    match = pattern.exec(source);
  }
  return found;
};

describe('reading uniform precision out of a shader', () => {
  it('takes the file default when there is no qualifier', () => {
    const source = 'precision mediump float;\nuniform float uBeat;\n';
    expect(uniformPrecisions(source).get('uBeat')).toBe('mediump');
  });

  it('prefers an explicit qualifier over the default', () => {
    const source = 'precision highp float;\nuniform mediump float uBeat;\n';
    expect(uniformPrecisions(source).get('uBeat')).toBe('mediump');
  });

  it('handles arrays and ignores samplers', () => {
    const source =
      'precision mediump float;\nuniform float uBands[16];\nuniform sampler2D uArt;\n';
    const found = uniformPrecisions(source);
    expect(found.get('uBands')).toBe('mediump');
    expect(found.has('uArt')).toBe(false);
  });
});

describe('every scene in the catalogue', () => {
  // The bug this file exists for. A link error on hardware, invisible here
  // until something compares the two stages.
  it.each(BUILT_IN_CATALOGUE.scenes.map((scene) => [scene.id, scene] as const))(
    'declares %s’s shared uniforms at one precision',
    (_id, scene) => {
      const inVertex = uniformPrecisions(scene.vertex);
      const inFragment = uniformPrecisions(scene.fragment);

      // A scene may legitimately share nothing: the flat scene's vertex shader
      // is a pass-through and declares no uniforms at all. The anti-vacuity
      // check belongs to the catalogue as a whole, below, not to each scene.
      const shared = [...inVertex.keys()].filter((name) => inFragment.has(name));

      for (const name of shared) {
        expect(
          inVertex.get(name),
          `${scene.id}: ${name} is ${String(inVertex.get(name))} in the vertex shader and ${String(inFragment.get(name))} in the fragment shader — this fails to link`,
        ).toBe(inFragment.get(name));
      }
    },
  );

  // Without this the suite above passes just as happily if every scene stops
  // sharing uniforms, or if the parser silently stops finding any.
  it('actually has something to check', () => {
    const sharedCounts = BUILT_IN_CATALOGUE.scenes.map((scene) => {
      const inFragment = uniformPrecisions(scene.fragment);
      return [...uniformPrecisions(scene.vertex).keys()].filter((name) =>
        inFragment.has(name),
      ).length;
    });

    expect(Math.max(...sharedCounts)).toBeGreaterThan(0);
  });
});
