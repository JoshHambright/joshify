import { beforeEach, describe, expect, it } from 'vitest';
import {
  createPipeline,
  planFrame,
  TARGET_IDS,
  type PlanInput,
  type RenderInputs,
  type RenderPlan,
  type TargetId,
} from './pipeline.js';
import {
  FEEDBACK_PASS,
  FLAT_SCENE,
  GRAIN_PASS,
  type Catalogue,
  type Preset,
} from './passes.js';
import { createDegrader, type QualityLevel } from './budget.js';
import { UNIT_ART, UNIT_PREV, UNIT_TEXTURE } from './uniforms.js';
import { createFakeGl, type FakeGl, type GlCall } from './testing/fake-gl.js';
import {
  createGlContext,
  GlProgramError,
  float,
  floats,
  sampler,
  vec2,
  vec3,
} from './gl-context.js';

const PANEL = { width: 720, height: 1280 };

const TUBE_SCENE = {
  id: 'tube',
  vertex: '#version 300 es\nvoid main() {}\n',
  fragment: '#version 300 es\n// tube\nvoid main() {}\n',
  geometry: {
    attributes: [{ location: 0, size: 3, data: new Float32Array([0, 0, 0]) }],
    indices: new Uint16Array([0, 1, 2]),
    count: 3,
  },
  depthTest: true,
  params: {},
};

const BARS_PASS = {
  id: 'bars',
  fragment: '#version 300 es\n// bars\nvoid main() {}\n',
  params: {},
  overlay: true,
};

/**
 * A fixture, not the shipping catalogue.
 *
 * It used to spread `BUILT_IN_CATALOGUE.passes`, which meant these counts
 * changed the moment anyone added a shader — a pipeline test failing because
 * the effect library grew is a test measuring the wrong thing. Two passes and
 * two scenes is all the pipeline needs to be exercised over.
 */
const catalogue: Catalogue = {
  scenes: [FLAT_SCENE, TUBE_SCENE],
  passes: [FEEDBACK_PASS, GRAIN_PASS, BARS_PASS],
};

const preset = (chain: readonly string[], scene = 'flat'): Preset => ({
  id: 'test',
  name: 'Test',
  scene,
  sceneParams: { flash: 0.2 },
  chain: chain.map((pass) => ({ pass, params: {} })),
});

const quality = (over: Partial<QualityLevel> = {}): QualityLevel => ({
  scale: 0.5,
  maxPasses: 6,
  ...over,
});

const plan = (over: Partial<PlanInput> = {}): RenderPlan =>
  planFrame({
    preset: preset(['feedback', 'grain']),
    catalogue,
    outputSize: PANEL,
    quality: quality(),
    previousFinal: null,
    ...over,
  });

const frame = (over: Partial<RenderInputs> = {}): RenderInputs => ({
  reactivity: { timeSeconds: 1, beat: 0.5, phase: 0.5, energy: 0.5, bands: [] },
  accent: [1, 0, 0],
  foreground: [1, 1, 1],
  intensity: 1,
  ...over,
});

const callsOf = <K extends GlCall['op']>(
  fake: FakeGl,
  op: K,
): readonly Extract<GlCall, { op: K }>[] =>
  fake.calls.filter((call): call is Extract<GlCall, { op: K }> => call.op === op);

/** The three render-target textures, in `TARGET_IDS` order. */
const targetTextures = (fake: FakeGl): readonly string[] =>
  callsOf(fake, 'createFramebuffer').map((call) => call.colour);

const programFor = (fake: FakeGl, fragment: string): string =>
  callsOf(fake, 'createProgram').find((call) => call.fragment === fragment)?.label ?? '';

describe('planning a frame', () => {
  it('renders the scene first and the chain over whatever it drew', () => {
    const frameOne = plan();

    expect(frameOne.scene.scene).toBe('flat');
    expect(frameOne.chain.map((step) => step.pass)).toEqual(['feedback', 'grain']);
    expect(frameOne.chain[0]?.source).toBe(frameOne.scene.target);
  });

  /**
   * The chain is written against `uTexture`, never against a scene. That is
   * the whole of D-014: swapping `flat` for `tunnel` changes one field and no
   * pass notices.
   */
  it('plans the same chain over a 3D scene as over a flat one', () => {
    const flat = plan({ preset: preset(['feedback', 'grain'], 'flat') });
    const tube = plan({ preset: preset(['feedback', 'grain'], 'tube') });

    expect(tube.chain).toEqual(flat.chain);
    expect(tube.scene.scene).toBe('tube');
  });

  it('renders at the scale it was given, not at the panel size', () => {
    expect(plan({ quality: quality({ scale: 0.5 }) }).renderSize).toEqual({
      width: 360,
      height: 640,
    });
    expect(plan({ quality: quality({ scale: 0.25 }) }).renderSize).toEqual({
      width: 180,
      height: 320,
    });
    expect(plan().outputSize).toEqual(PANEL);
  });

  it('presents the scene directly when the preset has no passes at all', () => {
    const empty = plan({ preset: preset([]) });

    expect(empty.chain).toEqual([]);
    expect(empty.present.source).toBe(empty.scene.target);
  });

  it('skips a pass the catalogue does not have rather than drawing nothing', () => {
    const missing = plan({ preset: preset(['feedback', 'nosuchpass']) });

    expect(missing.chain.map((step) => step.pass)).toEqual(['feedback']);
  });
});

describe('the ping-pong', () => {
  /**
   * Sampling the texture you are drawing into is undefined behaviour in GLES,
   * and the classic bug in a pipeline shaped like this one: it renders fine on
   * one driver and tears on another, which on a Pi means it renders fine on
   * the laptop it was written on.
   */
  it('never reads the target it is writing', () => {
    for (let passes = 0; passes <= 5; passes += 1) {
      const frameOne = plan({ preset: preset(Array(passes).fill('grain') as string[]) });
      for (const step of frameOne.chain) {
        expect(step.source).not.toBe(step.target);
      }
    }
  });

  it('hands each pass what the pass before it wrote', () => {
    const frameOne = plan({ preset: preset(['feedback', 'grain', 'feedback']) });

    expect(frameOne.chain[1]?.source).toBe(frameOne.chain[0]?.target);
    expect(frameOne.chain[2]?.source).toBe(frameOne.chain[1]?.target);
    expect(frameOne.present.source).toBe(frameOne.chain[2]?.target);
  });

  it('alternates between exactly two targets, however long the chain', () => {
    const long = plan({ preset: preset(['feedback', 'grain', 'feedback', 'grain']) });
    const used = new Set(long.chain.map((step) => step.target));

    expect(used.size).toBe(2);
    expect(long.chain[0]?.target).toBe(long.chain[2]?.target);
  });

  /**
   * The third target is why there are three. Two would ping-pong the chain
   * happily and then let the scene overwrite last frame's result before the
   * feedback pass read it — the Milkdrop lineage of effects would silently
   * lose their history, one frame in two.
   */
  it('keeps last frame out of the rotation so feedback has something to read', () => {
    let previousFinal: TargetId | null = null;
    const seen: RenderPlan[] = [];
    for (let index = 0; index < 8; index += 1) {
      const next = plan({
        preset: preset(index % 2 === 0 ? ['feedback', 'grain'] : ['feedback']),
        previousFinal,
      });
      seen.push(next);
      previousFinal = next.present.source;
    }

    for (const [index, drawn] of seen.entries()) {
      const written = [drawn.scene.target, ...drawn.chain.map((step) => step.target)];
      expect(written).not.toContain(drawn.feedback);
      const before = seen[index - 1];
      if (before !== undefined) expect(drawn.feedback).toBe(before.present.source);
    }
  });

  it('starts on a target nothing has drawn to, so frame one reads black', () => {
    const first = plan({ previousFinal: null });

    expect(first.feedback).toBe('c');
    expect(TARGET_IDS).toContain(first.feedback);
  });
});

describe('the budget deciding what fits', () => {
  it('drops passes from the end of the chain', () => {
    const trimmed = plan({
      preset: preset(['feedback', 'grain', 'feedback']),
      quality: quality({ maxPasses: 2 }),
    });

    expect(trimmed.chain.map((step) => step.pass)).toEqual(['feedback', 'grain']);
    expect(trimmed.dropped).toBe(1);
  });

  // Never the scene: a frame with no scene is not a degraded visualiser, it is
  // a black screen (D-014 put the scene first for exactly this reason).
  it('still renders the scene when every pass has been dropped', () => {
    const stripped = plan({
      preset: preset(['feedback', 'grain']),
      quality: quality({ maxPasses: 0 }),
    });

    expect(stripped.chain).toEqual([]);
    expect(stripped.scene.scene).toBe('flat');
    expect(stripped.present.source).toBe(stripped.scene.target);
  });

  /**
   * The bars are a few dozen triangles over a frame that is already drawn, so
   * dropping them saves nothing worth the hole it leaves (P5-09).
   */
  it('keeps the overlay until every full-screen pass has gone', () => {
    const one = plan({
      preset: preset(['feedback', 'grain', 'bars']),
      quality: quality({ maxPasses: 1 }),
    });

    expect(one.chain).toEqual([]);
    expect(one.overlays.map((step) => step.pass)).toEqual(['bars']);

    const none = plan({
      preset: preset(['feedback', 'grain', 'bars']),
      quality: quality({ maxPasses: 0 }),
    });

    expect(none.overlays).toEqual([]);
  });

  it('reports nothing dropped when the chain fits', () => {
    expect(plan().dropped).toBe(0);
  });
});

describe('drawing a frame', () => {
  let fake: FakeGl;

  beforeEach(() => {
    fake = createFakeGl();
  });

  it('draws the scene, then each pass, then the upscale to the screen', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['feedback', 'grain']),
      outputSize: PANEL,
      catalogue,
    });

    const scene = programFor(fake, FLAT_SCENE.fragment);
    const targets = targetTextures(fake);
    fake.clearLog();
    pipeline.render(frame());
    const draws = fake.draws();

    expect(draws).toHaveLength(4);
    expect(draws[0]?.program).toBe(scene);
    expect(draws[0]?.attachment).toBe(targets[0]);
    expect(draws[1]?.attachment).toBe(targets[1]);
    expect(draws[2]?.attachment).toBe(targets[0]);
    expect(draws[3]?.framebuffer).toBe('screen');
    expect(draws[3]?.samplers[UNIT_TEXTURE]).toBe(targets[0]);
  });

  /**
   * The same invariant as the plan's, but asserted where it actually matters:
   * the calls that reached the driver. This is the one the recording fake
   * exists for.
   */
  it('never binds a texture it is drawing into, over many frames', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['feedback', 'grain']),
      outputSize: PANEL,
      catalogue,
    });

    for (let index = 0; index < 6; index += 1) pipeline.render(frame());

    const drawn = fake.draws();
    expect(drawn.length).toBe(4 * 6);
    for (const draw of drawn) {
      if (draw.attachment === null) continue;
      expect(Object.values(draw.samplers)).not.toContain(draw.attachment);
    }
  });

  it('binds last frame’s result as uPrev, and this frame’s source as uTexture', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['feedback']),
      outputSize: PANEL,
      catalogue,
    });

    pipeline.render(frame());
    const first = fake.draws();
    fake.clearLog();
    pipeline.render(frame());
    const second = fake.draws();

    const previousResult = first[first.length - 1]?.samplers[UNIT_TEXTURE];
    expect(second[0]?.samplers[UNIT_PREV]).toBe(previousResult);
    expect(second[1]?.samplers[UNIT_TEXTURE]).toBe(second[0]?.attachment);
  });

  it('clears once, for the scene, and not before every pass', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['feedback', 'grain']),
      outputSize: PANEL,
      catalogue,
    });

    fake.clearLog();
    pipeline.render(frame());

    expect(callsOf(fake, 'clear')).toHaveLength(1);
  });

  /**
   * A pass at half scale that is told the panel size samples half a texel off
   * — it never fails, it just looks slightly soft forever. The upscale is the
   * one stage that works in panel pixels.
   */
  it('tells the chain the render size and the upscale the panel size', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
      degrader: createDegrader({ ceilingScale: 0.5, ceilingPasses: 1 }),
    });

    fake.clearLog();
    pipeline.render(frame());
    const draws = fake.draws();

    expect(draws[1]?.uniforms['uResolution']).toEqual(vec2(360, 640));
    expect(draws[1]?.width).toBe(360);
    expect(draws[2]?.uniforms['uResolution']).toEqual(vec2(720, 1280));
    expect(draws[2]?.width).toBe(720);
  });

  it('sends the reactivity block and the pass parameters to every stage', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: {
        ...preset(['feedback']),
        chain: [{ pass: 'feedback', params: { zoom: 0.05, decay: 0.7 } }],
      },
      outputSize: PANEL,
      catalogue,
    });

    fake.clearLog();
    pipeline.render(
      frame({
        reactivity: { timeSeconds: 3, beat: 1, phase: 0.5, energy: 0.5, bands: [0.25] },
      }),
    );
    const pass = fake.draws()[1];

    expect(pass?.uniforms['uBeat']).toEqual(float(1));
    expect(pass?.uniforms['uTime']).toEqual(float(3));
    expect(pass?.uniforms['uAccent']).toEqual(vec3([1, 0, 0]));
    expect(pass?.uniforms['uZoom']).toEqual(float(0.05));
    expect(pass?.uniforms['uDecay']).toEqual(float(0.7));
    expect(pass?.uniforms['uBands']).toEqual(
      floats([0.25, ...(Array<number>(15).fill(0) as readonly number[])]),
    );
    expect(pass?.uniforms['uTexture']).toEqual(sampler(UNIT_TEXTURE));
  });

  // Depth belongs to the scene stage and nothing after it: the chain is flat
  // compositing, and the tunnel deliberately runs without a z-buffer.
  it('takes the depth test from the scene and turns it off for the chain', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain'], 'tube'),
      outputSize: PANEL,
      catalogue,
    });

    fake.clearLog();
    pipeline.render(frame());
    const draws = fake.draws();

    expect(draws[0]?.depthTest).toBe(true);
    expect(draws[1]?.depthTest).toBe(false);
    expect(draws[2]?.depthTest).toBe(false);
  });

  it('draws an overlay over the finished frame, blended, at panel size', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain', 'bars']),
      outputSize: PANEL,
      catalogue,
    });

    const bars = programFor(fake, BARS_PASS.fragment);
    fake.clearLog();
    pipeline.render(frame());
    const draws = fake.draws();
    const overlay = draws[draws.length - 1];

    expect(overlay?.program).toBe(bars);
    expect(overlay?.framebuffer).toBe('screen');
    expect(overlay?.blend).toBe('alpha');
    expect(overlay?.width).toBe(720);
    // It composites over what is already there; it does not filter it.
    expect(overlay?.samplers[UNIT_TEXTURE]).not.toBe(draws[1]?.attachment);
  });

  it('presents without blending, so the frame replaces what was on screen', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain', 'bars']),
      outputSize: PANEL,
      catalogue,
    });

    fake.clearLog();
    pipeline.render(frame());

    expect(fake.draws()[2]?.blend).toBe('none');
  });

  it('draws only the upscale when the preset names a scene we do not have', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset([], 'reef'),
      outputSize: PANEL,
      catalogue,
    });

    fake.clearLog();
    pipeline.render(frame());

    expect(fake.draws()).toHaveLength(1);
    expect(fake.draws()[0]?.framebuffer).toBe('screen');
  });
});

describe('the album cover', () => {
  let fake: FakeGl;

  beforeEach(() => {
    fake = createFakeGl();
  });

  const image = {} as unknown as TexImageSource;

  it('uploads the cover once and binds it to the art unit', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
    });

    pipeline.setArt(image);
    pipeline.setArt(image);
    pipeline.render(frame());
    pipeline.render(frame());

    // Once per set, never per frame: the cover changes on a track boundary,
    // and a per-frame upload would be a full texture transfer at 60Hz.
    expect(callsOf(fake, 'uploadImage')).toHaveLength(2);
    const art = fake.draws()[0]?.samplers[UNIT_ART];
    expect(art).toBeDefined();
    expect(art).not.toBe(fake.draws()[0]?.attachment);
  });

  /**
   * A track with no cover clears to the flat surface rather than keeping the
   * last album on screen (D-045) — and a shader sampling a texture that was
   * never given one is undefined, where a black 1x1 is merely dull.
   */
  it('falls back to a defined blank rather than a stale cover', () => {
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
    });

    pipeline.setArt(image);
    pipeline.render(frame());
    const withArt = fake.draws()[0]?.samplers[UNIT_ART];

    pipeline.setArt(null);
    fake.clearLog();
    pipeline.render(frame());

    expect(fake.draws()[0]?.samplers[UNIT_ART]).not.toBe(withArt);
  });
});

describe('the engine reacting to a slow Pi', () => {
  let fake: FakeGl;

  beforeEach(() => {
    fake = createFakeGl();
  });

  const struggling = () =>
    createPipeline(fake.gl, {
      preset: preset(['feedback', 'grain']),
      outputSize: PANEL,
      catalogue,
      degrader: createDegrader({
        ceilingScale: 1,
        ceilingPasses: 2,
        windowFrames: 2,
      }),
    });

  it('drops the scale before it drops a pass', () => {
    const pipeline = struggling();

    const before = pipeline.render(frame({ elapsedMs: 100 }));
    const after = pipeline.render(frame({ elapsedMs: 100 }));

    expect(before.renderSize).toEqual(PANEL);
    expect(after.renderSize).toEqual({ width: 540, height: 960 });
    expect(after.chain).toHaveLength(2);
  });

  it('drops passes once the scale has nowhere left to go, keeping the scene', () => {
    const pipeline = struggling();

    let last = pipeline.render(frame({ elapsedMs: 100 }));
    for (let index = 0; index < 20; index += 1) {
      last = pipeline.render(frame({ elapsedMs: 100 }));
    }

    expect(last.renderSize).toEqual({ width: 180, height: 320 });
    expect(last.chain).toEqual([]);
    expect(last.dropped).toBe(2);
    expect(fake.draws()[fake.draws().length - 2]?.program).toBe(
      programFor(fake, FLAT_SCENE.fragment),
    );
  });

  /**
   * Reallocating would churn three textures and three framebuffers every time
   * the degrader moves — and the driver would be freeing memory in the middle
   * of the frame that made it move.
   */
  it('resizes the targets in place rather than reallocating them', () => {
    const pipeline = struggling();

    pipeline.render(frame({ elapsedMs: 100 }));
    fake.clearLog();
    pipeline.render(frame({ elapsedMs: 100 }));

    expect(callsOf(fake, 'resizeTexture')).toHaveLength(3);
    expect(callsOf(fake, 'createTexture')).toHaveLength(0);
    expect(callsOf(fake, 'createFramebuffer')).toHaveLength(0);
  });

  it('leaves the quality alone when the caller does not report a frame time', () => {
    const pipeline = struggling();

    const first = pipeline.render(frame());
    const second = pipeline.render(frame());

    expect(second.scale).toBe(first.scale);
  });

  it('follows the grain slider down and re-measures from there', () => {
    const pipeline = struggling();

    pipeline.setGrain(0.25);
    const drawn = pipeline.render(frame());

    expect(drawn.renderSize).toEqual({ width: 180, height: 320 });
  });

  it('re-reads the pass budget when the preset changes', () => {
    const pipeline = struggling();

    pipeline.setPreset(preset(['grain']));
    const drawn = pipeline.render(frame());

    expect(drawn.chain.map((step) => step.pass)).toEqual(['grain']);
  });

  it('draws to the new panel size when the surface is resized', () => {
    const pipeline = struggling();

    pipeline.setOutputSize({ width: 400, height: 400 });
    const drawn = pipeline.render(frame());

    expect(drawn.outputSize).toEqual({ width: 400, height: 400 });
    expect(drawn.renderSize).toEqual({ width: 400, height: 400 });
  });
});

describe('resources', () => {
  it('compiles the whole catalogue up front, not mid-track', () => {
    const fake = createFakeGl();

    createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
    });

    // Two scenes, three passes, and the upscale.
    expect(callsOf(fake, 'createProgram')).toHaveLength(6);
    // The flat scene and every post pass share the fullscreen triangle, so
    // there are two meshes: that one and the tube's.
    expect(callsOf(fake, 'createGeometry')).toHaveLength(2);
    expect(callsOf(fake, 'createFramebuffer')).toHaveLength(3);
  });

  it('gives every render target the same size and nearest filtering', () => {
    const fake = createFakeGl();

    createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
    });

    const targets = callsOf(fake, 'createTexture').filter((call) => call.width > 1);
    expect(targets).toHaveLength(3);
    for (const target of targets) {
      expect(target.width).toBe(360);
      expect(target.height).toBe(640);
      // Bilinear would sand off the chunk we are rendering small to get.
      expect(target.filter).toBe('nearest');
    }
  });

  /**
   * The default path App.svelte will take: no catalogue and no degrader means
   * an engine with nothing to draw but the upscale, which must still be a
   * frame rather than an exception.
   */
  it('renders with nothing configured but a preset and a size', () => {
    const fake = createFakeGl();
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
    });

    const drawn = pipeline.render(frame({ elapsedMs: 16 }));

    expect(drawn.chain).toEqual([]);
    expect(drawn.renderSize).toEqual({ width: 360, height: 640 });
    expect(fake.draws()).toHaveLength(1);
  });

  it('gives back everything it took', () => {
    const fake = createFakeGl();
    const pipeline = createPipeline(fake.gl, {
      preset: preset(['grain']),
      outputSize: PANEL,
      catalogue,
    });

    pipeline.render(frame());
    pipeline.dispose();

    for (const kind of ['program', 'texture', 'framebuffer', 'geometry']) {
      expect(fake.live(kind)).toEqual([]);
    }
  });
});

/**
 * The GL seam itself.
 *
 * `gl-context.ts` has no test file of its own in this task's file budget, and
 * it is the one module that cannot be exercised by the fake — so it is
 * exercised here, against a stub `WebGL2RenderingContext` that records the raw
 * calls. What is being checked is only the translation: that binding a
 * framebuffer of `null` reaches the driver as `null`, that a `vec3` uniform
 * goes out as `uniform3f`, that a failed compile throws with the driver's log
 * rather than linking a broken program. Everything above that line is the
 * fake's job.
 */
interface StubCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface StubOptions {
  readonly compiles?: boolean;
  readonly links?: boolean;
  readonly hasLocation?: boolean;
  readonly allocates?: boolean;
  readonly logs?: boolean;
}

const stubWebGl = (options: StubOptions = {}) => {
  const calls: StubCall[] = [];
  const constants = [
    'VERTEX_SHADER',
    'FRAGMENT_SHADER',
    'COMPILE_STATUS',
    'LINK_STATUS',
    'TEXTURE_2D',
    'RGBA',
    'UNSIGNED_BYTE',
    'TEXTURE_MIN_FILTER',
    'TEXTURE_MAG_FILTER',
    'TEXTURE_WRAP_S',
    'TEXTURE_WRAP_T',
    'NEAREST',
    'LINEAR',
    'REPEAT',
    'CLAMP_TO_EDGE',
    'FRAMEBUFFER',
    'COLOR_ATTACHMENT0',
    'ARRAY_BUFFER',
    'ELEMENT_ARRAY_BUFFER',
    'STATIC_DRAW',
    'FLOAT',
    'TRIANGLES',
    'UNSIGNED_SHORT',
    'DEPTH_TEST',
    'BLEND',
    'SRC_ALPHA',
    'ONE_MINUS_SRC_ALPHA',
    'TEXTURE0',
    'COLOR_BUFFER_BIT',
    'DEPTH_BUFFER_BIT',
    'UNPACK_FLIP_Y_WEBGL',
  ];
  const context: Record<string, unknown> = {};
  for (const [index, name] of constants.entries()) context[name] = index + 1;

  const record =
    (name: string, result?: unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ name, args });
      return result;
    };

  for (const name of [
    'shaderSource',
    'compileShader',
    'attachShader',
    'linkProgram',
    'deleteShader',
    'deleteProgram',
    'deleteTexture',
    'deleteBuffer',
    'deleteVertexArray',
    'deleteFramebuffer',
    'bindVertexArray',
    'bindBuffer',
    'bufferData',
    'enableVertexAttribArray',
    'vertexAttribPointer',
    'bindTexture',
    'activeTexture',
    'texImage2D',
    'texParameteri',
    'pixelStorei',
    'bindFramebuffer',
    'framebufferTexture2D',
    'viewport',
    'clearColor',
    'clear',
    'useProgram',
    'uniform1f',
    'uniform2f',
    'uniform3f',
    'uniform1fv',
    'uniform1i',
    'enable',
    'disable',
    'blendFunc',
    'drawArrays',
    'drawElements',
  ]) {
    context[name] = record(name);
  }
  context['createShader'] = record(
    'createShader',
    options.allocates === false ? null : { shader: true },
  );
  context['createProgram'] = record('createProgram', { program: true });
  context['createTexture'] = record('createTexture', { texture: true });
  context['createFramebuffer'] = record('createFramebuffer', { framebuffer: true });
  context['createBuffer'] = record('createBuffer', { buffer: true });
  context['createVertexArray'] = record('createVertexArray', { vao: true });
  context['getShaderParameter'] = record(
    'getShaderParameter',
    options.compiles !== false,
  );
  context['getProgramParameter'] = record('getProgramParameter', options.links !== false);
  context['getShaderInfoLog'] = record(
    'getShaderInfoLog',
    options.logs === false ? null : 'syntax error line 4',
  );
  context['getProgramInfoLog'] = record(
    'getProgramInfoLog',
    options.logs === false ? null : 'no matching varying',
  );
  context['getUniformLocation'] = record(
    'getUniformLocation',
    options.hasLocation === false ? null : { location: true },
  );

  return {
    calls,
    context: context as unknown as WebGL2RenderingContext,
    names: (): readonly string[] => calls.map((call) => call.name),
    argsOf: (name: string): readonly unknown[][] =>
      calls.filter((call) => call.name === name).map((call) => [...call.args]),
  };
};

const SOURCE = { vertex: '#version 300 es\n', fragment: '#version 300 es\n' };

describe('the GL seam', () => {
  it('compiles both stages and links them into one program', () => {
    const stub = stubWebGl();

    createGlContext(stub.context).createProgram(SOURCE);

    expect(stub.names()).toEqual([
      'createShader',
      'shaderSource',
      'compileShader',
      'getShaderParameter',
      'createShader',
      'shaderSource',
      'compileShader',
      'getShaderParameter',
      'createProgram',
      'attachShader',
      'attachShader',
      'linkProgram',
      // Attached shaders are reference-counted by the program, so they go as
      // soon as the link is done.
      'deleteShader',
      'deleteShader',
      'getProgramParameter',
    ]);
  });

  /**
   * A shader that will not compile is our bug, not a runtime condition, so it
   * throws — carrying the driver's log, because Mesa V3D's message is the only
   * useful thing to have when something builds on a laptop and not on the Pi.
   */
  it('throws with the driver’s log rather than linking a broken shader', () => {
    const stub = stubWebGl({ compiles: false });

    expect(() => createGlContext(stub.context).createProgram(SOURCE)).toThrow(
      GlProgramError,
    );
    expect(() => createGlContext(stub.context).createProgram(SOURCE)).toThrow(
      'syntax error line 4',
    );
    expect(stub.names()).not.toContain('linkProgram');
  });

  it('throws and frees the program when the link fails', () => {
    const stub = stubWebGl({ links: false });

    expect(() => createGlContext(stub.context).createProgram(SOURCE)).toThrow(
      'no matching varying',
    );
    expect(stub.names()).toContain('deleteProgram');
  });

  it('allocates a render target with no pixels and the filtering it asked for', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);

    gl.createTexture({ width: 360, height: 640, filter: 'nearest', wrap: 'repeat' });

    const [upload] = stub.argsOf('texImage2D');
    expect(upload?.[3]).toBe(360);
    expect(upload?.[4]).toBe(640);
    expect(upload?.[8]).toBeNull();
    expect(stub.argsOf('texParameteri')).toHaveLength(4);
  });

  it('resizes a target by reallocating its storage, keeping the handle', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 4,
      height: 4,
      filter: 'linear',
      wrap: 'clamp',
    });

    gl.resizeTexture(texture, 8, 16);

    expect(stub.argsOf('texImage2D')[1]?.[3]).toBe(8);
    expect(stub.names()).not.toContain('deleteTexture');
  });

  it('attaches a texture to a framebuffer and leaves the screen bound', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 4,
      height: 4,
      filter: 'nearest',
      wrap: 'clamp',
    });

    gl.createFramebuffer(texture);

    expect(stub.names()).toContain('framebufferTexture2D');
    expect(stub.argsOf('bindFramebuffer')[1]?.[1]).toBeNull();
  });

  it('binds the screen when asked for no framebuffer, and a target when given one', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 4,
      height: 4,
      filter: 'nearest',
      wrap: 'clamp',
    });
    const target = gl.createFramebuffer(texture);

    gl.bindFramebuffer(null);
    gl.bindFramebuffer(target);

    const binds = stub.argsOf('bindFramebuffer');
    expect(binds[binds.length - 2]?.[1]).toBeNull();
    expect(binds[binds.length - 1]?.[1]).toBe(target);
  });

  /**
   * A driver that hands back no object, or no log to explain itself, is a
   * context that has been lost or is out of memory — rare, and worth failing
   * clearly rather than dereferencing null three calls later.
   */
  it('fails clearly when the driver gives back nothing to work with', () => {
    expect(() =>
      createGlContext(stubWebGl({ allocates: false }).context).createProgram(SOURCE),
    ).toThrow('no shader object');
    expect(() =>
      createGlContext(stubWebGl({ compiles: false, logs: false }).context).createProgram(
        SOURCE,
      ),
    ).toThrow(GlProgramError);
    expect(() =>
      createGlContext(stubWebGl({ links: false, logs: false }).context).createProgram(
        SOURCE,
      ),
    ).toThrow(GlProgramError);
  });

  it('sends each uniform type through its own call', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const program = gl.createProgram(SOURCE);

    gl.setUniform(program, 'uTime', float(2));
    gl.setUniform(program, 'uResolution', vec2(360, 640));
    gl.setUniform(program, 'uAccent', vec3([1, 0, 0]));
    gl.setUniform(program, 'uBands', floats([0.5]));
    gl.setUniform(program, 'uArt', sampler(1));

    expect(stub.names()).toContain('uniform1f');
    expect(stub.names()).toContain('uniform2f');
    expect(stub.names()).toContain('uniform3f');
    expect(stub.names()).toContain('uniform1fv');
    expect(stub.names()).toContain('uniform1i');
  });

  /**
   * A uniform lookup is a string lookup, and the answer never changes for the
   * life of a program. Doing it per uniform per pass per frame is measurable
   * on a Pi, so it happens once.
   */
  it('looks a uniform location up once, not once a frame', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const program = gl.createProgram(SOURCE);

    for (let index = 0; index < 10; index += 1) {
      gl.setUniform(program, 'uTime', float(index));
    }

    expect(stub.argsOf('getUniformLocation')).toHaveLength(1);
    expect(stub.argsOf('uniform1f')).toHaveLength(10);
  });

  // Every shader declares only the uniforms it uses, and the compiler drops
  // the ones it never reads — so a missing location is normal, not an error.
  it('skips a uniform the shader does not have', () => {
    const stub = stubWebGl({ hasLocation: false });
    const gl = createGlContext(stub.context);
    const program = gl.createProgram(SOURCE);

    gl.setUniform(program, 'uWobble', float(1));

    expect(stub.names()).not.toContain('uniform1f');
  });

  it('uploads a cover into an existing texture', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 1,
      height: 1,
      filter: 'linear',
      wrap: 'clamp',
    });

    gl.uploadImage(texture, {} as unknown as TexImageSource);

    expect(stub.argsOf('texImage2D')).toHaveLength(2);
  });

  /**
   * An image's first row is its top; a texture's first row is its bottom.
   * Without the flip every album cover renders upside down — which no headless
   * test can see, because nothing in one has an up. Found by looking at the
   * page.
   */
  it('flips the cover, and puts the flag back afterwards', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 1,
      height: 1,
      filter: 'nearest',
      wrap: 'repeat',
    });

    gl.uploadImage(texture, {} as unknown as TexImageSource);

    const flips = stub.argsOf('pixelStorei').map((args) => args[1]);
    expect(flips).toEqual([true, false]);
  });

  it('draws indexed geometry with drawElements and a plain mesh with drawArrays', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const quad = gl.createGeometry({
      attributes: [{ location: 0, size: 2, data: new Float32Array([0, 0]) }],
      count: 3,
    });
    const mesh = gl.createGeometry({
      attributes: [{ location: 0, size: 3, data: new Float32Array([0, 0, 0]) }],
      indices: new Uint16Array([0, 1, 2]),
      count: 3,
    });

    gl.draw(quad);
    gl.draw(mesh);

    expect(stub.argsOf('drawArrays')).toHaveLength(1);
    expect(stub.argsOf('drawElements')).toHaveLength(1);
  });

  it('frees a mesh’s buffers as well as its vertex array', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const mesh = gl.createGeometry({
      attributes: [{ location: 0, size: 3, data: new Float32Array([0, 0, 0]) }],
      indices: new Uint16Array([0, 1, 2]),
      count: 3,
    });

    gl.deleteGeometry(mesh);

    expect(stub.argsOf('deleteBuffer')).toHaveLength(2);
    expect(stub.argsOf('deleteVertexArray')).toHaveLength(1);
  });

  it('forwards the rest of the frame state it is asked for', () => {
    const stub = stubWebGl();
    const gl = createGlContext(stub.context);
    const texture = gl.createTexture({
      width: 1,
      height: 1,
      filter: 'nearest',
      wrap: 'clamp',
    });
    const program = gl.createProgram(SOURCE);

    gl.viewport(360, 640);
    gl.clear([0, 0, 0, 1]);
    gl.useProgram(program);
    gl.bindTexture(2, texture);
    gl.setDepthTest(true);
    gl.setDepthTest(false);
    gl.setBlend('alpha');
    gl.setBlend('none');
    gl.deleteProgram(program);
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(gl.createFramebuffer(texture));

    expect(stub.argsOf('viewport')[0]).toEqual([0, 0, 360, 640]);
    expect(stub.argsOf('clearColor')[0]).toEqual([0, 0, 0, 1]);
    // Unit 2 is `uPrev`; the seam is where a unit number becomes an enum.
    const textureZero = (stub.context as unknown as Record<string, number>)['TEXTURE0'];
    expect(stub.argsOf('activeTexture')[0]?.[0]).toBe((textureZero ?? 0) + 2);
    expect(stub.argsOf('enable')).toHaveLength(2);
    expect(stub.argsOf('disable')).toHaveLength(2);
    expect(stub.argsOf('blendFunc')).toHaveLength(1);
    expect(stub.names()).toContain('deleteFramebuffer');
  });
});
