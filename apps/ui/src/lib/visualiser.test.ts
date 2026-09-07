/**
 * The render loop, in Node.
 *
 * Every frame here is a call to a scheduler this test owns, so "sixty seconds
 * of playing" is sixty calls and nothing waits. That is the point of injecting
 * the scheduler rather than reaching for `requestAnimationFrame`: the bugs a
 * render loop actually has — a frame after teardown, an image landing for a
 * track that has been skipped, a degrader fed the time since the epoch — are
 * all timing bugs, and none of them are visible by reading the code.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, type ThemeTokens } from '@joshify/core';
import { createVisualiser, shaderRgb, type ArtSource } from './visualiser.js';
import { createFakeGl, type FakeGl, type GlCall } from '../gl/testing/fake-gl.js';
import { FLAT_SCENE, GRAIN_PASS, type Catalogue, type Preset } from '../gl/passes.js';
import { createModeMachine, MODE_INTENSITY } from '../gl/modes.js';
import type { Reactivity, ReactivityProvider } from '../reactivity/provider.js';

const SIZE = { width: 720, height: 1280 };

const catalogue: Catalogue = { scenes: [FLAT_SCENE], passes: [GRAIN_PASS] };

const look = (id: string, chain: readonly string[] = ['grain']): Preset => ({
  id,
  name: id.toUpperCase(),
  scene: 'flat',
  sceneParams: {},
  chain: chain.map((pass) => ({ pass, params: {} })),
});

const bands = new Float32Array(16);

const provider: ReactivityProvider = {
  tier: 0,
  sample: (atMs): Reactivity => ({
    beat: 0.5,
    energy: 0.5,
    phase: (atMs / 1000) % 1,
    bands,
  }),
};

/** One in-flight cover request, with its own resolver. */
interface LoadRequest {
  readonly url: string;
  readonly settle: (source: ArtSource | null) => void;
  readonly fail: () => void;
}

interface Harness {
  readonly fake: FakeGl;
  readonly run: (nowMs: number) => void;
  readonly pending: () => number;
  readonly cancelled: readonly number[];
  readonly loads: LoadRequest[];
}

/**
 * A scheduler and an image loader the test drives by hand.
 *
 * `run` fires the frame that is currently scheduled, exactly as a browser
 * would, so a loop that fails to re-schedule shows up as a second `run` doing
 * nothing rather than as a passing test.
 */
const harness = (
  overrides: Partial<Parameters<typeof createVisualiser>[0]> = {},
): Harness & { readonly visualiser: ReturnType<typeof createVisualiser> } => {
  const fake = createFakeGl();
  let next = 1;
  let scheduled: ((nowMs: number) => void) | null = null;
  const cancelled: number[] = [];
  const loads: LoadRequest[] = [];

  const visualiser = createVisualiser({
    gl: fake.gl,
    presets: [look('ghost'), look('vhs', ['grain', 'grain'])],
    provider,
    modes: createModeMachine({ autoEnter: false }),
    size: SIZE,
    catalogue,
    schedule: (run) => {
      scheduled = run;
      return next++;
    },
    cancel: (handle) => {
      cancelled.push(handle);
      scheduled = null;
    },
    // Each request keeps its *own* resolver, which is the whole point: the
    // fence can only be tested by settling a load the track has moved past.
    loadArt: async (url) =>
      await new Promise<ArtSource | null>((resolve, reject) => {
        loads.push({
          url,
          settle: resolve,
          fail: () => {
            reject(new Error('decode failed'));
          },
        });
      }),
    ...overrides,
  });

  return {
    fake,
    visualiser,
    cancelled,
    loads,
    pending: () => (scheduled === null ? 0 : 1),
    run: (nowMs) => {
      const due = scheduled;
      scheduled = null;
      due?.(nowMs);
    },
  };
};

/** The URLs asked for, in order. */
const urls = (h: Harness): readonly string[] => h.loads.map((load) => load.url);

/** Stands in for a decoded image; the fake only ever labels it. */
const SOURCE = {} as unknown as ArtSource;

/** Let the promise chain inside `setArt` settle. Two ticks, not one. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const uploads = (fake: FakeGl): number =>
  fake.calls.filter((call) => call.op === 'uploadImage').length;

const drawsIn = (fake: FakeGl): readonly GlCall[] =>
  fake.calls.filter((call) => call.op === 'draw');

const uniform = (fake: FakeGl, name: string): number | undefined => {
  const calls = fake.calls.filter(
    (call): call is Extract<GlCall, { op: 'setUniform' }> =>
      call.op === 'setUniform' && call.name === name,
  );
  const last = calls[calls.length - 1]?.value;
  return last?.kind === 'float' ? last.value : undefined;
};

describe('starting and stopping', () => {
  it('draws nothing until it is started', () => {
    const { fake, visualiser } = harness();

    // Building the pipeline compiles shaders; it must not render.
    expect(drawsIn(fake)).toHaveLength(0);
    expect(visualiser.status().running).toBe(false);
  });

  it('renders a frame once started, and schedules the next one', () => {
    const h = harness();
    h.visualiser.start();
    h.fake.clearLog();

    h.run(16);

    expect(drawsIn(h.fake).length).toBeGreaterThan(0);
    expect(h.pending()).toBe(1);
    expect(h.visualiser.status().running).toBe(true);
  });

  it('is idempotent, so a remount cannot leave two loops running', () => {
    const h = harness();
    h.visualiser.start();
    h.visualiser.start();
    h.run(16);

    expect(h.pending()).toBe(1);
  });

  it('stops, and a stopped loop draws nothing more', () => {
    const h = harness();
    h.visualiser.start();
    h.visualiser.stop();
    h.fake.clearLog();

    h.run(16);

    expect(drawsIn(h.fake)).toHaveLength(0);
    expect(h.cancelled).toHaveLength(1);
    expect(h.visualiser.status().running).toBe(false);
  });

  it('releases the GL objects on dispose', () => {
    const h = harness();
    h.visualiser.start();
    h.visualiser.dispose();

    expect(h.fake.live('texture')).toEqual([]);
    expect(h.fake.live('framebuffer')).toEqual([]);
  });
});

describe('the mode drives the intensity', () => {
  it('renders quietly while the panel is being used', () => {
    const modes = createModeMachine({ autoEnter: false });
    const h = harness({ modes });
    h.visualiser.start();
    h.run(16);

    expect(uniform(h.fake, 'uIntensity')).toBeCloseTo(MODE_INTENSITY['now-playing']);
  });

  it('takes the screen once the machine says so', () => {
    const modes = createModeMachine({ autoEnter: false });
    const h = harness({ modes });
    h.visualiser.start();
    modes.setMode('full', 0);
    h.run(16);

    expect(uniform(h.fake, 'uIntensity')).toBeCloseTo(MODE_INTENSITY.full);
  });

  // Otherwise the idle timer only advances while something else happens to be
  // calling it, which is a screensaver that never starts.
  it('ticks the machine itself, so the panel can go idle on its own', () => {
    const modes = createModeMachine({ idleMs: 1000 });
    const h = harness({ modes });
    h.visualiser.start();

    h.run(500);
    expect(modes.state().mode).toBe('now-playing');

    h.run(1500);
    expect(modes.state().mode).toBe('full');
  });
});

describe('the artwork fence', () => {
  it('asks for the cover once and uploads it', async () => {
    const h = harness();
    h.visualiser.setArt('https://art/one.jpg');
    h.fake.clearLog();

    h.loads[0]?.settle(SOURCE);
    await flush();

    expect(urls(h)).toEqual(['https://art/one.jpg']);
    expect(uploads(h.fake)).toBe(1);
  });

  it('does not re-fetch the cover it already has', () => {
    const h = harness();
    h.visualiser.setArt('https://art/one.jpg');
    h.visualiser.setArt('https://art/one.jpg');

    expect(h.loads).toHaveLength(1);
  });

  /*
   * The bug this exists for: skip, skip, and then the *first* cover finally
   * decodes. Without the generation it lands under the third track's title and
   * looks like the artwork is simply wrong, with nothing obviously at fault.
   */
  it('drops a cover that arrives after the track moved on', async () => {
    const h = harness();
    h.visualiser.setArt('https://art/one.jpg');
    h.visualiser.setArt('https://art/two.jpg');
    h.fake.clearLog();

    h.loads[0]?.settle(SOURCE);
    await flush();

    expect(urls(h)).toEqual(['https://art/one.jpg', 'https://art/two.jpg']);
    expect(uploads(h.fake)).toBe(0);
  });

  it('still uploads the cover of the track that is actually playing', async () => {
    const h = harness();
    h.visualiser.setArt('https://art/one.jpg');
    h.visualiser.setArt('https://art/two.jpg');
    h.fake.clearLog();

    h.loads[1]?.settle(SOURCE);
    await flush();

    expect(uploads(h.fake)).toBe(1);
  });

  // A sleeve that will not decode is a track with no artwork, which every
  // scene already handles. An unhandled rejection would take the loop with it.
  it('treats a cover that will not decode as no cover, not as an error', async () => {
    const h = harness();
    h.visualiser.setArt('https://art/broken.jpg');
    h.fake.clearLog();

    h.loads[0]?.fail();
    await flush();

    expect(uploads(h.fake)).toBe(0);
  });

  it('clears the art for a track that has none', () => {
    const h = harness();
    h.visualiser.setArt(null);

    expect(h.loads).toEqual([]);
  });

  // The one way this could touch GL after teardown.
  it('cannot upload into a disposed pipeline', async () => {
    const h = harness();
    h.visualiser.setArt('https://art/one.jpg');
    h.visualiser.dispose();
    h.fake.clearLog();

    h.loads[0]?.settle(SOURCE);
    await flush();

    expect(uploads(h.fake)).toBe(0);
  });
});

describe('the album colour', () => {
  it('converts the theme into the floats a shader wants', () => {
    expect(shaderRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
  });

  it('falls back to a light colour rather than black on a malformed value', () => {
    expect(shaderRgb('rebeccapurple')).toEqual([1, 1, 1]);
  });

  it('uploads the accent it was given', () => {
    const h = harness();
    const theme: ThemeTokens = { ...DEFAULT_THEME, accent: '#ff0000' };
    h.visualiser.setTheme(theme);
    h.visualiser.start();
    h.fake.clearLog();
    h.run(16);

    const accent = h.fake.calls.find(
      (call): call is Extract<GlCall, { op: 'setUniform' }> =>
        call.op === 'setUniform' && call.name === 'uAccent',
    );
    expect(accent?.value).toEqual({ kind: 'vec3', value: [1, 0, 0] });
  });
});

describe('the look', () => {
  it('starts on the first look in the roster', () => {
    const h = harness();

    expect(h.visualiser.status().look).toBe('ghost');
  });

  it('steps to the next one on request', () => {
    const h = harness();
    h.visualiser.nextLook();

    expect(h.visualiser.status().look).toBe('vhs');
  });

  it('reports the chain length of the look actually rendering', () => {
    const h = harness();
    h.visualiser.selectLook('vhs');
    h.visualiser.start();
    h.run(16);

    expect(h.visualiser.status().passes).toBe(2);
  });

  it('does nothing on a poll that reports the same track', () => {
    const h = harness();
    h.visualiser.setShuffle(true);
    h.visualiser.setTrack('spotify:track:1');
    const first = h.visualiser.status().look;
    h.visualiser.setTrack('spotify:track:1');

    expect(h.visualiser.status().look).toBe(first);
  });
});

describe('the degrader', () => {
  it('renders at the half-resolution ceiling by default (P5-13)', () => {
    const h = harness();
    h.visualiser.start();
    h.run(16);

    expect(h.visualiser.status().scale).toBe(0.5);
  });

  /*
   * The elapsed time has to actually reach the budget, or auto-degrade is a
   * feature that exists and never fires. Sixty frames at 40ms is every frame
   * missed, which is well past the 20% the ladder degrades at.
   */
  it('steps the scale down when frames are being missed', () => {
    const h = harness();
    h.visualiser.start();
    for (let index = 1; index <= 60; index += 1) h.run(index * 40);

    expect(h.visualiser.status().scale).toBeLessThan(0.5);
  });

  /*
   * And the first frame must not be one of those observations. There is no
   * previous frame to measure against, so the only elapsed time available is
   * the time since the page loaded — which on a panel that has been up for a
   * while is a frame time in the tens of thousands of milliseconds.
   */
  it('does not count the first frame, which has nothing to be measured against', () => {
    const h = harness();
    h.visualiser.start();
    // One enormous first frame, then a run of good ones. If the first had been
    // observed it would sit in the window as a missed frame.
    h.run(600_000);
    for (let index = 1; index <= 44; index += 1) h.run(600_000 + index * 16);

    expect(h.visualiser.status().scale).toBe(0.5);
  });
});
