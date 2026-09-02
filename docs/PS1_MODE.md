# Joshify — PS1 / N2O Visual Mode

Status: `DRAFT v1` · Last updated: 2026-09-02
Spike: [`spikes/n2o-tunnel/`](../spikes/n2o-tunnel/) · Design: [VISUALIZER.md](./VISUALIZER.md)

---

## The thesis

**Winamp and the PlayStation 1 are the same era.**

- Winamp 2 — **1998**
- N2O: Nitrous Oxide — **1998**
- Milkdrop — **2001**

This isn't two aesthetics mashed together. It's one cultural moment: the late-90s
consumer-digital look, back when 3D was new enough to be strange and constrained
enough to have a signature. Building the visualiser *and* the interface out of the
same year is what will make the finished object feel **authored rather than themed**.

That's the whole argument for taking this seriously instead of shipping it as one
more preset.

## The reference

**N2O: Nitrous Oxide** (Gremlin Interactive, 1998) — a tube shooter with a
soundtrack by The Crystal Method, stored on disc as **Red Book audio**, so the
game disc played in an ordinary CD player.

That era had a related trick, most famously in **Ridge Racer**: the game loaded
itself entirely into RAM, then let you swap the disc for any audio CD and play
your own music over it.

There's a neat symmetry there worth naming. Those games let you **replace the
game's music with your own**. Joshify does the inverse — it takes *your* music and
renders it as the game. Same gesture, pointed the other way.

## Architecture: this is a scene, not a preset

Phase 5 as designed post-processes a **flat 2D album texture** through a shader
chain. A tunnel needs real 3D geometry and a vertex shader — so it doesn't fit
that pipeline as a preset.

The fix is small and improves the engine regardless: insert a **scene stage**
before the post chain.

```
   ┌──────────── SCENE ────────────┐   ┌──────── POST CHAIN ────────┐
   │  flat    — album quad (2D)    │   │  feedback / glitch / VHS   │
   │  tunnel  — PS1 tube (3D)      │──►│  dither / CRT / bars       │──► screen
   │  (future: terrain, starfield) │   │  (unchanged, composes over │
   └───────────────────────────────┘   │   whatever the scene drew) │
                                       └────────────────────────────┘
```

Both stages read the same reactivity uniforms (D-010). Every existing effect keeps
working, and gains the tunnel for free — **so the tunnel can also be datamoshed,
pixel-sorted, or run through VHS wobble.** That combination is the actual prize.

This is an extension, not a rewrite. Logged as **D-014**.

## The six artefacts

Each is a real hardware limitation of the PSX GPU, each is reproducible, and each
is individually toggleable. All six are implemented and verified in the spike.

| # | Artefact | Cause | Reproduction |
|---|---|---|---|
| 01 | **Vertex snap** | The GTE used fixed-point maths with no sub-pixel precision — vertices jumped to whole pixels | Round `ndc.xy` to a coarse grid in the vertex shader |
| 02 | **Affine texture mapping** | No perspective correction; UVs interpolated linearly in screen space, so textures swim | Premultiply UVs by `w`, divide in the fragment shader — cancels the GPU's own correction |
| 03 | **15-bit colour + dither** | 32 levels per channel, ordered dithering to hide banding | `4×4` Bayer matrix, then quantise to 31 steps |
| 04 | **No z-buffer** | Depth sorting was done per-polygon on the CPU; surfaces punch through at glancing angles | `disable(DEPTH_TEST)`, draw back-to-front |
| 05 | **Distance fog** | Short draw distance, hidden behind coloured haze | Fade to a fog colour tinted from the album's extracted accent |
| 06 | **240p output** | Composite video into a CRT | Render to ~`320×180`, upscale `NEAREST` |

Artefacts 03 and 06 were **already in our plan** — Bayer dither was in effect
family C, and half-resolution rendering is D-011. The PS1 doesn't add them; it
explains them.

### The D-011 coincidence

We chose half-resolution rendering because it cuts fragment cost 4× and happened
to look like the lo-fi aesthetic we wanted. It turns out that is *almost exactly*
the PS1's native output resolution.

**The performance dial, the art direction, and the period reference are the same
slider.** That wasn't engineered — the constraint we picked for a Pi is the
constraint Sony picked for a console. It's the strongest signal that this
direction is coherent rather than decorative.

## Interface direction

The PS1 vibe extends past the visualiser into the app chrome:

- **Squared-off techno type**, chunky bevelled controls, high-contrast menu
  language — a UI idiom that is genuinely under-used today.
- **The PS1 BIOS had a built-in CD player screen.** It is a near-perfect
  reference for our Now Playing view: a machine designed to look good doing
  exactly one thing on a television across a room.
- An **attract / boot sequence** on cold start, which is also useful cover for
  the boot-to-app handoff in P7-05.

### ⚠️ Homage, not reproduction

The **idiom** of the era is fair game. Specific assets are not.

- ❌ Do not reproduce Sony's boot animation, the diamond logo, the PlayStation
  wordmark, or any N2O asset. These are trademarked.
- ✅ Do build an **original** boot sequence, menu language and type treatment in
  the era's style.

This costs us nothing creatively — an original sequence in that idiom will be
better than a copy anyway — but it needs to be a stated rule rather than a thing
we drift into. Logged as **D-015**.

## What the spike settled

The prototype in [`spikes/n2o-tunnel/`](../spikes/n2o-tunnel/) is a complete,
dependency-free WebGL2 implementation. It confirms:

- All six artefacts work in GLSL and are individually toggleable.
- Album art tiles convincingly as a tunnel texture at 256px / `NEAREST` / `REPEAT`.
- Live accent extraction from the cover drives fog and beat flash — the job
  **P3-03** does server-side on the Pi.
- The **Tier 1** beat formula (`pow(1-phase,4)`, phase-locked to BPM) feels right
  at real tempos.
- Cost is trivial: **one draw call, ~1600 vertices, no libraries.**

Still open: it has not run on Pi hardware. That's **P5-30**, folded into the
P3-01 measurement.
