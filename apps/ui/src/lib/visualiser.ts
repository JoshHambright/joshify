/**
 * The visualiser, driving the panel (P5-15).
 *
 * Twenty-six passes, seven scenes and fifteen looks were written, tested and
 * reviewed on a published page, and until this file existed none of them had
 * ever run *behind the controls*. The demo harness proved the shaders; this is
 * what makes them the panel's backdrop.
 *
 * **Everything that decides anything lives here, not in the component.** The
 * Svelte side owns a canvas, a GL context and an `<img>`; it makes no choices.
 * That split is what lets the whole of this be tested in Node against the
 * recording fake, which matters more than usual: a render loop is exactly the
 * kind of code where a bug is a slow leak or a stale frame rather than a
 * failure, and neither shows up by looking at it.
 *
 * Four things it is responsible for:
 *
 *  - **The frame.** Sample the provider, build the uniforms, render, and hand
 *    the elapsed time to the degrader so it can drop scale before it drops
 *    passes (P5-14).
 *  - **The mode.** `uIntensity` is the mode machine's, so "now playing" is a
 *    quiet backdrop and "full" is the whole screen — one number, and the
 *    difference between a panel and a screensaver.
 *  - **The artwork.** Uploading the cover is asynchronous and the track can
 *    change while it is in flight, so every load carries a generation and a
 *    late arrival is dropped. Without the fence a slow image quietly replaces
 *    the cover of the track that is actually playing.
 *  - **Nothing else.** No layout, no DOM, no policy about what is playing.
 */
import { parseHex, type ThemeTokens } from '@joshify/core';
import type { GlContext } from '../gl/gl-context.js';
import { createPipeline, type Pipeline } from '../gl/pipeline.js';
import { BUILT_IN_CATALOGUE, type Catalogue, type Preset } from '../gl/passes.js';
import { createPresetPicker, type PresetPicker } from '../gl/presets.js';
import type { ShaderRgb, Size } from '../gl/uniforms.js';
import type { ModeMachine } from '../gl/modes.js';
import type { ReactivityProvider } from '../reactivity/provider.js';

/** What the pipeline can upload. Narrowed so a test can pass a token. */
export type ArtSource = Parameters<Pipeline['setArt']>[0];

export interface VisualiserConfig {
  readonly gl: GlContext;
  readonly presets: readonly Preset[];
  readonly provider: ReactivityProvider;
  readonly modes: ModeMachine;
  readonly size: Size;
  /** `requestAnimationFrame`, injected: jsdom has neither a clock nor a GPU. */
  readonly schedule: (run: (nowMs: number) => void) => number;
  readonly cancel: (handle: number) => void;
  /**
   * Decode a URL into something uploadable, or null if it cannot be had.
   * Rejections are treated as null: a cover that fails to load is a scene with
   * no artwork, which every scene already handles, not an error to surface.
   */
  readonly loadArt: (url: string) => Promise<ArtSource | null>;
  readonly catalogue?: Catalogue | undefined;
  readonly tempoBpm?: (() => number | null) | undefined;
}

export interface VisualiserStatus {
  readonly running: boolean;
  readonly look: string | null;
  /** The render scale the degrader settled on, 1 when nothing has degraded. */
  readonly scale: number;
  readonly passes: number;
}

export interface Visualiser {
  readonly start: () => void;
  readonly stop: () => void;
  /** The cover for the track on screen, or null for one with no images. */
  readonly setArt: (url: string | null) => void;
  /** The album's five. Only two reach a shader, but they arrive together. */
  readonly setTheme: (theme: ThemeTokens) => void;
  /** The track key, for shuffle-on-track-change. Safe to call every poll. */
  readonly setTrack: (key: string | null) => void;
  readonly setShuffle: (on: boolean) => void;
  readonly selectLook: (id: string) => void;
  readonly nextLook: () => void;
  readonly setGrain: (scale: number) => void;
  readonly resize: (size: Size) => void;
  readonly status: () => VisualiserStatus;
  readonly picker: PresetPicker;
  readonly dispose: () => void;
}

/**
 * A hex colour as three floats.
 *
 * The UI computes nothing (D-003) and this is not an exception: the server
 * already proved the colour contrast-safe, and this only changes its format
 * from the one CSS wants to the one GLSL wants. A malformed value falls back
 * to white rather than to black — an unreadable panel is worse than a washed
 * one, and black is what an unset uniform already is.
 */
export const shaderRgb = (hex: string, fallback: ShaderRgb = [1, 1, 1]): ShaderRgb => {
  const parsed = parseHex(hex);
  if (parsed === null) return fallback;
  return [parsed.r / 255, parsed.g / 255, parsed.b / 255];
};

const NEUTRAL_ACCENT: ShaderRgb = [0.6, 0.64, 0.7];
const NEUTRAL_FOREGROUND: ShaderRgb = [0.95, 0.95, 0.96];

export const createVisualiser = (config: VisualiserConfig): Visualiser => {
  const catalogue = config.catalogue ?? BUILT_IN_CATALOGUE;
  const picker = createPresetPicker({ presets: config.presets });
  const first = picker.current()?.preset;
  if (first === undefined) throw new Error('the visualiser needs at least one look');

  const pipeline = createPipeline(config.gl, {
    preset: first,
    outputSize: config.size,
    catalogue,
  });

  let accent = NEUTRAL_ACCENT;
  let foreground = NEUTRAL_FOREGROUND;
  let handle: number | null = null;
  let lastFrameMs: number | null = null;
  let scale = 1;
  let passes = first.chain.length;

  /*
   * The artwork fence.
   *
   * A cover is fetched and decoded, and both take longer than a track change
   * can. Without a generation the sequence "skip, skip, first image finally
   * decodes" ends with the *first* track's cover on screen under the third
   * track's title — and it looks like the artwork is simply wrong, with
   * nothing in the code obviously at fault.
   */
  let generation = 0;
  let artUrl: string | null = null;

  const applyArt = (url: string | null): void => {
    if (url === artUrl) return;
    artUrl = url;
    generation += 1;
    const mine = generation;
    if (url === null) {
      pipeline.setArt(null);
      return;
    }
    void config.loadArt(url).then(
      (source) => {
        if (mine !== generation) return;
        // A null here is a cover that could not be decoded, and the honest
        // answer is the same as having none: clear, rather than keep the
        // previous track's picture as though it belonged to this one.
        pipeline.setArt(source);
      },
      () => {
        if (mine !== generation) return;
        pipeline.setArt(null);
      },
    );
  };

  const frame = (nowMs: number): void => {
    handle = config.schedule(frame);

    config.modes.tick(nowMs);
    const { intensity } = config.modes.state();

    const current = picker.current();
    if (current !== null) {
      pipeline.setPreset(current.preset);
      passes = current.preset.chain.length;
    }

    const sampled = config.provider.sample(nowMs);
    // The first frame has no previous one, so it observes nothing rather than
    // handing the degrader the time since the epoch and degrading instantly.
    const elapsedMs = lastFrameMs === null ? undefined : nowMs - lastFrameMs;
    lastFrameMs = nowMs;

    const plan = pipeline.render({
      reactivity: { ...sampled, timeSeconds: nowMs / 1000 },
      bpm: config.tempoBpm?.() ?? null,
      accent,
      foreground,
      intensity,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
    scale = plan.scale;
  };

  return {
    picker,

    start: () => {
      if (handle !== null) return;
      lastFrameMs = null;
      handle = config.schedule(frame);
    },

    stop: () => {
      if (handle === null) return;
      config.cancel(handle);
      handle = null;
    },

    setArt: applyArt,

    setTheme: (theme) => {
      accent = shaderRgb(theme.accent, NEUTRAL_ACCENT);
      foreground = shaderRgb(theme.foreground, NEUTRAL_FOREGROUND);
    },

    setTrack: (key) => {
      picker.trackChanged(key);
    },

    setShuffle: (on) => {
      picker.setShuffle(on);
    },

    selectLook: (id) => {
      picker.select(id);
    },

    nextLook: () => {
      picker.next();
    },

    setGrain: (value) => {
      pipeline.setGrain(value);
    },

    resize: (size) => {
      pipeline.setOutputSize(size);
    },

    status: () => ({
      running: handle !== null,
      look: picker.current()?.preset.id ?? null,
      scale,
      passes,
    }),

    dispose: () => {
      if (handle !== null) config.cancel(handle);
      handle = null;
      // Bumped so an image still in flight cannot upload into a disposed
      // pipeline — the one way this could touch GL after teardown.
      generation += 1;
      pipeline.dispose();
    },
  };
};
