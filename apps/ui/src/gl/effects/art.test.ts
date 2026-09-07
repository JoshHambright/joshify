import { describe, expect, it } from 'vitest';
import { isOk } from '@joshify/core';
import {
  FLAT_SCENE,
  MAX_CHAIN_LENGTH,
  parsePreset,
  type Catalogue,
  type PassDefinition,
} from '../passes.js';
import { paramUniformName } from '../uniforms.js';
import {
  ART_PASSES,
  CYCLE_PASS,
  DISPLACE_PASS,
  EDGE_PASS,
  MATRIX_PASS,
  SHATTER_PASS,
  SLITSCAN_PASS,
} from './art.js';

/**
 * How a shader *looks* is not testable from Node, and there is no GL in CI at
 * all. What is testable is everything that can be wrong about a pass before it
 * ever reaches a GPU — and on this hardware most of those failures are silent.
 * A misspelled uniform links cleanly, reads zero and draws black. A uniform
 * declared `highp` here and `mediump` in another pass fails to *link*, on the
 * Pi, in a room, with nothing anywhere saying why. A `1e9` sentinel overflows
 * fp16 and comes back as infinity.
 *
 * So the lints below are written as small functions over the shader text and
 * run across the whole family, and each function is proved against a synthetic
 * source first — a lint nobody has seen fail is a lint that might match
 * nothing at all.
 */

/* ------------------------------------------------------------------ */
/* The lints                                                           */
/* ------------------------------------------------------------------ */

/**
 * Comments are stripped before anything is counted or matched. Otherwise a
 * comment explaining why a pass does not `discard` fails the assertion that it
 * does not discard, and a uniform named in prose is audited as if it had been
 * declared.
 */
const glslCode = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');

/** `uniform float uAmount;`, `uniform float uBands[16];`, qualifier or not. */
const UNIFORM =
  /^\s*uniform\s+(?:(lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*\d+\s*\])?\s*;/gm;

interface Declared {
  readonly name: string;
  readonly type: string;
  readonly qualifier: string | null;
}

const declarations = (source: string): readonly Declared[] =>
  [...glslCode(source).matchAll(UNIFORM)].map(([, qualifier, type, name]) => ({
    name: name ?? '',
    type: type ?? '',
    qualifier: qualifier ?? null,
  }));

const declaredUniforms = (source: string): readonly string[] =>
  declarations(source).map((declared) => declared.name);

const occurrences = (source: string, identifier: string): number =>
  glslCode(source).match(new RegExp(`\\b${identifier}\\b`, 'g'))?.length ?? 0;

/**
 * A single-fetch helper, of the shape both `displace` and `edge` use to clamp
 * their taps of the wrapping art texture: `float name(vec2 uv) { ... }`. The
 * body pattern deliberately has no nested braces in it — a helper that grew
 * one would stop being a single-fetch helper anyway.
 */
const FETCH_HELPER = /\bfloat\s+(\w+)\s*\(\s*vec2\s+\w+\s*\)\s*\{([^}]*)\}/g;

const textureCalls = (source: string): number =>
  source.match(/\btexture\s*\(/g)?.length ?? 0;

/**
 * What a pass really costs in fetches, which is not the number of `texture(`
 * calls in the text: eight Sobel taps written as eight calls to a one-fetch
 * helper appear as one. Each helper body is counted once per call site
 * instead, so the figure matches the docblock and the frame budget.
 */
const fetches = (source: string): number => {
  const code = glslCode(source);
  let total = textureCalls(code);
  for (const [, name, body] of code.matchAll(FETCH_HELPER)) {
    const inBody = textureCalls(body ?? '');
    if (inBody === 0 || name === undefined) continue;
    // Every mention but the definition is a call site.
    const sites = (code.match(new RegExp(`\\b${name}\\s*\\(`, 'g'))?.length ?? 1) - 1;
    total += inBody * (sites - 1);
  }
  return total;
};

/**
 * A `step()` whose argument mentions a hash. `glitch.ts` documents the trap: a
 * mediump hash can round to exactly 1.0, so a step against one is not reliably
 * off at zero intensity and needs the explicit `on` guard.
 */
const hashGates = (source: string): number =>
  glslCode(source).match(/\bstep\s*\([^;]*\bhash\w*\s*\(/g)?.length ?? 0;

/**
 * Numeric literals a `mediump` float cannot hold. fp16 tops out at 65504, so
 * the usual `1e9` loop sentinel arrives as infinity and every comparison
 * against it is wrong in a way that only shows up on the device.
 */
const MEDIUMP_MAX = 65504;

const oversizedLiterals = (source: string): readonly string[] =>
  [...glslCode(source).matchAll(/\b\d+\.?\d*(?:e[-+]?\d+)?\b/gi)]
    .map(([literal]) => literal)
    .filter((literal) => Number(literal) > MEDIUMP_MAX);

describe('the lints themselves', () => {
  it('strips both comment forms before matching', () => {
    expect(glslCode('a // uGhost discard\nb')).toBe('a  \nb');
    expect(glslCode('a /* uGhost\ndiscard */ b')).toBe('a   b');
  });

  it('reads a uniform declaration with or without a qualifier', () => {
    const source = 'uniform highp float uA;\nuniform float uBands[16];\n';
    expect(declarations(source)).toEqual([
      { name: 'uA', type: 'float', qualifier: 'highp' },
      { name: 'uBands', type: 'float', qualifier: null },
    ]);
  });

  it('counts identifiers and fetches', () => {
    expect(occurrences('uBeat + uBeatles + uBeat', 'uBeat')).toBe(2);
    expect(fetches('texture(uArt, v) + texture (uPrev, v)')).toBe(2);
  });

  /**
   * The one that would otherwise undercount by seven: `edge` writes its eight
   * Sobel taps as eight calls to a helper that fetches once.
   */
  it('charges a one-fetch helper once per call site', () => {
    const source = `float tap(vec2 uv) { return texture(uArt, uv).r; }
void main() { float a = tap(p) + tap(q) + tap(r); }`;

    expect(textureCalls(source)).toBe(1);
    expect(fetches(source)).toBe(3);
  });

  it('sees a hash inside a step, and nothing else', () => {
    expect(hashGates('float fire = step(1.0 - gate, hash21(cell));')).toBe(1);
    expect(hashGates('float take = step(d, best);\nvec2 h = hash22(id);')).toBe(0);
  });

  it('finds a literal that overflows mediump, and passes the ones that do not', () => {
    expect(oversizedLiterals('float best = 1e9;')).toEqual(['1e9']);
    expect(oversizedLiterals('float best = 8.0; float k = 43758.5453;')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The family                                                          */
/* ------------------------------------------------------------------ */

const each = (assert: (pass: PassDefinition) => void): void => {
  for (const pass of ART_PASSES) assert(pass);
};

const paramNames = (pass: PassDefinition): readonly string[] => Object.keys(pass.params);

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
 * The ids that were taken before this family existed.
 *
 * Written out rather than read from `BUILT_IN_CATALOGUE`, because the whole
 * point is to survive this family being registered there: derived from the
 * catalogue, the assertion would start passing vacuously the moment it stopped
 * being able to fail.
 */
const TAKEN: readonly string[] = [
  'feedback',
  'grain',
  'rgbsplit',
  'blockshift',
  'smear',
  'tear',
  'dropout',
  'bitcrush',
  'vhs',
  'crt',
  'dither',
  'posterize',
  'bloom',
  'halftone',
  'bars',
  'scope',
  'kaleido',
  'particles',
  'fifteenbit',
  'twoforty',
  'flat',
  'tunnel',
];

const catalogue: Catalogue = { scenes: [FLAT_SCENE], passes: ART_PASSES };

describe('the art-derived family', () => {
  it('exports each pass exactly once, in the documented order', () => {
    expect(ART_PASSES).toEqual([
      SHATTER_PASS,
      SLITSCAN_PASS,
      DISPLACE_PASS,
      CYCLE_PASS,
      EDGE_PASS,
      MATRIX_PASS,
    ]);
    expect(ART_PASSES.map((pass) => pass.id)).toEqual([
      'shatter',
      'slitscan',
      'displace',
      'cycle',
      'edge',
      'matrix',
    ]);
  });

  /**
   * A preset names a pass by id and the artwork route validates one against a
   * letters-only pattern, so an id with a capital or a digit is a pass that
   * loads in a test and 404s on the device.
   */
  it('gives every pass a unique, lowercase, letters-only id', () => {
    const ids = ART_PASSES.map((pass) => pass.id);

    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * `findPass` returns the *first* match, so a duplicate id does not fail —
   * it shadows, silently, and the pass whose slider stops working is whichever
   * one was registered second (the note at the bottom of `lofi.ts`).
   */
  it('collides with none of the ids that were already taken', () => {
    for (const pass of ART_PASSES) expect(TAKEN).not.toContain(pass.id);
  });

  it('registers as a catalogue and parses as a chain, defaults and all', () => {
    const result = parsePreset(
      { id: 'art', scene: 'flat', chain: ART_PASSES.map((pass) => ({ pass: pass.id })) },
      catalogue,
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.chain.map((step) => step.pass)).toEqual(
      ART_PASSES.map((pass) => pass.id),
    );
    expect(result.value.chain[0]?.params).toEqual({
      cells: 10,
      burst: 0.4,
      spin: 0.5,
      crack: 0.5,
    });
  });

  /** Six passes against a six-pass budget: the family is exactly one chain. */
  it('fits the frame budget as a single chain', () => {
    expect(ART_PASSES.length).toBe(MAX_CHAIN_LENGTH);
  });

  /**
   * Every one of these filters what the stage before it drew, which is exactly
   * what an overlay may not do — an overlay is given no `uTexture` (D-062).
   */
  it('leaves every pass inside the scaled chain rather than over it', () => {
    each((pass) => {
      expect(pass.overlay).toBeUndefined();
      expect(pass.fragment).toContain('uniform sampler2D uTexture;');
    });
  });
});

describe('the shader preamble', () => {
  /**
   * `#version` must be the very first characters of the source — not the first
   * non-blank line. A leading newline out of a template literal is a compile
   * error that only appears on a device with a GPU.
   */
  it('opens with the version directive and the precision it costs', () => {
    each((pass) => {
      expect(
        pass.fragment.startsWith('#version 300 es\nprecision mediump float;\n'),
      ).toBe(true);
      expect(pass.fragment).not.toContain('precision highp float;');
    });
  });

  it('writes one output, from one entry point', () => {
    each((pass) => {
      expect(pass.fragment).toContain('out vec4 fragColour;');
      expect(occurrences(pass.fragment, 'main')).toBe(1);
    });
  });
});

describe('what a tile-based GPU cannot afford', () => {
  /**
   * `discard` leaves a fragment's coverage undecided and drags the whole tile
   * down a slow path on a VideoCore VII. Nothing in a full-screen post pass
   * needs it.
   */
  it('never discards', () => {
    each((pass) => {
      expect(glslCode(pass.fragment)).not.toMatch(/\bdiscard\b/);
    });
  });

  /**
   * A loop whose bound comes from data cannot be unrolled and makes the
   * shader's cost a property of the music. The only loop in the family is
   * `shatter`'s Voronoi search, and its bound is the literal 9.
   */
  it('loops only over constant bounds', () => {
    each((pass) => {
      expect(glslCode(pass.fragment)).not.toMatch(/\bwhile\b/);
      for (const match of glslCode(pass.fragment).matchAll(/for\s*\(([^)]*)\)/g)) {
        expect(match[1] ?? '').toMatch(/^int \w+ = \d+; \w+ < \d+; \+\+\w+$/);
      }
    });
  });

  it('puts the only loop in shatter, bounded at the nine cells around a fragment', () => {
    const looping = ART_PASSES.filter((pass) =>
      /\bfor\s*\(/.test(glslCode(pass.fragment)),
    );

    expect(looping.map((pass) => pass.id)).toEqual(['shatter']);
    expect(SHATTER_PASS.fragment).toContain('for (int i = 0; i < 9; ++i)');
  });

  /**
   * fp16 tops out at 65504, so the idiomatic `1e9` starting distance in a
   * Voronoi search arrives as infinity. `shatter` starts at 8.0 instead, and
   * the comment beside it says why.
   */
  it('uses no literal a mediump float cannot hold', () => {
    each((pass) => {
      expect({ pass: pass.id, oversized: oversizedLiterals(pass.fragment) }).toEqual({
        pass: pass.id,
        oversized: [],
      });
    });
  });
});

describe('the uniform contract', () => {
  /**
   * The check this file exists for. Nothing at runtime complains about a
   * uniform nobody binds: `getUniformLocation` returns null, the pipeline skips
   * it, the value reads zero, and the pass draws black on the Pi and nowhere
   * else. A `uTexlel` is caught here or in a dark room.
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

  /** The other direction: a parameter with no uniform is a slider that moves nothing. */
  it('declares a float uniform for every parameter it advertises', () => {
    each((pass) => {
      const declared = new Set(declaredUniforms(pass.fragment));
      for (const name of paramNames(pass)) {
        const uniform = paramUniformName(name);
        expect({ pass: pass.id, uniform, declared: declared.has(uniform) }).toEqual({
          pass: pass.id,
          uniform,
          declared: true,
        });
        expect(pass.fragment).toContain(`uniform float ${uniform};`);
      }
    });
  });

  /**
   * And the mirror: a declared uniform nobody reads is a location the pipeline
   * looks up every frame for nothing, and — if it is a parameter — a dial in
   * the preset UI that does nothing at all.
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

  /**
   * A uniform used in two stages must carry the same precision in both or the
   * program fails to *link* (`precision.test.ts`, and it cost a black screen
   * once already). These passes are fragment-only, so the risk is between
   * *passes* rather than between stages — and the cheapest way never to have
   * that argument is for no uniform anywhere in the family to carry a
   * qualifier at all. `highp` is a local qualifier here, or it is nothing.
   */
  it('leaves every uniform at the file default precision', () => {
    each((pass) => {
      for (const declared of declarations(pass.fragment)) {
        expect({
          pass: pass.id,
          uniform: declared.name,
          qualifier: declared.qualifier,
        }).toEqual({ pass: pass.id, uniform: declared.name, qualifier: null });
      }
    });
  });

  /**
   * `highp` fragment work is a real cost on a VideoCore VII, so it is used
   * only where a coordinate needs it: the lattice and the hash in `shatter`,
   * the raster grid in `matrix`. If it appears anywhere else, something has
   * started paying for precision it does not need.
   */
  it('keeps highp to the two passes whose coordinates need it', () => {
    const precise = ART_PASSES.filter((pass) =>
      glslCode(pass.fragment).includes('highp'),
    );

    expect(precise.map((pass) => pass.id)).toEqual(['shatter', 'matrix']);
  });
});

describe('the dial and the beat', () => {
  /**
   * A pass that ignores `uIntensity` cannot be turned down, so the legibility
   * floor (P5-16) would have to drop it from the chain instead — a visible pop
   * rather than a fade.
   */
  it('gives uIntensity something to do in every pass', () => {
    each((pass) => {
      expect(declaredUniforms(pass.fragment)).toContain('uIntensity');
      expect(occurrences(pass.fragment, 'uIntensity')).toBeGreaterThan(1);
    });
  });

  /**
   * **The exact-pass-through ledger.** That `uIntensity == 0` is a bit-for-bit
   * copy is arithmetic, and arithmetic is not assertable from Node — but the
   * *expression* that makes it true is. Each entry below is the line the
   * docblock's guarantee rests on; changing one without changing the other
   * fails here rather than on a slider that never quite switches off.
   */
  it('carries the expression that makes zero intensity an exact copy', () => {
    const ledger: Readonly<Record<string, string>> = {
      shatter: 'piece * (1.0 - seam * uCrack * uIntensity)',
      slitscan:
        'float keep = clamp(uHold * far * (1.0 - uSnap * uBeat), 0.0, 0.985) * uIntensity;',
      displace: 'vec2 offset = flow * uAmount * (0.35 + 0.65 * uBeat) * uIntensity;',
      cycle: 'mix(here, clamp(keyed, 0.0, 1.0), uAmount * uIntensity)',
      edge: 'mix(here, ink, line * uAmount * uIntensity)',
      matrix: 'mix(here, lit, uIntensity)',
    };

    each((pass) => {
      expect(pass.fragment).toContain(ledger[pass.id] ?? '<no ledger entry>');
    });
    expect(Object.keys(ledger).sort()).toEqual(ART_PASSES.map((p) => p.id).toSorted());
  });

  /**
   * `shatter` displaces by a hashed amount, but it never *gates* on a hash —
   * every hashed term is multiplied by `uIntensity`, so the mediump-rounds-to-
   * 1.0 trap `glitch.ts` documents cannot bite. Should one ever start gating,
   * it needs the explicit `on` guard, and this is where that is noticed.
   */
  it('gates nothing on a hash, or guards it if it does', () => {
    each((pass) => {
      if (hashGates(pass.fragment) === 0) return;
      expect(pass.fragment).toContain('float on = step(0.0001, uIntensity);');
    });
    // Anti-vacuity: the detector above is what makes this test mean anything.
    expect(hashGates('step(1.0 - gate, hash22(cell).x)')).toBe(1);
  });

  /**
   * The whole point of Phase 5. An effect that runs off `uTime` alone is a
   * screensaver, and the three-tier provider (D-010) exists so it does not
   * have to be one. This family goes further than family B and uses no clock
   * at all — every pass is on the beat grid or on the spectrum.
   */
  it('binds every pass to the music and none of them to the clock', () => {
    each((pass) => {
      const musical = ['uBeat', 'uPhase', 'uBands', 'uEnergy'].filter(
        (name) => occurrences(pass.fragment, name) > 1,
      );

      expect({ pass: pass.id, musical: musical.length > 0 }).toEqual({
        pass: pass.id,
        musical: true,
      });
      expect({ pass: pass.id, clock: occurrences(pass.fragment, 'uTime') }).toEqual({
        pass: pass.id,
        clock: 0,
      });
    });
  });
});

describe('the family thesis', () => {
  /**
   * The cover is the *source material*, not a backdrop (VISUALIZER.md, family
   * E). Four of the six reach past `uTexture` for it — three to the raw cover
   * and one to the frame's own history — and this ledger is what stops that
   * quietly becoming zero as passes are edited.
   */
  it('reads the artwork or the history in four of the six', () => {
    const extra = ART_PASSES.filter((pass) => {
      const declared = new Set(declaredUniforms(pass.fragment));
      return declared.has('uArt') || declared.has('uPrev');
    }).map((pass) => pass.id);

    expect(extra).toEqual(['slitscan', 'displace', 'cycle', 'edge']);
  });

  /**
   * `edge` and `displace` take their field from the *raw* cover rather than
   * from the chain, and both docblocks turn on that: a Sobel of `uTexture`
   * after a dither finds the noise, and a flow field taken from the chain
   * moves as the picture moves through it.
   */
  it('reads the field of edge and displace from uArt, not from the chain', () => {
    for (const pass of [EDGE_PASS, DISPLACE_PASS]) {
      expect(pass.fragment).toContain('texture(uArt,');
    }
  });

  /**
   * `uArt` is a `REPEAT` texture, because the tunnel tiles it (P5-25) and this
   * file cannot change the sampler. A neighbourhood tap off one edge therefore
   * returns from the other, and the difference across that border is a
   * fiction — a hard false contour all the way round the frame. Both passes
   * that tap a neighbourhood clamp by hand.
   */
  it('clamps every neighbourhood tap of the wrapping art texture', () => {
    for (const pass of [EDGE_PASS, DISPLACE_PASS]) {
      expect(pass.fragment).toContain('texture(uArt, clamp(uv, 0.0, 1.0))');
    }
  });
});

describe('cost', () => {
  /**
   * The budget is six passes a frame at 60fps on a VideoCore VII, so the fetch
   * count in each docblock is a claim the chain is planned against. Pinning it
   * here means "one more tap" has to be a deliberate edit to this table too.
   */
  it('costs the fetches its docblock says it does', () => {
    const budget: Readonly<Record<string, number>> = {
      shatter: 1,
      slitscan: 2,
      displace: 5,
      cycle: 2,
      edge: 9,
      matrix: 2,
    };

    each((pass) => {
      expect({ pass: pass.id, fetches: fetches(pass.fragment) }).toEqual({
        pass: pass.id,
        fetches: budget[pass.id],
      });
    });
  });

  /**
   * `edge` is this family's `bloom` — a full Sobel is eight taps and there is
   * no cheaper honest one on a `NEAREST` sampler, where the four-bilinear-tap
   * trick collapses to four point samples. Everything else stays at or under
   * five.
   */
  it('keeps every pass but edge to five fetches', () => {
    each((pass) => {
      if (pass.id === 'edge') return;
      expect(fetches(pass.fragment)).toBeLessThanOrEqual(5);
    });
    expect(fetches(EDGE_PASS.fragment)).toBe(9);
  });
});

describe('parameters are a range a preset can be trusted with', () => {
  it('puts every default inside its own bounds', () => {
    each((pass) => {
      for (const [name, param] of Object.entries(pass.params)) {
        expect(param.min, `${pass.id}.${name}`).toBeLessThan(param.max);
        expect(param.default, `${pass.id}.${name}`).toBeGreaterThanOrEqual(param.min);
        expect(param.default, `${pass.id}.${name}`).toBeLessThanOrEqual(param.max);
      }
    });
  });

  /**
   * A parameter reaches the GPU as a float uniform, so a bound that is not
   * finite arrives as a NaN and takes the frame with it — `uniforms.ts`
   * sanitises the values a preset supplies, not the bounds a shader declares.
   */
  it('bounds everything with real numbers, and gives every pass something to tune', () => {
    each((pass) => {
      expect(paramNames(pass).length).toBeGreaterThan(0);
      for (const param of Object.values(pass.params)) {
        expect(Number.isFinite(param.default)).toBe(true);
        expect(Number.isFinite(param.min)).toBe(true);
        expect(Number.isFinite(param.max)).toBe(true);
      }
    });
  });

  /**
   * Sizes are in pixels of the stage being rendered. A sub-pixel gradient tap
   * or LED cell is arithmetic done per fragment for nothing — the most
   * expensive way available to render the input unchanged.
   */
  it('never lets a size in texels fall below one', () => {
    expect(DISPLACE_PASS.params['spread']?.min).toBeGreaterThanOrEqual(1);
    expect(MATRIX_PASS.params['pitch']?.min).toBeGreaterThanOrEqual(1);
    expect(EDGE_PASS.params['width']?.min).toBeGreaterThan(0);
  });

  /**
   * Two caps that are legibility limits rather than taste, in the sense P5-16
   * uses: past 32 texels an LED cell has eaten the picture it is made of, and
   * a cover has more shape in it than 40 shards can carry. Asserted so a later
   * "just a bit coarser" has to argue with a test.
   */
  it('caps the two parameters that decide how much of the cover survives', () => {
    expect(MATRIX_PASS.params['pitch']?.max).toBe(32);
    expect(SHATTER_PASS.params['cells']?.max).toBe(40);
  });

  /**
   * `cycle` is the one pass here that can invert luminance, and `tone` is the
   * dial that stops it: at 1 the remap is hue-only. The floor has to be able
   * to reach that, so the range must include both ends.
   */
  it('lets cycle be turned all the way to hue-only', () => {
    expect(CYCLE_PASS.params['tone']).toEqual({ default: 0.45, min: 0, max: 1 });
  });
});

describe('what each pass does to contrast, as P5-16 will read it', () => {
  /**
   * Not a rendering test — a documentation test. P5-16's legibility floor
   * treats each pass's contrast behaviour as fact, and the only place that
   * fact is written down is the docblock. This asserts the two claims that
   * would silently stop being true if somebody edited the shader without
   * reading them: that `slitscan` blends rather than scales, and that `matrix`
   * has an analytic coverage term to divide by.
   */
  it('keeps slitscan a convex blend of two frames', () => {
    expect(SLITSCAN_PASS.fragment).toContain('mix(here, past, keep)');
    // A convex combination is only convex while the weight is inside 0..1.
    expect(SLITSCAN_PASS.fragment).toContain('0.0, 0.985)');
  });

  it('keeps the matrix coverage term analytic rather than tuned', () => {
    // pi/4 * fill^2 -- the lit area of a disc of radius fill/2 in a unit cell.
    expect(MATRIX_PASS.fragment).toContain('float coverage = 0.7853982 * fill * fill;');
    expect(MATRIX_PASS.fragment).toContain('mix(1.0, 1.0 / max(coverage, 0.05), uGain)');
  });
});
