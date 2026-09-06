# `src/gl` — the visualiser engine

Phase 5's render pipeline: a **scene**, a **ping-pong post chain**, an
**upscale**, and **overlays**. Presets are data; the passes are shaders; the
decisions are all testable in Node.

| File | What it owns |
|---|---|
| `gl-context.ts` | The **only** file that touches WebGL. A narrow interface plus a real implementation over `WebGL2RenderingContext`. |
| `testing/fake-gl.ts` | The same interface, recording every call in order. Not a GL simulator, and must never become one. |
| `uniforms.ts` | **The uniform contract** — the seam with the reactivity provider. |
| `passes.ts` | Scenes, passes and preset parsing. The catalogue is data. |
| `pipeline.ts` | `planFrame` (pure) and `createPipeline` (executes a plan). |
| `budget.ts` | The grain slider (P5-13) and the auto-degrader (P5-14). |

## Why it is split this way

CI has no GPU and jsdom has no WebGL at all. A pipeline written straight against
`WebGL2RenderingContext` is a pipeline nobody tests, so the *decisions* are
separated from the *calls* (D-043, the same split as `connection.ts`):

- `planFrame(preset, catalogue, size, quality, previousFinal) -> RenderPlan` is a
  pure function. Which pass runs, what it reads, what it writes, what the budget
  dropped — all of it is in that value, assertable in plain Node.
- `render()` walks the plan and issues calls through `GlContext`. The recording
  fake proves those calls came out in the right order, against the right targets.
- Only `gl-context.ts` needs a real GPU, and all it does is translate.

## The uniform contract

Every shader — scene or pass — reads the same block. What fills it is the
reactivity provider's problem (Tier 0 procedural, Tier 1 BPM-locked, Tier 2 real
FFT); nothing in this directory imports it. `render()` takes plain numbers.

```glsl
uniform float     uTime;        // seconds, monotonic, unbounded
uniform float     uBeat;        // 0..1, decaying spike on each beat
uniform float     uEnergy;      // 0..1, overall intensity
uniform float     uBands[16];   // 0..1, bass -> treble
uniform float     uIntensity;   // 0..1, the user's effect-strength dial
uniform vec3      uAccent;      // 0..1 rgb, from the album art
uniform vec3      uForeground;  // 0..1 rgb
uniform vec2      uResolution;  // the size THIS STAGE renders at
uniform vec2      uTexel;       // 1.0 / uResolution
uniform sampler2D uTexture;     // unit 0 — what the previous stage drew
uniform sampler2D uArt;         // unit 1 — the album cover
uniform sampler2D uPrev;        // unit 2 — last frame's output (feedback)
```

Filled by `buildFrameUniforms(FrameContext)`, where

```ts
interface Reactivity {
  timeSeconds: number;   // monotonic
  beat: number;          // 0..1
  energy: number;        // 0..1
  bands: readonly number[]; // any length; padded or truncated to 16
}
```

Guarantees the provider can rely on, and does not have to implement itself:

- **Everything is clamped** to `0..1` except `uTime`, which is unbounded by
  design — a shader that wants a phase wraps it itself.
- **`NaN` and `Infinity` become `0`.** A division by a BPM that came back zero
  would otherwise reach the GPU and paint a black screen with no error anywhere.
- **`uBands` is always exactly 16 elements.** `uniform1fv` writes only what it is
  given, so a short array would leave the top octave frozen at whatever the last
  preset wrote.
- **`uResolution` is the size of the surface being drawn now**, not the panel. At
  0.5 scale the chain gets `360x640` and the upscale gets `720x1280`. A pass that
  believes it is full size samples half a texel off — it never fails, it just
  looks slightly soft forever.
- **Texture units are fixed** (0/1/2) for the life of the engine.

Pass parameters ride alongside: a preset's `{"zoom": 0.03}` reaches the shader as
`uZoom`. That mapping (`paramUniformName`) is what makes a preset data — adding
an effect is a shader plus a JSON entry, never a branch.

## Presets are data

```json
{
  "id": "ghost",
  "name": "Ghost",
  "scene": "flat",
  "sceneParams": { "flash": 0.2 },
  "chain": [
    { "pass": "feedback", "params": { "zoom": 0.03, "decay": 0.88 } },
    { "pass": "grain", "params": { "amount": 0.06 } }
  ]
}
```

`parsePreset(raw, catalogue)` returns a `Result`, because a bad preset is a data
error and not a bug: unknown scene or pass is reported by name, a chain over the
six-pass budget is refused, unknown parameters are dropped, out-of-range ones are
clamped, and missing ones take the shader's default. Presets outlive shaders.

**Adding an effect:** write a fragment shader, add a `PassDefinition` to the
catalogue with its parameters and their ranges, name it in a preset. There is
nothing to edit in `pipeline.ts`.

**Adding a scene (D-014):** add a `SceneDefinition` with its own vertex shader,
geometry and depth setting. The post chain composes over whatever the scene drew
and cannot tell the difference — which is what makes `tunnel + datamosh` free.

## The frame

```
   scene ──► [ A ] ──► pass ──► [ B ] ──► pass ──► [ A ] ──► present ──► screen
                                                                    └─► overlays
   [ C ] ──────────────────── uPrev (last frame's result) ──────────────┘
```

**Three targets, not two.** Sampling the texture you are drawing into is
undefined behaviour in GLES — it is the classic bug in a pipeline shaped like
this one, and it renders fine on one driver and tears on another. Two targets
ping-pong a chain happily, but the scene would then overwrite *last frame's*
result before the feedback pass could read it, so the whole Milkdrop family
would lose its history one frame in two. So: one target holds the previous frame
and is untouchable, the other two alternate. Next frame the roles rotate.

The invariant, asserted both in the plan and in the recorded GL calls: **no draw
ever samples the texture attached to the framebuffer it is bound to.**

**Overlays** (`overlay: true`) draw over the finished, full-resolution frame with
alpha blending and get no `uTexture` — they composite, they do not filter. That
is where the spectrum bars and any text go, because a 1px bar edge upscaled from
half resolution is mush. `parsePreset` hoists them to the end of the chain.

## Half resolution, and degrading (P5-13, P5-14)

Render scale is one number that is simultaneously the art direction and the
biggest performance lever we have: half resolution is a 4x cut in fragment work
*and* the lo-fi upscale we actually want — which is, near enough, the PS1's 240p
output (PS1_MODE.md, D-011). So it is a **scale factor, not a boolean**, exposed
as "grain", default `0.5`, ladder `1.0 / 0.75 / 0.5 / 0.35 / 0.25`.

The degrader may only walk *down* from what the user chose.

| | |
|---|---|
| Frame budget | `1000/60` = 16.7ms; missed past **1.25x** (20.8ms) |
| Window | **45 frames** (~0.75s), tumbling — a decision consumes its evidence |
| Degrade | more than **20%** of the window missed |
| Recover | fewer than **2%**, and at least **180 frames** (~3s) since the last change |
| On any change | the window is cleared |
| Order | **scale first, then passes from the end of the chain. The scene is never dropped.** |

The asymmetry is the whole design. A degrader that oscillates is worse than one
that never fires, so: degradation is fast (one window) because a stuttering
screen should be fixed now; recovery is slow (a clean window *and* a three-second
dwell) because a premature recovery is a visible stutter followed by a visible
resolution change. Clearing the window on every change is what stops one bad
second walking the ladder to the floor before the first step has been measured.
The dwell is counted in frames rather than wall clock so a backgrounded tab
cannot wait it out.

Moving the grain slider resets the ladder to the top: the step was measured
against a frame cost the user has just changed by hand, and someone dragging
grain down is usually trying to fix the stutter themselves.

## Targeting a Pi 5, not a desktop

VideoCore VII, Mesa V3D, **GLES 3.1** (D-008). What that settles:

- **8-bit RGBA render targets.** Rendering to float is optional on GLES 3.1 and
  slow on V3D where it exists. The chain is colour, and colour fits in a byte.
- **No mid-frame readback, no state queries.** On a tile-based GPU a read stalls
  the pipeline, so the engine keeps its state on the CPU side and never asks.
  That is why `GlContext` has no `getParameter`.
- **One triangle, not two quads.** A single primitive covers the viewport with no
  diagonal seam for the tiler to rasterise twice.
- **`mediump` in fragment shaders** where the value is colour; `highp` only where
  UV or depth maths needs it.
- **Uniform locations are cached**, because a per-uniform string lookup per pass
  per frame is measurable here in a way it is not on a desktop.
- **Shaders compile at startup**, not on first use: a compile is tens of
  milliseconds of stall, and paying for it when a preset changes mid-track is the
  one moment it is guaranteed to be noticed.
- **GLES 3.0 explicit attribute locations** (`layout(location = n)`), so geometry
  is not bound to a program and every pass shares one VAO.

## Testing

```
pnpm exec vitest run apps/ui/src/gl
```

Node environment — none of this touches the DOM. Assertions are made against the
recording fake in the form "these calls, in this order, against these targets".
`fake.draws()` replays the log into the bind state each draw happened under,
which is what makes the ping-pong invariant a one-line assertion.

`gl-context.ts` is exercised in `pipeline.test.ts` against a stub
`WebGL2RenderingContext` — only the translation is checked there (a `vec3` goes
out as `uniform3f`, a failed compile throws with the driver's log). It has no
test file of its own because this task's file budget did not include one.
