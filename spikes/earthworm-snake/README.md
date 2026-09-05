# Spike: Nightcrawler — Snake as an earthworm

A finished, dependency-free browser game. **Open `index.html` in any browser.**
No build step, no network calls except the Google Fonts stylesheet.

Built at the user's request ("build the game snake but have the snake be an
earthworm"). It is not a tracker task and closes no product gap — it lives here
because per `CLAUDE.md` anything visual gets prototyped as a page first, and
because the container is not storage.

## The design premise

Snake with a reskin is a worm-shaped snake. The premise here is that the *board*
becomes the animal's world: the grid is a 40 cm soil profile in cross-section,
2 cm per row, with real O/A/B horizons drawn and labelled down a depth ruler.
Every rule falls out of that instead of being inherited from Snake:

| Snake | Nightcrawler | Why |
|---|---|---|
| Walls kill on all four sides | Left/right **wrap**; top and bottom kill | Soil continues sideways. Above is air, below is bedrock. |
| Food spawns uniformly | Leaf litter is **weighted toward the surface** | Organic matter really does collect in the O horizon — so the food is where the lethal edge is. That's the whole risk curve. |
| Grows by one | Grows by **three** | Worms get long, not fat. |
| Trail is invisible | Every cell tunnelled stays **loosened**, permanently | The burrow network is the run's record — and aeration is what the animal is actually for. |
| — | A **pebble** works into the profile every 5 leaves | Escalation that belongs to soil, not to an arcade cabinet. |
| — | **Fungal hyphae** appear every 4th leaf and rot after 46 steps | A timed bonus with a reason to exist. |

Death copy is specific rather than generic: surfacing gets you a robin, the
bottom edge is bedrock, and self-collision notes that a worm has no eyes and
maps its burrow by touch.

## Techniques worth keeping

**The worm is one filled polygon of variable half-width**, not a chain of
circles or a fixed-width stroke. Per segment, take the local tangent from
`pos[i+1] - pos[i-1]`, get the normal, and emit a left/right pair offset by a
half-width that varies:

```js
let w = cell * 0.33;
if (fromTail < 4) w *= 0.42 + fromTail * 0.145;   // taper
if (i >= clitStart(n) && i < clitStart(n) + 3) w *= 1.20;  // clitellum
w *= 1 + 0.13 * Math.sin(phase - i * 0.62);       // peristalsis
```

Fill `left[0..n]` then `right[n..0]` as one closed path. That single trick buys
the taper, the clitellum swelling, and a peristaltic wave travelling head-to-tail
— which is how the animal actually moves. A lit stroke on the left edge and a
shaded one on the right make it read as a cylinder.

**Wrap-safe interpolation.** Rendering lerps between `prevWorm` and `worm` each
step for smooth glide at a 78–150 ms tick. At the wrap seam, adjust each
segment's previous x by ±COLS so it slides *off* the edge, then split the body
into runs wherever consecutive rendered positions are more than 1.6 cells apart
and draw each run separately. Without the split you get a stripe across the plate.

**Bake the static earth once.** Horizon fills, ~8 grit specks per cell from a
deterministic `hash(x, y)`, wobbling bedding lines, and a daylight gradient all
render to an offscreen canvas on resize only. Per-frame noise boils; baked noise
looks like dirt.

**Fractional cell size** (`cell = width / COLS`, not `floor`) so the board fills
its container edge to edge with no seam. DPR scaling is applied on the context.

## What the first render pass got wrong

Worth recording, since all three are easy to repeat:

1. **The vignette was at 0.45 alpha** — it ate the lower half of the profile, the
   grain disappeared, and the A/B boundary read as a black bar. Now 0.22, with
   every soil colour lifted a stop.
2. **Burrow cells were drawn inset at 0.68 of a cell**, so they rendered as
   detached black blobs instead of a connected tunnel. Full-cell rounded rects at
   0.20 alpha touch their neighbours and read as corridors.
3. **The clitellum was pinned to segment indices 6–10.** On a short worm that is
   the tail. It is now placed proportionally (`~22%` of body length), which is
   also where it sits on a real *Lumbricus*.

## If it ever becomes a Joshify feature

Candidate for an idle/screensaver easter egg only. The swipe input and the
touch-sized targets already suit the Pi's touchscreen, and it holds 60 fps on
one 2D canvas with no libraries. It would go in `docs/THEMES.md` as a backlog
item, not into `docs/TRACKING.md` — Phases 1–4 are the product (D-019).
