# The visualiser review build

```
pnpm --filter @joshify/ui exec vite build --config vite.visualiser.config.ts
```

Mounts the **real** pipeline over a real WebGL2 canvas: the real catalogue, the
real looks, the real procedural provider. The harness adds a look switcher, an
intensity dial, a grain slider, a tempo tap and three generated covers.

## Two bugs it found in its first run

Both were invisible to 288 headless tests, and both would have shipped.

1. **The tunnel scene would not link.** `uBeat` was `highp` in its vertex shader
   (which declares `precision highp float` for its position maths) and
   `mediump` in every fragment shader. GLSL ES requires a uniform used in both
   stages to carry the same precision, and the failure is at *link* time — not
   a compile error, not a warning, and not something reading either shader
   alone reveals. `precision.test.ts` now catches the whole class statically.

2. **Every album cover rendered upside down.** An image's first row is its top;
   a texture's first row is its bottom, and `UNPACK_FLIP_Y_WEBGL` was never
   set. No headless test can see this, because nothing in one has an up. It
   looks deliberate on an abstract sleeve and absurd on one with a face on it.

That is the whole argument for CLAUDE.md's prototype-in-a-page rule, made
concretely: the target is a browser, so a published page runs the same GLSL the
Pi will. Neither bug was a shader being ugly. Both were a shader not running.

## Why the covers are generated

Every effect here reads the artwork, and a published page has no network
guarantee — a cover that fails to load makes the entire library look broken
while it is behaving correctly.

## What the numbers in the readout mean

- **fps** on whatever is running the page. Not a Pi 5 measurement; P3-01 is.
- **scale** is the render scale the degrader has settled on. Below 1.00 means it
  is dropping resolution to hold the budget (P5-14).
- **passes** is the scaled chain only. Overlays draw after the upscale and are
  not counted (D-062).
- **tier** is which reactivity provider is driving. Tap four times for Tier 1.
