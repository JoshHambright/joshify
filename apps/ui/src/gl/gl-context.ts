/**
 * The seam between the visualiser and WebGL.
 *
 * This is the **only** file in `src/gl` allowed to touch a real GL API, and it
 * is deliberately dull: it creates objects, binds them, and draws. Every
 * decision — which pass runs, which framebuffer it writes, what its uniforms
 * are, when to degrade — lives in the pure modules next to it and is asserted
 * in Node against `testing/fake-gl.ts`.
 *
 * **Why the split exists.** CI has no GPU and jsdom has no WebGL at all, so a
 * pipeline written directly against `WebGL2RenderingContext` is a pipeline
 * nobody tests. Narrowing the surface to the dozen-odd operations we actually
 * use makes a recording fake trivial to write and keeps the untested part of
 * the engine down to the mechanical translation below (D-043: the logic is
 * testable without the environment).
 *
 * **Why these operations and not more.** Every entry here is one the pipeline
 * calls. There is no `getParameter`, no state query and no mid-frame readback:
 * on a tile-based GPU like the Pi 5's VideoCore VII a read of GPU state stalls
 * the pipeline, so the engine keeps its state on the CPU side and never asks.
 */

declare const handleKind: unique symbol;

/**
 * An opaque GPU object. The pipeline may hold one and hand it back; it can
 * never reach inside, which is what lets the fake substitute its own.
 */
interface GlHandle<K extends string> {
  readonly [handleKind]: K;
}

export type ProgramHandle = GlHandle<'program'>;
export type TextureHandle = GlHandle<'texture'>;
export type FramebufferHandle = GlHandle<'framebuffer'>;
export type GeometryHandle = GlHandle<'geometry'>;

/**
 * A uniform, tagged with its GLSL type.
 *
 * Tagged rather than inferred from the JavaScript value because `1` is a valid
 * `float` and a valid sampler unit, and picking the wrong `uniform*` call
 * silently draws nothing. It also makes a recorded call log readable.
 */
export type UniformValue =
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'vec2'; readonly value: readonly [number, number] }
  | { readonly kind: 'vec3'; readonly value: readonly [number, number, number] }
  | { readonly kind: 'floats'; readonly value: readonly number[] }
  | { readonly kind: 'sampler'; readonly value: number };

export const float = (value: number): UniformValue => ({ kind: 'float', value });

export const vec2 = (x: number, y: number): UniformValue => ({
  kind: 'vec2',
  value: [x, y],
});

export const vec3 = (value: readonly [number, number, number]): UniformValue => ({
  kind: 'vec3',
  value,
});

export const floats = (value: readonly number[]): UniformValue => ({
  kind: 'floats',
  value,
});

export const sampler = (unit: number): UniformValue => ({ kind: 'sampler', value: unit });

export interface ProgramSource {
  readonly vertex: string;
  readonly fragment: string;
}

export interface TextureSpec {
  readonly width: number;
  readonly height: number;
  /**
   * `nearest` is the default for render targets: the half-resolution upscale
   * is the aesthetic (D-011), and bilinear would smooth away the thing we are
   * paying for.
   */
  readonly filter: 'nearest' | 'linear';
  readonly wrap: 'clamp' | 'repeat';
}

/**
 * One vertex attribute. `location` is the shader's `layout(location = n)`, so
 * geometry is not tied to a program — the same fullscreen triangle feeds every
 * pass in the chain. GLES 3.0 guarantees explicit locations.
 */
export interface AttributeSpec {
  readonly location: number;
  readonly size: number;
  readonly data: Float32Array;
}

export interface GeometrySpec {
  readonly attributes: readonly AttributeSpec[];
  readonly indices?: Uint16Array | undefined;
  /** Vertices to draw, or indices when `indices` is present. */
  readonly count: number;
}

export type BlendMode = 'none' | 'alpha';

/** The narrow WebGL2 surface the visualiser is written against. */
export interface GlContext {
  createProgram(source: ProgramSource): ProgramHandle;
  deleteProgram(program: ProgramHandle): void;
  createGeometry(spec: GeometrySpec): GeometryHandle;
  deleteGeometry(geometry: GeometryHandle): void;
  createTexture(spec: TextureSpec): TextureHandle;
  resizeTexture(texture: TextureHandle, width: number, height: number): void;
  uploadImage(texture: TextureHandle, source: TexImageSource): void;
  deleteTexture(texture: TextureHandle): void;
  createFramebuffer(colour: TextureHandle): FramebufferHandle;
  deleteFramebuffer(framebuffer: FramebufferHandle): void;
  /** `null` is the default framebuffer — the screen. */
  bindFramebuffer(framebuffer: FramebufferHandle | null): void;
  viewport(width: number, height: number): void;
  clear(colour: readonly [number, number, number, number]): void;
  useProgram(program: ProgramHandle): void;
  bindTexture(unit: number, texture: TextureHandle): void;
  /** Applies to the current program; the pipeline always sets it first. */
  setUniform(program: ProgramHandle, name: string, value: UniformValue): void;
  setDepthTest(enabled: boolean): void;
  setBlend(mode: BlendMode): void;
  draw(geometry: GeometryHandle): void;
}

/**
 * A shader that will not compile is a bug in our own source, not a runtime
 * condition to recover from, so it throws rather than returning a `Result`.
 * It carries the driver's log because Mesa V3D's messages are the only useful
 * diagnostic when something compiles on a desktop and not on the Pi.
 */
export class GlProgramError extends Error {
  constructor(stage: string, log: string) {
    super(`${stage} failed: ${log}`);
    this.name = 'GlProgramError';
  }
}

interface GeometryRecord {
  readonly vao: WebGLVertexArrayObject;
  readonly buffers: readonly WebGLBuffer[];
  readonly count: number;
  readonly indexed: boolean;
}

const compile = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  stage: string,
): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) throw new GlProgramError(stage, 'no shader object');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new GlProgramError(stage, log);
  }
  return shader;
};

/** The real thing. Everything above this line is testable; this is not. */
export const createGlContext = (gl: WebGL2RenderingContext): GlContext => {
  /**
   * Uniform locations are looked up by string. Doing that per uniform per pass
   * per frame is a measurable cost on a Pi, and the answer never changes for
   * the life of a program — so it is cached here rather than in every caller.
   */
  const locations = new WeakMap<object, Map<string, WebGLUniformLocation | null>>();

  const locationOf = (program: ProgramHandle, name: string): WebGLUniformLocation | null => {
    const raw = program as unknown as WebGLProgram;
    let cache = locations.get(raw);
    if (cache === undefined) {
      cache = new Map();
      locations.set(raw, cache);
    }
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const found = gl.getUniformLocation(raw, name);
    cache.set(name, found);
    return found;
  };

  return {
    createProgram: ({ vertex, fragment }) => {
      const vs = compile(gl, gl.VERTEX_SHADER, vertex, 'vertex shader');
      const fs = compile(gl, gl.FRAGMENT_SHADER, fragment, 'fragment shader');
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      // Attached shaders are reference-counted by the program, so they can go
      // as soon as the link succeeds — and must go if it failed.
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
        const log = gl.getProgramInfoLog(program) ?? '';
        gl.deleteProgram(program);
        throw new GlProgramError('link', log);
      }
      return program as unknown as ProgramHandle;
    },

    deleteProgram: (program) => {
      gl.deleteProgram(program as unknown as WebGLProgram);
    },

    createGeometry: ({ attributes, indices, count }) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buffers: WebGLBuffer[] = [];
      for (const attribute of attributes) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, attribute.data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(attribute.location);
        gl.vertexAttribPointer(attribute.location, attribute.size, gl.FLOAT, false, 0, 0);
        buffers.push(buffer);
      }
      if (indices !== undefined) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        buffers.push(buffer);
      }
      gl.bindVertexArray(null);
      const record: GeometryRecord = {
        vao,
        buffers,
        count,
        indexed: indices !== undefined,
      };
      return record as unknown as GeometryHandle;
    },

    deleteGeometry: (geometry) => {
      const record = geometry as unknown as GeometryRecord;
      for (const buffer of record.buffers) gl.deleteBuffer(buffer);
      gl.deleteVertexArray(record.vao);
    },

    createTexture: ({ width, height, filter, wrap }) => {
      const texture = gl.createTexture();
      const mode = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      const edge = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // 8-bit RGBA, not a float target: rendering to float is optional on
      // GLES 3.1 and slow on V3D where it is available. The chain is colour,
      // and colour fits in a byte.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, edge);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, edge);
      return texture as unknown as TextureHandle;
    },

    resizeTexture: (texture, width, height) => {
      gl.bindTexture(gl.TEXTURE_2D, texture as unknown as WebGLTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    },

    uploadImage: (texture, source) => {
      gl.bindTexture(gl.TEXTURE_2D, texture as unknown as WebGLTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    },

    deleteTexture: (texture) => {
      gl.deleteTexture(texture as unknown as WebGLTexture);
    },

    createFramebuffer: (colour) => {
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        colour as unknown as WebGLTexture,
        0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return framebuffer as unknown as FramebufferHandle;
    },

    deleteFramebuffer: (framebuffer) => {
      gl.deleteFramebuffer(framebuffer as unknown as WebGLFramebuffer);
    },

    bindFramebuffer: (framebuffer) => {
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        framebuffer === null ? null : (framebuffer as unknown as WebGLFramebuffer),
      );
    },

    viewport: (width, height) => {
      gl.viewport(0, 0, width, height);
    },

    clear: ([r, g, b, a]) => {
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },

    useProgram: (program) => {
      gl.useProgram(program as unknown as WebGLProgram);
    },

    bindTexture: (unit, texture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture as unknown as WebGLTexture);
    },

    setUniform: (program, name, value) => {
      const location = locationOf(program, name);
      // A uniform the shader does not declare, or declares and never reads, is
      // optimised away and has no location. That is normal for a shared block
      // like ours, so it is skipped rather than treated as an error.
      if (location === null) return;
      switch (value.kind) {
        case 'float':
          gl.uniform1f(location, value.value);
          return;
        case 'vec2':
          gl.uniform2f(location, value.value[0], value.value[1]);
          return;
        case 'vec3':
          gl.uniform3f(location, value.value[0], value.value[1], value.value[2]);
          return;
        case 'floats':
          gl.uniform1fv(location, value.value);
          return;
        case 'sampler':
          gl.uniform1i(location, value.value);
          return;
      }
    },

    setDepthTest: (enabled) => {
      if (enabled) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
    },

    setBlend: (mode) => {
      if (mode === 'alpha') {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.disable(gl.BLEND);
      }
    },

    draw: (geometry) => {
      const record = geometry as unknown as GeometryRecord;
      gl.bindVertexArray(record.vao);
      if (record.indexed) {
        gl.drawElements(gl.TRIANGLES, record.count, gl.UNSIGNED_SHORT, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, record.count);
      }
    },
  };
};
