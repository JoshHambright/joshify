/**
 * The render pipeline: a scene, a ping-pong post chain, an upscale, overlays.
 *
 * ```
 *   scene ──► [ A ] ──► pass ──► [ B ] ──► pass ──► [ A ] ──► present ──► screen
 *                                                                   └─► overlays
 *   [ C ] ─────────────────────── uPrev (last frame's result) ───────────┘
 * ```
 *
 * Two things are worth reading twice.
 *
 * **The plan is separate from the drawing.** `planFrame` is a pure function
 * from (preset, catalogue, size, quality) to a list of steps with their source
 * and target framebuffers. Everything that can be wrong about this engine —
 * which pass runs, what it reads, what it writes, what got dropped — is wrong
 * in that value, in plain Node, with no GPU (D-043). `render` then executes it
 * through the narrow `GlContext`, and the recording fake proves the calls came
 * out in the right order.
 *
 * **Three targets, not two.** A pass may not sample the texture it is drawing
 * into: in GLES that is undefined behaviour, and in practice it is the classic
 * feedback-loop bug that shows up as a torn or black frame on one driver and
 * looks fine on another. Two targets are enough to ping-pong a chain, but not
 * enough to also keep *last frame's* result alive for `uPrev` — the scene
 * would overwrite it before the feedback pass read it. So there are three: one
 * holds the previous frame and is untouchable this frame, the other two
 * alternate. The invariant the tests assert is exactly that: no draw ever
 * samples the texture attached to the framebuffer it is bound to.
 */
import {
  buildFrameUniforms,
  paramUniforms,
  UNIT_ART,
  UNIT_PREV,
  UNIT_TEXTURE,
  type Reactivity,
  type ShaderRgb,
  type Size,
  type UniformSet,
} from './uniforms.js';
import {
  createDegrader,
  renderSizeFor,
  type Degrader,
  type QualityLevel,
} from './budget.js';
import {
  findPass,
  findScene,
  FULLSCREEN_TRIANGLE,
  POST_VERTEX,
  type Catalogue,
  type Preset,
} from './passes.js';
import type {
  FramebufferHandle,
  GeometryHandle,
  GeometrySpec,
  GlContext,
  ProgramHandle,
  TextureHandle,
} from './gl-context.js';

export type TargetId = 'a' | 'b' | 'c';

export const TARGET_IDS: readonly TargetId[] = ['a', 'b', 'c'];

export interface SceneStep {
  readonly scene: string;
  readonly params: Readonly<Record<string, number>>;
  readonly target: TargetId;
}

export interface PassStep {
  readonly pass: string;
  readonly params: Readonly<Record<string, number>>;
  readonly source: TargetId;
  readonly target: TargetId;
}

export interface OverlayStep {
  readonly pass: string;
  readonly params: Readonly<Record<string, number>>;
}

export interface RenderPlan {
  readonly outputSize: Size;
  /** What the scene and the chain draw at — `outputSize * scale`. */
  readonly renderSize: Size;
  readonly scale: number;
  /** The target holding last frame's result; read as `uPrev`, never written. */
  readonly feedback: TargetId;
  readonly scene: SceneStep;
  readonly chain: readonly PassStep[];
  /** The upscale. Its source becomes next frame's `feedback`. */
  readonly present: { readonly source: TargetId };
  readonly overlays: readonly OverlayStep[];
  /** How many passes the frame budget removed. Zero when all is well. */
  readonly dropped: number;
}

export interface PlanInput {
  readonly preset: Preset;
  readonly catalogue: Catalogue;
  readonly outputSize: Size;
  readonly quality: QualityLevel;
  /** Last frame's `present.source`, or null on the first frame. */
  readonly previousFinal: TargetId | null;
}

interface ChainEntry {
  readonly pass: string;
  readonly params: Readonly<Record<string, number>>;
}

/**
 * Which passes survive the budget.
 *
 * Dropped from the end, because a chain is written as a sequence of finishing
 * moves and the last one is the most disposable. Overlays go last of all: the
 * spectrum bars are a few dozen triangles over a frame that is already drawn,
 * so dropping them saves nothing worth the hole it leaves (P5-09 — the bars
 * are non-negotiable).
 */
const withinBudget = (
  preset: Preset,
  catalogue: Catalogue,
  maxPasses: number,
): {
  scaled: readonly ChainEntry[];
  overlays: readonly ChainEntry[];
  dropped: number;
} => {
  const scaled: ChainEntry[] = [];
  const overlays: ChainEntry[] = [];
  for (const entry of preset.chain) {
    const definition = findPass(catalogue, entry.pass);
    // A pass the catalogue lost between parse and render is skipped rather
    // than drawn with nothing: the alternative is a GL error mid-frame.
    if (definition === undefined) continue;
    (definition.overlay === true ? overlays : scaled).push(entry);
  }
  const total = scaled.length + overlays.length;
  const excess = Math.max(0, total - Math.max(0, maxPasses));
  const fromScaled = Math.min(excess, scaled.length);
  return {
    scaled: scaled.slice(0, scaled.length - fromScaled),
    overlays: overlays.slice(0, overlays.length - (excess - fromScaled)),
    dropped: excess,
  };
};

/**
 * The whole frame as data, with no GL in sight.
 *
 * `feedback` is the target that must not be written: last frame's result. The
 * other two ping-pong, starting with the scene. On the first frame there is no
 * previous result, so `c` takes the role — a freshly allocated texture is
 * zero-filled by WebGL, which makes frame one's feedback black rather than
 * whatever was in memory.
 */
export const planFrame = (input: PlanInput): RenderPlan => {
  const { preset, catalogue, outputSize, quality, previousFinal } = input;
  const feedback: TargetId = previousFinal ?? 'c';
  const pair = TARGET_IDS.filter((id) => id !== feedback);
  const first = pair[0] ?? 'a';
  const second = pair[1] ?? 'b';

  const { scaled, overlays, dropped } = withinBudget(
    preset,
    catalogue,
    quality.maxPasses,
  );

  const chain: PassStep[] = scaled.map((entry, index) => ({
    pass: entry.pass,
    params: entry.params,
    source: index % 2 === 0 ? first : second,
    target: index % 2 === 0 ? second : first,
  }));

  const last = chain[chain.length - 1];
  return {
    outputSize,
    renderSize: renderSizeFor(outputSize, quality.scale),
    scale: quality.scale,
    feedback,
    scene: { scene: preset.scene, params: preset.sceneParams, target: first },
    chain,
    present: { source: last === undefined ? first : last.target },
    overlays: overlays.map((entry) => ({ pass: entry.pass, params: entry.params })),
    dropped,
  };
};

export interface RenderInputs {
  readonly reactivity: Reactivity;
  /** The tempo, when one is known. Drives the flash floor (D-071). */
  readonly bpm?: number | null | undefined;
  readonly accent: ShaderRgb;
  readonly foreground: ShaderRgb;
  readonly intensity: number;
  /**
   * Milliseconds since the previous frame began. Omit and the budget observes
   * nothing — useful for a headless test that is asserting about draws rather
   * than about degradation.
   */
  readonly elapsedMs?: number | undefined;
}

export interface Pipeline {
  render(inputs: RenderInputs): RenderPlan;
  setPreset(preset: Preset): void;
  /** `null` clears to the flat surface rather than keeping a stale cover. */
  setArt(source: TexImageSource | null): void;
  setOutputSize(size: Size): void;
  /** The grain slider (P5-13). A ceiling, never a floor. */
  setGrain(scale: number): void;
  dispose(): void;
}

export interface PipelineOptions {
  readonly preset: Preset;
  readonly outputSize: Size;
  readonly catalogue?: Catalogue | undefined;
  readonly degrader?: Degrader | undefined;
}

/** The upscale, and the only place the half-resolution frame becomes pixels. */
const PRESENT_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 fragColour;
void main() {
  fragColour = vec4(texture(uTexture, vUv).rgb, 1.0);
}
`;

interface Target {
  readonly texture: TextureHandle;
  readonly framebuffer: FramebufferHandle;
}

export const createPipeline = (gl: GlContext, options: PipelineOptions): Pipeline => {
  const catalogue = options.catalogue ?? { scenes: [], passes: [] };
  const degrader =
    options.degrader ?? createDegrader({ ceilingPasses: options.preset.chain.length });

  let preset = options.preset;
  let outputSize = options.outputSize;
  let previousFinal: TargetId | null = null;
  let hasArt = false;
  /**
   * The last value handed to `setGrain`, so an unchanged one is a no-op. Null
   * until the first call rather than seeded with the degrader's default: the
   * degrader may have been injected, and guessing its ceiling here would make
   * the first real `setGrain` silently do nothing.
   */
  let grain: number | null = null;

  /**
   * Everything is compiled up front, not on first use. A shader compile on a
   * Pi is tens of milliseconds of stall; paying for the whole catalogue during
   * startup — where a beat of delay is invisible — is better than paying for
   * one pass in the middle of a track. It also means a shader that will not
   * build fails where somebody is looking.
   */
  const programs = new Map<string, ProgramHandle>();
  for (const scene of catalogue.scenes) {
    programs.set(`scene:${scene.id}`, gl.createProgram(scene));
  }
  for (const pass of catalogue.passes) {
    programs.set(
      `pass:${pass.id}`,
      gl.createProgram({ vertex: POST_VERTEX, fragment: pass.fragment }),
    );
  }
  const presentProgram = gl.createProgram({
    vertex: POST_VERTEX,
    fragment: PRESENT_FRAGMENT,
  });

  // Scenes that share a mesh — every 2D scene shares the fullscreen triangle —
  // share one VAO rather than uploading the same three vertices per scene.
  const meshes = new Map<GeometrySpec, GeometryHandle>();
  const meshFor = (spec: GeometrySpec): GeometryHandle => {
    const existing = meshes.get(spec);
    if (existing !== undefined) return existing;
    const created = gl.createGeometry(spec);
    meshes.set(spec, created);
    return created;
  };
  const quad = meshFor(FULLSCREEN_TRIANGLE);
  for (const scene of catalogue.scenes) meshFor(scene.geometry);

  /** Sampled wherever a real texture is missing. Black, and 1x1, and defined. */
  const blank = gl.createTexture({
    width: 1,
    height: 1,
    filter: 'nearest',
    wrap: 'clamp',
  });
  /**
   * The album cover, as the tunnel wants it (P5-25).
   *
   * `nearest` because the chunky filtering *is* the look — a bilinear stretch
   * of a 256px cover across a tunnel wall sands off exactly the texel grid
   * the PS1 idiom is made of. `repeat` because the tunnel tiles the cover
   * around and along itself; with `clamp` the wrap smears one edge texel down
   * the whole tube.
   *
   * The tunnel's fragment shader tiles with `fract()` and so is correct under
   * either setting. That is deliberate belt-and-braces, not a reason to leave
   * the sampler wrong: it means the shader survives a texture created
   * elsewhere, while this makes the `fract` redundant rather than load-bearing.
   */
  const art = gl.createTexture({
    width: 1,
    height: 1,
    filter: 'nearest',
    wrap: 'repeat',
  });

  let targetSize = renderSizeFor(outputSize, degrader.quality.scale);
  const makeTarget = (): Target => {
    // NEAREST, because the upscale back to the panel is the aesthetic: a
    // bilinear stretch would sand off the chunk we are rendering small for.
    const texture = gl.createTexture({
      width: targetSize.width,
      height: targetSize.height,
      filter: 'nearest',
      wrap: 'clamp',
    });
    return { texture, framebuffer: gl.createFramebuffer(texture) };
  };
  // A record rather than a map, so a target id is a fact the compiler knows
  // rather than a lookup that might miss.
  const targets: Record<TargetId, Target> = {
    a: makeTarget(),
    b: makeTarget(),
    c: makeTarget(),
  };

  const targetFor = (id: TargetId): Target => targets[id];

  const resizeTargets = (size: Size): void => {
    if (size.width === targetSize.width && size.height === targetSize.height) return;
    targetSize = size;
    // Resized in place. Reallocating would churn three textures and three
    // framebuffers every time the degrader moves, and the driver would be
    // freeing memory in the middle of the frame that made it move.
    for (const id of TARGET_IDS) {
      gl.resizeTexture(targetFor(id).texture, size.width, size.height);
    }
  };

  const apply = (program: ProgramHandle, uniforms: UniformSet): void => {
    for (const [name, value] of Object.entries(uniforms)) {
      gl.setUniform(program, name, value);
    }
  };

  /** Whichever target holds last frame's result. Never written this frame. */
  let feedback: TargetId = 'c';

  // All three units, every draw. A shader binds what it declares and ignores
  // the rest, and one `activeTexture` is cheaper than tracking who wanted what.
  const bindInputs = (source: TextureHandle | null): void => {
    gl.bindTexture(UNIT_TEXTURE, source ?? blank);
    gl.bindTexture(UNIT_ART, hasArt ? art : blank);
    gl.bindTexture(UNIT_PREV, targetFor(feedback).texture);
  };

  const render = (inputs: RenderInputs): RenderPlan => {
    const quality =
      inputs.elapsedMs === undefined
        ? degrader.quality
        : degrader.observe(inputs.elapsedMs);
    const plan = planFrame({ preset, catalogue, outputSize, quality, previousFinal });
    feedback = plan.feedback;
    resizeTargets(plan.renderSize);

    const context = {
      reactivity: inputs.reactivity,
      accent: inputs.accent,
      foreground: inputs.foreground,
      intensity: inputs.intensity,
    };
    const scaledUniforms = buildFrameUniforms({
      ...context,
      resolution: plan.renderSize,
    });
    const outputUniforms = buildFrameUniforms({
      ...context,
      resolution: plan.outputSize,
    });

    const scene = findScene(catalogue, plan.scene.scene);
    const sceneProgram = programs.get(`scene:${plan.scene.scene}`);
    if (scene !== undefined && sceneProgram !== undefined) {
      gl.bindFramebuffer(targetFor(plan.scene.target).framebuffer);
      gl.viewport(plan.renderSize.width, plan.renderSize.height);
      // Off here, and off for every draw after it. The engine has no depth
      // buffer to test against: `createFramebuffer` attaches colour only, so
      // enabling the test would be a no-op that always passes rather than a
      // z-buffer. Scenes sort themselves (D-074).
      gl.setDepthTest(false);
      gl.setBlend('none');
      // Only the scene clears: every post pass covers its whole target, so a
      // clear before one is a full-screen write nobody reads.
      gl.clear([0, 0, 0, 1]);
      gl.useProgram(sceneProgram);
      bindInputs(null);
      apply(sceneProgram, { ...scaledUniforms, ...paramUniforms(plan.scene.params) });
      gl.draw(meshFor(scene.geometry));
    }

    for (const step of plan.chain) {
      const program = programs.get(`pass:${step.pass}`);
      if (program === undefined) continue;
      gl.bindFramebuffer(targetFor(step.target).framebuffer);
      gl.viewport(plan.renderSize.width, plan.renderSize.height);
      // The chain is flat compositing whatever the scene drew (D-014).
      gl.setDepthTest(false);
      gl.useProgram(program);
      bindInputs(targetFor(step.source).texture);
      apply(program, { ...scaledUniforms, ...paramUniforms(step.params) });
      gl.draw(quad);
    }

    gl.bindFramebuffer(null);
    gl.viewport(plan.outputSize.width, plan.outputSize.height);
    gl.setDepthTest(false);
    gl.setBlend('none');
    gl.useProgram(presentProgram);
    bindInputs(targetFor(plan.present.source).texture);
    apply(presentProgram, outputUniforms);
    gl.draw(quad);

    for (const step of plan.overlays) {
      const program = programs.get(`pass:${step.pass}`);
      if (program === undefined) continue;
      // Overlays composite over a finished frame, so they blend and they get
      // no `uTexture` — they draw on top of the screen, they do not filter it.
      gl.setBlend('alpha');
      gl.useProgram(program);
      bindInputs(null);
      apply(program, { ...outputUniforms, ...paramUniforms(step.params) });
      gl.draw(quad);
    }

    previousFinal = plan.present.source;
    return plan;
  };

  return {
    render,
    /*
     * Both setters no-op when nothing changed, and that is load-bearing rather
     * than an optimisation.
     *
     * `setChain` and `setCeiling` both reset the degrader — deliberately, so
     * that one bad second cannot walk the ladder to the floor before the new
     * configuration has been measured (P5-14). But a caller holding "the
     * current look" and pushing it every frame is the natural shape for a
     * render loop, and doing that cleared the 45-frame window on every frame:
     * it could never fill, so auto-degrade could never fire. The feature was
     * present, tested in isolation, and unreachable from a real loop.
     *
     * Identity, not id: presets are immutable data, so the same object is the
     * same preset, and a rebuilt one with the same id genuinely is a change.
     */
    setPreset: (next) => {
      if (next === preset) return;
      preset = next;
      degrader.setChain(next.chain.length);
    },
    setArt: (source) => {
      hasArt = source !== null;
      if (source !== null) gl.uploadImage(art, source);
    },
    setOutputSize: (size) => {
      outputSize = size;
    },
    setGrain: (scale) => {
      if (scale === grain) return;
      grain = scale;
      degrader.setCeiling(scale);
    },
    dispose: () => {
      for (const program of programs.values()) gl.deleteProgram(program);
      gl.deleteProgram(presentProgram);
      for (const mesh of meshes.values()) gl.deleteGeometry(mesh);
      for (const id of TARGET_IDS) {
        const target = targetFor(id);
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      gl.deleteTexture(art);
      gl.deleteTexture(blank);
    },
  };
};
