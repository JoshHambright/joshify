/**
 * The visualiser, running.
 *
 * Twenty-two shaders and two scenes were written against a contract and
 * verified by 288 headless tests, and until this file existed not one of them
 * had produced a pixel. That gap is exactly what CLAUDE.md's prototype-in-a-
 * page rule is for: the target is a browser, so a published page runs the same
 * GLSL the Pi will — this is not a mockup of the visualiser, it is the
 * visualiser on different hardware.
 *
 * Nothing here is a re-implementation. It builds the real `GlContext` over a
 * real canvas, the real pipeline, the real catalogue, the real looks and the
 * real procedural provider. What it adds is a review harness: a look switcher,
 * an intensity dial, a grain slider, a tempo tap, and covers to run it against.
 */
import { createGlContext } from '../src/gl/gl-context.js';
import { createPipeline } from '../src/gl/pipeline.js';
import { BUILT_IN_CATALOGUE } from '../src/gl/passes.js';
import { buildLooks } from '../src/gl/looks.js';
import { createPresetPicker } from '../src/gl/presets.js';
import { createProceduralProvider } from '../src/reactivity/procedural.js';
import { createTempoProvider } from '../src/reactivity/tempo.js';
// The shader's colour type — three floats in 0..1 — not core's 8-bit `Rgb`.
import type { ShaderRgb } from '../src/gl/uniforms.js';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const chips = document.querySelector<HTMLDivElement>('#looks');
const readout = document.querySelector<HTMLDivElement>('#readout');
if (canvas === null || chips === null || readout === null) {
  throw new Error('the harness markup is missing');
}

/**
 * The panel's own dimensions, halved.
 *
 * The visualiser is judged at the size it will be seen at — a shader tuned on
 * a 1920px canvas and shipped to a 720px one is tuned for the wrong thing,
 * because every effect here has a scale in texels.
 */
const WIDTH = 360;
const HEIGHT = 640;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const context = canvas.getContext('webgl2', {
  antialias: false,
  // The chain composites its own frames; a depth buffer would be memory the
  // Pi cannot spare for something nothing reads (D-070).
  depth: false,
  preserveDrawingBuffer: false,
});
if (context === null) {
  readout.textContent = 'This browser has no WebGL2.';
  throw new Error('no webgl2');
}

/**
 * Covers as data URIs, generated rather than fetched.
 *
 * A published page has no network guarantee, and every effect here reads the
 * artwork — a cover that never arrives would make the whole library look
 * broken while behaving correctly.
 */
const cover = (a: string, b: string, mark: string): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
    </linearGradient></defs>
    <rect width="256" height="256" fill="url(#g)"/>
    <circle cx="188" cy="72" r="52" fill="${mark}"/>
    <rect x="24" y="172" width="120" height="11" fill="${mark}" opacity="0.85"/>
    <rect x="24" y="192" width="76" height="11" fill="${mark}" opacity="0.5"/>
    <path d="M0 256 L96 150 L168 256 Z" fill="${mark}" opacity="0.25"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const COVERS = [
  { art: cover('#1b2a4a', '#0b1020', '#ff5c8a'), accent: [1, 0.48, 0.64] as const },
  { art: cover('#123a33', '#04140f', '#4fe3a1'), accent: [0.31, 0.89, 0.63] as const },
  { art: cover('#3a1e0c', '#160804', '#ffb347'), accent: [1, 0.7, 0.28] as const },
];

const { presets, problems } = buildLooks(BUILT_IN_CATALOGUE);
if (problems.length > 0) readout.textContent = problems.join(' · ');

const picker = createPresetPicker({ presets });
const firstPreset = presets[0];
if (firstPreset === undefined) throw new Error('no looks parsed');

const gl = createGlContext(context);
const pipeline = createPipeline(gl, {
  preset: firstPreset,
  outputSize: { width: WIDTH, height: HEIGHT },
  catalogue: BUILT_IN_CATALOGUE,
});

const procedural = createProceduralProvider();
const tempo = createTempoProvider({ fallback: procedural });

let coverIndex = 0;
let intensity = 1;
let grain = 1;
const FOREGROUND: ShaderRgb = [0.96, 0.95, 0.97];

const loadCover = (index: number): void => {
  const entry = COVERS[index % COVERS.length];
  if (entry === undefined) return;
  const image = new Image();
  image.addEventListener('load', () => {
    pipeline.setArt(image);
  });
  image.src = entry.art;
};
loadCover(0);

/** One chip per look, plus the state the review needs to see. */
const buildChips = (): void => {
  for (const preset of presets) {
    const button = document.createElement('button');
    button.textContent = preset.name;
    button.dataset['look'] = preset.id;
    button.addEventListener('click', () => {
      picker.select(preset.id);
    });
    chips.append(button);
  }
};
buildChips();

const markCurrent = (): void => {
  const current = picker.current()?.preset.id;
  for (const button of chips.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset['look'] === current);
  }
};

let lastFrameMs = performance.now();
let framesThisSecond = 0;
let fpsWindowStart = lastFrameMs;
let fps = 0;

const frame = (nowMs: number): void => {
  const elapsedMs = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  const current = picker.current();
  if (current !== null) pipeline.setPreset(current.preset);

  const accent = COVERS[coverIndex % COVERS.length]?.accent ?? ([1, 1, 1] as ShaderRgb);
  const sampled = tempo.sample(nowMs);

  pipeline.setGrain(grain);
  const plan = pipeline.render({
    reactivity: { ...sampled, timeSeconds: nowMs / 1000 },
    accent,
    foreground: FOREGROUND,
    intensity,
    elapsedMs,
  });

  framesThisSecond += 1;
  if (nowMs - fpsWindowStart >= 500) {
    fps = Math.round((framesThisSecond * 1000) / (nowMs - fpsWindowStart));
    framesThisSecond = 0;
    fpsWindowStart = nowMs;
  }

  const bpm = tempo.bpm;
  readout.textContent = [
    `${String(fps)} fps`,
    `scale ${plan.scale.toFixed(2)}`,
    `${String(plan.chain.length)} passes`,
    bpm === null
      ? 'tier 0 · procedural'
      : `tier 1 · ${String(Math.round(bpm))} bpm${tempo.barAligned ? ' · aligned' : ''}`,
  ].join('  ·  ');

  markCurrent();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

/** The controls a reviewer needs and a device does not have. */
const wire = (id: string, run: () => void): void => {
  document.querySelector(`#${id}`)?.addEventListener('click', run);
};

wire('next', () => {
  picker.next();
});
wire('prev', () => {
  picker.previous();
});
wire('cover', () => {
  coverIndex += 1;
  loadCover(coverIndex);
});
// One control, three behaviours, all inside the provider: the first tap
// aligns the phase, the fourth establishes a tempo (D-064).
wire('tap', () => {
  tempo.tap(performance.now());
});

document
  .querySelector<HTMLInputElement>('#intensity')
  ?.addEventListener('input', (event) => {
    intensity = Number((event.target as HTMLInputElement).value) / 100;
  });
document.querySelector<HTMLInputElement>('#grain')?.addEventListener('input', (event) => {
  grain = Number((event.target as HTMLInputElement).value) / 100;
});
