# Spike: Nightcrawler — Snake as an earthworm

A finished, dependency-free browser game, set and drawn as a leaf from a
Victorian natural-history text. **Open `index.html` in any browser.** No build
step, no network calls except the Google Fonts stylesheet.

Built at the user's request ("build the game snake but have the snake be an
earthworm"). It is not a tracker task and closes no product gap — it lives here
because per `CLAUDE.md` anything visual gets prototyped as a page first, and
because the container is not storage.

## The visual premise

The reference is the actual Victorian literature on the subject: Darwin's *The
Formation of Vegetable Mould through the Action of Worms* (John Murray, 1881),
his last book, which is about earthworms and the soil they make. So the page is
a leaf from that kind of book — running head and folio, drop cap, double-ruled
plate with an italic *Fig. 1* caption, a ruled table of observations, a footnote
— and the artwork is a hand-coloured engraving rather than a lit scene.

Concretely, what "engraved" means here:

- **No filled shapes.** Tone comes from stipple density and hatching, which is
  how a plate was darkened before halftone. The three beds differ by dot count
  and dot size (6 coarse / 15 medium / 27 fine per cell), and the subsoil takes
  a second set of lines laid at an angle, crowding with depth.
- **The burrow is a void the engraver leaves un-inked** — lighter than the
  ground, not darker. This is the one inversion that makes the whole plate read
  as a print.
- **Two hand-tints only**, laid inside the line the way a colourist worked: pale
  flesh on the worm, sage on the leaves. Everything else is sepia ink on paper.
- **The scale is in inches**, because Darwin measured in inches. Twenty rows,
  twenty inches, with the beds named *Litter*, *Vegetable mould*, and *Subsoil*
  — the period terms, not the modern O/A/B.
- Vermilion appears exactly once, in the swelled rule under the title. Two-colour
  title pages were common; spending the second colour anywhere else cheapens it.

## The rules premise

Snake with a reskin is a worm-shaped snake. The premise here is that the *board*
becomes the animal's world, and every rule falls out of that instead of being
inherited from Snake:

| Snake | Nightcrawler | Why |
|---|---|---|
| Walls kill on all four sides | Left/right **wrap**; top and bottom kill | The mould continues at either hand. Above is open air, below the subsoil ends. |
| Food spawns uniformly | Leaf litter is **weighted toward the surface** | Leaf-fall really does collect in the top inches — so the food is where the lethal edge is. That's the whole risk curve. |
| Grows by one | Grows by **three** | Worms get long, not fat. |
| Trail is invisible | Every cell tunnelled stays **loosened**, permanently | The burrow network is the run's record — and aeration is what the animal is actually for. |
| — | A **pebble** works into the section every 5 leaves | Escalation that belongs to soil, not to an arcade cabinet. |
| — | **Fungal hyphae** appear every 4th leaf and rot after 46 steps | A timed bonus with a reason to exist. |

Death copy is written in the register of the book: surfacing gets you a thrush,
the bottom edge is where the section ends at twenty inches, and self-collision
observes that a worm has no eyes whatever and maps the ground by touch alone.

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

**Outline a union without a boolean library.** The burrow network is drawn as
overlapping circles bridged to their neighbours. To get a single clean outline
around the whole thing, build the path twice: stroke every subpath at 2.3px, then
fill the same path with paper on top. The fill covers every interior stroke and
leaves only the outer half of each — a union outline, in nine lines and no
geometry. The same trick works for any blobby union on a 2D canvas.

**Bake the static earth once.** Horizon fills, ~8 grit specks per cell from a
deterministic `hash(x, y)`, wobbling bedding lines, and a daylight gradient all
render to an offscreen canvas on resize only. Per-frame noise boils; baked noise
looks like dirt.

**Fractional cell size** (`cell = width / COLS`, not `floor`) so the board fills
its container edge to edge with no seam. DPR scaling is applied on the context.

## What the render passes got wrong

Worth recording, since these are all easy to repeat.

From the first (dark, lit-scene) version, since abandoned:

1. **The vignette was at 0.45 alpha** — it ate the lower half of the section and
   the grain disappeared entirely.
2. **The clitellum was pinned to segment indices 6–10.** On a short worm that is
   the tail. It is now placed proportionally (~20% of body length), which is also
   where it sits on a real *Lumbricus*.

From the engraved version:

3. **Square burrow cells outlined at their exposed edges** produced a machined,
   rectilinear duct — a floor plan, not a burrow. Replaced with the rounded union
   described above.
4. **The roots ran the full height of the plate at one line weight**, which read
   as fissures in the paper rather than roots. Now three instead of five, shorter,
   and drawn segment by segment so the line thins toward the tip.
5. **The taper ran over four of the six starting segments**, so a new worm read
   as a wedge rather than an animal. Cut to three segments and made shallower.

## If it ever becomes a Joshify feature

Candidate for an idle/screensaver easter egg only. The swipe input already suits
the Pi's touchscreen, and it holds 60 fps on one 2D canvas with no libraries —
the expensive drawing (soil, burrow) is baked to offscreen canvases and only
rebuilt when it changes. It would go in `docs/THEMES.md` as a backlog item, not
into `docs/TRACKING.md` — Phases 1–4 are the product (D-019).

The engraving techniques may be worth more than the game: the stipple-by-density
approach and the union-outline trick would both carry into a period visual theme
for the visualiser, and neither needs a shader.
