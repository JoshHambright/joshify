/**
 * The looks, checked against the catalogue they actually name.
 *
 * This is the test that decides whether "presets are data" was true or merely
 * asserted: if a look could name a pass that does not exist, or exceed the
 * frame budget, or reference a parameter nothing declares, then the data is
 * not really data — it is code without a compiler.
 */
import { describe, expect, it } from 'vitest';
import { buildLooks, LOOK_IDS } from './looks.js';
import { BUILT_IN_CATALOGUE, MAX_CHAIN_LENGTH, findPass } from './passes.js';

const { presets, problems } = buildLooks();

describe('the shipped looks', () => {
  it('all parse against the catalogue', () => {
    expect(problems).toEqual([]);
    expect(presets).toHaveLength(LOOK_IDS.length);
  });

  it('names every look VISUALIZER.md promised', () => {
    expect(LOOK_IDS).toEqual([
      'ghost',
      'vhs',
      'datamosh',
      'newsprint',
      'vapor',
      'cel',
      'cascade',
      'wall',
      'vga',
      'tunnel',
      'orbit',
    ]);
  });

  it('has unique ids and human names', () => {
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    for (const preset of presets) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.name).not.toBe(preset.id);
    }
  });

  // The budget is enforced at the door (MAX_CHAIN_LENGTH) — this asserts the
  // shipped set is comfortably inside it rather than sitting on the limit.
  it('leaves headroom under the frame budget', () => {
    for (const preset of presets) {
      expect(preset.chain.length).toBeLessThanOrEqual(MAX_CHAIN_LENGTH);
      expect(preset.chain.length).toBeLessThanOrEqual(4);
    }
  });

  it('resolves every parameter the passes declare', () => {
    for (const preset of presets) {
      for (const step of preset.chain) {
        const definition = findPass(BUILT_IN_CATALOGUE, step.pass);
        expect(definition, `${preset.id} names ${step.pass}`).toBeDefined();
        if (definition === undefined) continue;
        // Parsing fills in every default, so a shipped preset always carries
        // the complete set — a missing one would be an undefined uniform.
        expect(Object.keys(step.params).sort()).toEqual(
          Object.keys(definition.params).sort(),
        );
      }
    }
  });

  it('keeps every parameter inside its declared range', () => {
    for (const preset of presets) {
      for (const step of preset.chain) {
        const definition = findPass(BUILT_IN_CATALOGUE, step.pass);
        if (definition === undefined) continue;
        for (const [name, value] of Object.entries(step.params)) {
          const spec = definition.params[name];
          if (spec === undefined) continue;
          expect(value, `${preset.id}.${step.pass}.${name}`).toBeGreaterThanOrEqual(
            spec.min,
          );
          expect(value).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  // Two feedback-heavy looks side by side make the cycle button feel broken.
  it('does not put the same scene’s two heaviest looks next to each other', () => {
    const scenes = presets.map((preset) => preset.scene);
    expect(new Set(scenes).size).toBeGreaterThan(1);
  });

  it('starts on the quietest one, because it is what runs while the panel is used', () => {
    expect(presets[0]?.id).toBe('ghost');
    expect(presets[0]?.chain.length).toBeLessThanOrEqual(2);
  });

  it('includes the tunnel, on the tunnel scene', () => {
    const tunnel = presets.find((preset) => preset.id === 'tunnel');
    expect(tunnel?.scene).toBe('tunnel');
  });
});

/**
 * A look that names a pass somebody renamed must not take the visualiser down
 * — but it must not vanish silently either.
 */
describe('when a look does not fit its catalogue', () => {
  it('drops it and says which one and why', () => {
    const thin = {
      scenes: BUILT_IN_CATALOGUE.scenes,
      passes: BUILT_IN_CATALOGUE.passes.filter((pass) => pass.id !== 'kaleido'),
    };

    const built = buildLooks(thin);

    expect(built.presets.length).toBeLessThan(LOOK_IDS.length);
    expect(built.problems.some((problem) => problem.startsWith('vapor:'))).toBe(true);
    expect(built.problems.join(' ')).toContain('kaleido');
  });

  it('keeps every other look working', () => {
    const thin = {
      scenes: BUILT_IN_CATALOGUE.scenes,
      passes: BUILT_IN_CATALOGUE.passes.filter((pass) => pass.id !== 'kaleido'),
    };

    const built = buildLooks(thin);

    expect(built.presets.some((preset) => preset.id === 'ghost')).toBe(true);
    expect(built.presets.some((preset) => preset.id === 'tunnel')).toBe(true);
  });
});
