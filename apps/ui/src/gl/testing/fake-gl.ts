/**
 * A `GlContext` that draws nothing and remembers everything.
 *
 * The engine's correctness is a claim about *calls in an order* — this pass
 * wrote that framebuffer while sampling this other texture — and that claim is
 * checkable without a GPU. So the fake records, and the tests assert against
 * the recording. Nothing here simulates GL behaviour: it has no idea what a
 * shader does, and it must not learn, or the tests start proving things about
 * the fake instead of about the pipeline.
 *
 * `draws()` is the one derived view, because replaying bind state by hand in
 * every test is the same twelve lines each time and easy to get subtly wrong.
 */
import type {
  FramebufferHandle,
  GeometryHandle,
  GlContext,
  ProgramHandle,
  TextureHandle,
  UniformValue,
} from '../gl-context.js';

export type GlCall =
  | {
      readonly op: 'createProgram';
      readonly label: string;
      readonly vertex: string;
      readonly fragment: string;
    }
  | { readonly op: 'deleteProgram'; readonly label: string }
  | {
      readonly op: 'createGeometry';
      readonly label: string;
      readonly count: number;
      readonly indexed: boolean;
    }
  | { readonly op: 'deleteGeometry'; readonly label: string }
  | {
      readonly op: 'createTexture';
      readonly label: string;
      readonly width: number;
      readonly height: number;
      readonly filter: string;
      readonly wrap: string;
    }
  | {
      readonly op: 'resizeTexture';
      readonly label: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly op: 'uploadImage'; readonly label: string }
  | { readonly op: 'deleteTexture'; readonly label: string }
  | { readonly op: 'createFramebuffer'; readonly label: string; readonly colour: string }
  | { readonly op: 'deleteFramebuffer'; readonly label: string }
  | { readonly op: 'bindFramebuffer'; readonly label: string }
  | { readonly op: 'viewport'; readonly width: number; readonly height: number }
  | { readonly op: 'clear'; readonly colour: readonly number[] }
  | { readonly op: 'useProgram'; readonly label: string }
  | { readonly op: 'bindTexture'; readonly unit: number; readonly label: string }
  | {
      readonly op: 'setUniform';
      readonly program: string;
      readonly name: string;
      readonly value: UniformValue;
    }
  | { readonly op: 'setDepthTest'; readonly enabled: boolean }
  | { readonly op: 'setBlend'; readonly mode: string }
  | { readonly op: 'draw'; readonly geometry: string };

/** The state a single draw happened under, replayed from the call log. */
export interface DrawRecord {
  readonly framebuffer: string;
  /** The texture that framebuffer writes into; `null` for the screen. */
  readonly attachment: string | null;
  /** Texture unit to texture label, as GL would have it at the draw. */
  readonly samplers: Readonly<Record<number, string>>;
  readonly program: string;
  readonly geometry: string;
  readonly width: number;
  readonly height: number;
  readonly uniforms: Readonly<Record<string, UniformValue>>;
  readonly depthTest: boolean;
  readonly blend: string;
}

export interface FakeGl {
  readonly gl: GlContext;
  readonly calls: readonly GlCall[];
  /** Call names in order — for asserting the shape of a frame at a glance. */
  ops(): readonly string[];
  /** Every draw, with the bind state it happened under. */
  draws(): readonly DrawRecord[];
  /** Forget everything so far, so a test can assert about one frame. */
  clearLog(): void;
  /** The label the fake gave a handle, for readable expectations. */
  labelOf(handle: object): string;
  /** Handles created and not yet deleted, by kind. */
  live(kind: string): readonly string[];
}

interface Labelled {
  readonly label: string;
}

export const createFakeGl = (): FakeGl => {
  const calls: GlCall[] = [];
  const attachments = new Map<string, string>();
  const alive = new Map<string, Set<string>>();
  let nextId = 0;

  // Every handle is the same thing to the fake — a label it can print back in
  // an assertion — so the branded types are only put on at the call site.
  const mint = (kind: string): Labelled => {
    nextId += 1;
    const label = `${kind}#${String(nextId)}`;
    const set = alive.get(kind) ?? new Set<string>();
    set.add(label);
    alive.set(kind, set);
    return { label };
  };

  const labelOf = (handle: object): string => (handle as Labelled).label;

  const bury = (kind: string, label: string): void => {
    alive.get(kind)?.delete(label);
  };

  const gl: GlContext = {
    createProgram: ({ vertex, fragment }) => {
      const handle = mint('program') as ProgramHandle & Labelled;
      calls.push({ op: 'createProgram', label: handle.label, vertex, fragment });
      return handle;
    },
    deleteProgram: (program) => {
      calls.push({ op: 'deleteProgram', label: labelOf(program) });
      bury('program', labelOf(program));
    },
    createGeometry: ({ count, indices }) => {
      const handle = mint('geometry') as GeometryHandle & Labelled;
      calls.push({
        op: 'createGeometry',
        label: handle.label,
        count,
        indexed: indices !== undefined,
      });
      return handle;
    },
    deleteGeometry: (geometry) => {
      calls.push({ op: 'deleteGeometry', label: labelOf(geometry) });
      bury('geometry', labelOf(geometry));
    },
    createTexture: ({ width, height, filter, wrap }) => {
      const handle = mint('texture') as TextureHandle & Labelled;
      calls.push({
        op: 'createTexture',
        label: handle.label,
        width,
        height,
        filter,
        wrap,
      });
      return handle;
    },
    resizeTexture: (texture, width, height) => {
      calls.push({ op: 'resizeTexture', label: labelOf(texture), width, height });
    },
    uploadImage: (texture) => {
      calls.push({ op: 'uploadImage', label: labelOf(texture) });
    },
    deleteTexture: (texture) => {
      calls.push({ op: 'deleteTexture', label: labelOf(texture) });
      bury('texture', labelOf(texture));
    },
    createFramebuffer: (colour) => {
      const handle = mint('framebuffer') as FramebufferHandle & Labelled;
      attachments.set(handle.label, labelOf(colour));
      calls.push({
        op: 'createFramebuffer',
        label: handle.label,
        colour: labelOf(colour),
      });
      return handle;
    },
    deleteFramebuffer: (framebuffer) => {
      calls.push({ op: 'deleteFramebuffer', label: labelOf(framebuffer) });
      bury('framebuffer', labelOf(framebuffer));
    },
    bindFramebuffer: (framebuffer) => {
      calls.push({
        op: 'bindFramebuffer',
        label: framebuffer === null ? 'screen' : labelOf(framebuffer),
      });
    },
    viewport: (width, height) => {
      calls.push({ op: 'viewport', width, height });
    },
    clear: (colour) => {
      calls.push({ op: 'clear', colour });
    },
    useProgram: (program) => {
      calls.push({ op: 'useProgram', label: labelOf(program) });
    },
    bindTexture: (unit, texture) => {
      calls.push({ op: 'bindTexture', unit, label: labelOf(texture) });
    },
    setUniform: (program, name, value) => {
      calls.push({ op: 'setUniform', program: labelOf(program), name, value });
    },
    setDepthTest: (enabled) => {
      calls.push({ op: 'setDepthTest', enabled });
    },
    setBlend: (mode) => {
      calls.push({ op: 'setBlend', mode });
    },
    draw: (geometry) => {
      calls.push({ op: 'draw', geometry: labelOf(geometry) });
    },
  };

  /**
   * Replays the log as GL would: bind state persists across draws, uniforms
   * belong to the draw that followed them. A pipeline that forgets to rebind
   * shows up here as a stale texture rather than as nothing at all, which is
   * exactly the bug worth catching.
   */
  const draws = (): readonly DrawRecord[] => {
    const records: DrawRecord[] = [];
    let framebuffer = 'screen';
    let program = '';
    let geometry = '';
    let width = 0;
    let height = 0;
    let depthTest = false;
    let blend = 'none';
    let samplers: Record<number, string> = {};
    let uniforms: Record<string, UniformValue> = {};
    for (const call of calls) {
      switch (call.op) {
        case 'bindFramebuffer':
          framebuffer = call.label;
          break;
        case 'viewport':
          width = call.width;
          height = call.height;
          break;
        case 'useProgram':
          program = call.label;
          uniforms = {};
          break;
        case 'bindTexture':
          samplers = { ...samplers, [call.unit]: call.label };
          break;
        case 'setUniform':
          uniforms = { ...uniforms, [call.name]: call.value };
          break;
        case 'setDepthTest':
          depthTest = call.enabled;
          break;
        case 'setBlend':
          blend = call.mode;
          break;
        case 'draw':
          geometry = call.geometry;
          records.push({
            framebuffer,
            attachment: attachments.get(framebuffer) ?? null,
            samplers,
            program,
            geometry,
            width,
            height,
            uniforms,
            depthTest,
            blend,
          });
          break;
        default:
          break;
      }
    }
    return records;
  };

  return {
    gl,
    get calls() {
      return calls;
    },
    ops: () => calls.map((call) => call.op),
    draws,
    clearLog: () => {
      calls.length = 0;
    },
    labelOf,
    live: (kind) => [...(alive.get(kind) ?? [])],
  };
};
