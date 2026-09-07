<script lang="ts">
  /**
   * The visualiser, on the panel (P5-15).
   *
   * This component owns a canvas and a WebGL2 context and nothing else. Every
   * decision — which look, which intensity, when to upload a cover, when to
   * degrade — is `lib/visualiser.ts`, tested in Node. What is left here is the
   * three things only a browser can do: get a drawing surface, decode an
   * image, and schedule a frame.
   *
   * **It renders only when it is visible.** The mode machine's resting state
   * is `now-playing`, where the panel shows the approved backdrop and this
   * canvas is transparent — so the loop is stopped rather than drawing a frame
   * nobody sees. On a fanless board that runs for weeks, an invisible render
   * loop is heat and power for nothing, and it is the sort of waste that never
   * shows up as a bug.
   *
   * **A browser with no WebGL2 is not an error.** It is a panel that shows the
   * CSS wash and never the visualiser, which is a complete product. The
   * fallback is reported upwards rather than thrown, because the one thing it
   * must not do is take the controls down with it.
   */
  import { onMount } from 'svelte';
  import type { ThemeTokens } from '@joshify/core';
  import { createGlContext, type GlContext } from '../gl/gl-context.js';
  import { buildLooks } from '../gl/looks.js';
  import type { Preset } from '../gl/passes.js';
  import type { ModeMachine } from '../gl/modes.js';
  import { createProceduralProvider } from '../reactivity/procedural.js';
  import type { ReactivityProvider } from '../reactivity/provider.js';
  import {
    createVisualiser,
    type ArtSource,
    type Visualiser,
  } from '../lib/visualiser.js';

  interface Props {
    /** The cover for the track on screen, at the size the shaders want. */
    art: string | null;
    theme: ThemeTokens;
    /** Changes drive shuffle-on-track-change; safe to pass on every poll. */
    trackKey: string | null;
    modes: ModeMachine;
    /** False in `now-playing`, where the canvas is transparent anyway. */
    active: boolean;
    /** Called once if this browser cannot give us a context. */
    onUnavailable?: (() => void) | undefined;
    /** All four injected so the whole component can be mounted in jsdom. */
    createContext?: ((canvas: HTMLCanvasElement) => GlContext | null) | undefined;
    schedule?: ((run: (nowMs: number) => void) => number) | undefined;
    cancel?: ((handle: number) => void) | undefined;
    loadArt?: ((url: string) => Promise<ArtSource | null>) | undefined;
    presets?: readonly Preset[] | undefined;
    provider?: ReactivityProvider | undefined;
  }

  const {
    art,
    theme,
    trackKey,
    modes,
    active,
    onUnavailable,
    createContext = realContext,
    schedule = (run) => requestAnimationFrame(run),
    cancel = (handle) => {
      cancelAnimationFrame(handle);
    },
    loadArt = decodeArt,
    presets,
    provider,
  }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let engine: Visualiser | null = $state(null);

  /**
   * The real context, with depth and antialiasing off.
   *
   * Neither is a saving to skip on a Pi: the chain composites its own frames
   * and has no depth attachment anywhere (D-074), and multisampling a surface
   * that is about to be upscaled from half resolution is paying twice for the
   * same edge.
   */
  function realContext(surface: HTMLCanvasElement): GlContext | null {
    const context = surface.getContext('webgl2', {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    return context === null ? null : createGlContext(context);
  }

  /**
   * Decode rather than merely load: an image handed to `texImage2D` before it
   * has decoded stalls the GL thread on the decode, which is a dropped frame
   * exactly when a track changes.
   */
  async function decodeArt(url: string): Promise<ArtSource | null> {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
    } catch {
      return null;
    }
    return image;
  }

  onMount(() => {
    const surface = canvas;
    if (surface === undefined) return;

    const gl = createContext(surface);
    if (gl === null) {
      onUnavailable?.();
      return;
    }

    const { presets: built } = buildLooks();
    const roster = presets ?? built;
    if (roster.length === 0) {
      onUnavailable?.();
      return;
    }

    // The drawing buffer is the panel's own pixels. The element is sized by
    // CSS and may be scaled by the desktop letterbox; the buffer must not be,
    // or every effect's texel-denominated scale is wrong by that factor.
    surface.width = surface.clientWidth || 720;
    surface.height = surface.clientHeight || 1280;

    const created = createVisualiser({
      gl,
      presets: roster,
      provider: provider ?? createProceduralProvider(),
      modes,
      size: { width: surface.width, height: surface.height },
      schedule,
      cancel,
      loadArt,
    });
    engine = created;

    return () => {
      engine = null;
      created.dispose();
    };
  });

  // Each of these is a push of state the engine holds; all three are cheap and
  // ignore a value they already have, so running on every poll costs nothing.
  $effect(() => {
    engine?.setTheme(theme);
  });
  $effect(() => {
    engine?.setArt(art);
  });
  $effect(() => {
    engine?.setTrack(trackKey);
  });
  $effect(() => {
    if (engine === null) return;
    if (active) engine.start();
    else engine.stop();
  });
</script>

<canvas bind:this={canvas} class="visualiser" data-active={active} aria-hidden="true"
></canvas>

<style>
  .visualiser {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    opacity: 0;
    /* The same fade a track change uses, so entering ambient reads as part of
       the panel rather than as a layer switching on. */
    transition: opacity var(--jf-theme-fade) ease;
  }

  .visualiser[data-active='true'] {
    opacity: 1;
  }
</style>
