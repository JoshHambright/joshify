# Spike: Patchbay — a musician relationship graph

An interactive node diagram over a corpus of musicians, bands, albums, songs,
studios, instruments, tours and labels, with filtering, a query language and
shortest-path search.

**Open `index.html` in any browser.** No build step, no dependencies, no network
calls except Google Fonts. Published for review at the artifact link in the
session; the source lives here so it survives the container.

## Scope note

This is **not a Joshify tracker task.** Joshify is a touchscreen Spotify remote
(D-019: phases 1–4 are the product). This is a separate tool that happens to
share the repo and the visual-prototype-first workflow from D-016. It is
deliberately absent from `docs/TRACKING.md`. If it graduates into its own app it
gets its own tracker, not a phase in Joshify's.

## Visual direction

Vaporwave / cyberpunk, committed to rather than gestured at: a receding neon
plane with a horizon glow, cyan-and-magenta chromatic aberration on the
wordmark, CRT scanlines over the stage, and nodes drawn as glowing tubes.

**There is no light theme, on purpose.** A washed-out vaporwave is a
contradiction, so the page commits to one visual world and paints every colour
explicitly (including `body`'s background) rather than inheriting anything from
the host. What would have been a light/dark switch is instead a **mood switch**
between two dark palettes — NIGHT (indigo ground, cyan and violet) and SUNSET
(plum ground, magenta and orange) — which is a real choice in this idiom rather
than a concession to a convention that does not fit.

Type is the vaporwave/cyberpunk collision made literal: **Bodoni Moda**, a
high-contrast didone, wide-tracked in caps for the wordmark and entity names;
**Chakra Petch**, a techno face, for every control and label; **Share Tech Mono**
for data, years and the query bar. The didone is the "aesthetic" half, the
techno face is the cyberpunk half, and the tension between them is the point.

All of this is original work in the idiom — no reproduced logos, wordmarks or
assets (D-015).

## The corpus

233 entities, 376 typed relationships, one fully connected component — no
orphans, no self-loops. It is a curated slice of the American underground →
alternative web, roughly 1976–2009, chosen so that **studios, producers and
session players carry the interesting edges**: the ones you cannot guess from a
band's own line-up.

| Kind | Count | Kind | Count |
|---|---:|---|---:|
| People | 86 | Studios | 10 |
| Bands | 33 | Gear | 17 |
| Albums | 45 | Tours | 7 |
| Songs | 24 | Labels | 11 |

Fifteen relationship types, in three visual families:

- **solid** — structural: `member of`, `released`, `track`, `recorded at`, `played` (a tour)
- **dashed** — credit: `produced`, `engineered`, `mixed`, `played on`, `wrote`, `issued by`, `founded`
- **dotted** — gear and derivation: `plays`, `used on`, `covers`

Edges are otherwise a single neutral colour. Line style encodes something true
about the relationship; a fifteen-hue edge palette would encode nothing but
itself.

The dataset is a demonstration corpus, not a claim to completeness. Everything in
it is a well-documented credit; where a fact was shaky it was cut rather than
guessed (several edges were removed during the build for exactly this reason).

## What it proves

| Claim | Verified how |
|---|---|
| A canvas force layout handles this scale with no library | 233 nodes, naive O(n²) repulsion, ~22k pairs/tick, 60fps |
| The graph opens composed, not as an exploding blob | 280 sim ticks run synchronously at boot before first paint |
| Filtering feels alive because the layout re-settles | The sim runs only over *visible* nodes; hiding a type re-forms the graph |
| A tiny query language beats a pile of dropdowns | `type: rel: year: deg: near:~N path:A->B`, ~70 lines of parser |
| Degrees of separation is the feature people actually want | BFS shortest path, rendered on the canvas and enumerated in the panel |
| Non-obvious links are the payoff | `Lead Belly → In the Pines → Kurt Cobain → Nirvana → Dave Grohl → Foo Fighters → Josh Freese → Nine Inch Nails → Trent Reznor` |
| It can be a *tracker*, not just a viewer | Additions persist to the artifact `db` capability, shared across viewers |

## Three layouts

One simulation, three arrangements. The switch is in the left rail.

| Mode | What it does | What it is good for |
|---|---|---|
| **Web** | Plain force layout | Honest about the topology, and a hairball. Query your way around it. |
| **Clusters** | Each entity is pulled toward an anchor for its kind | Seeing what the corpus is *made of*, and which connections cross between kinds |
| **Timeline** | Horizontal position is the year; springs sort out the vertical | Seeing the era — the gear tail running back to the fifties, the mass piling up in 1988–1995 |

Two details make the timeline mean anything:

**People sit at their first credit, not their birth.** A person's `year` is a
birth year, which would strand them decades to the left of everything they made.
On the timeline every person takes the earliest year on any edge touching them,
so Johnny Cash enters this story in 1996 rather than 1932. Everything else keeps
its own date, because an album's year *is* its release.

**Crowding resolves vertically.** Repulsion and springs get their horizontal
component scaled to 0.14 in timeline mode, and the pull toward the year is raised
to 0.22, so entities form real year columns instead of drifting off their date.
It is the beeswarm trick, and without it the "timeline" is just a blob with an
axis drawn under it.

The domain is the visible dated range with a 4th-percentile floor, recomputed
whenever the filters change — so a couple of very old entries (a traditional song
dated 1870, a label founded in 1889) clamp to the left edge instead of squashing
seventy years of music into the right quarter of the screen.

## The query language

Terms are ANDed; a leading `-` negates; a bare word matches names.

```
type:album,song          entity kind, comma = or
rel:produced             participates in an edge of this kind
year:1991..1994          also year:>1990, year:<1980, year:1991
deg:>7                   connection count
src:claude               provenance - corpus, you, or claude
name:albini              substring on the name
near:"Steve Albini"~2    within N hops (default 1)
path:"Kurt Cobain"->"Josh Homme"    shortest route, drawn on the graph
```

`near:` and `path:` walk only the relationship types currently enabled in the
left rail, so turning off `issued by` stops routes tunnelling through record
labels — which is usually what you want, because a label connects everything to
everything.

## Growing the graph with Claude

The corpus is one person's slice of one scene. **Expand**, on any entity, asks
Claude for that entity's other connections *in this schema* and shows them as a
list you approve row by row. Nothing is written until you tick and keep. Searching
a name that isn't here offers the same thing, so you can start from a band you
care about rather than one I picked.

Three things make it a tool rather than a slot machine:

**The prompt hands over the graph, not just the name.** It sends the focus
entity, every connection already recorded for it (with "do not repeat these"),
the full list of entity kinds and relationships, and every name currently in the
graph with an instruction to reuse them character-for-character. That last part is
what stops a second "Sound City" appearing beside the first.

**Everything is validated before you see it.** In testing, six proposed edges came
back and two survived: one duplicated a fact already in the corpus, one pointed at
an entity that resolves to nothing, one invented a relationship name, one was a
self-loop. Proposed entities that no surviving edge references are dropped too, so
the review list has no orphans in it. What you approve is the intersection of what
Claude said and what the schema can actually hold.

**Provenance is permanent.** Anything kept is stamped `src: "claude"` — a dashed
ring on the graph, "suggested" in Your changes, `src:claude` as a query, a
`source` field in the export. A generated fact never quietly becomes a curated
one, and `src:corpus`, `src:you` and `src:claude` are three separately filterable
populations. Suggested rows are ordinary overlay rows otherwise: editable,
revertable, exportable.

Ticking an edge pulls in the entities it needs even if you left their rows
unticked — an edge without both ends is not a thing you can keep.

The page declares the `sample` capability; where it isn't granted, `claude.use`
returns null and the Expand control simply does not render.

## Editing, and getting data in and out

The corpus ships in the page as content; everything you change lives in an
**overlay** keyed by entity id, merged over that baseline at build time. One
mechanism covers three cases, which is why correcting a fact and inventing one
are the same operation:

| You do | The overlay holds | Undo |
|---|---|---|
| Add an entity or connection | a new row | drop the row |
| Edit one from the corpus | a row under the corpus id, which wins the merge | drop the row, and the original returns |
| Delete one from the corpus | a tombstone | drop the tombstone |

Every entity is editable, not just the ones you added — kind, name, year, note —
and while an entity is in edit mode each of its connections grows a × so wrong
edges can go too. **Your changes** in the Add tab lists every add, edit and
deletion with a one-click revert, and an undo-all. Nothing you do is destructive
to the corpus: the baseline is in the file, so the worst case is a stack of
overlay rows you can throw away.

**Import** takes what Export writes — `{"nodes": […], "edges": […]}` — by file or
paste. Rows are resolved by id where one is given and by name otherwise, so an
export from a different copy still lands on the right entities. Rows identical to
the shipped corpus are counted and skipped rather than written: importing your own
export of 610 rows writes only the handful that are actually yours, instead of
minting 610 redundant documents against the store's 5,000-document quota. Bad
rows (no name, unknown kind, an endpoint that resolves to nothing) are skipped and
counted rather than failing the whole file.

## On a phone

The desktop layout does not survive a 390px screen, so below 820px it is a
different interface over the same engine:

- **The inspector is a bottom sheet**, not a side drawer. A 292px drawer over a
  390px screen hides the graph you just tapped, which defeats the point.
- **A tap shows a one-line peek** — kind, name, year, connection count — and the
  sheet opens only when you ask for it. Auto-opening a full-height panel on every
  tap makes exploring impossible.
- **Two rows in the header** below 700px: wordmark and controls, then the query
  field full width. As one row it overflowed the viewport, which pushed the Dim
  and Panel buttons off-screen entirely — the inspector was simply unreachable —
  and stretched the layout to 539px so `fit()` threw most of the graph outside
  the visible area. That was the actual bug; everything else here is comfort.
- **Pinch to zoom and two-finger pan**, tracked through the same pointer handlers
  as the mouse. `touch-action: none` on the canvas means the page hands us the
  gesture and we owe it an implementation.
- **Double-tap replaces double-click** to focus a node's two-hop neighbourhood;
  `dblclick` is unreliable on touch.
- **Touch gets a 20px catch radius** against the cursor's 6px, and hit-testing
  uses the same `drawR` clamp as rendering, so what you can tap is what you see.
- Bigger controls, `16px` on the query input so iOS does not zoom on focus, and
  `overscroll-behavior` pinned so the sheet does not drag the page.

## Techniques worth keeping

**Simulate only what's visible.** `applyFilters()` sets `vis` on nodes and
edges; `tick()` iterates the visible subset. Filtering therefore *re-lays-out*
rather than just hiding, which is what makes a type toggle feel like an answer
instead of a subtraction.

**Two-pass edge drawing.** Ordinary edges first, highlighted ones second, so the
lit path always sits on top without sorting the array.

```js
for (const pass of [0, 1])
  for (const e of edges) { if ((pass === 1) !== hot) continue; /* … */ }
```

**Label budget by zoom and degree.** `thresh = k > 1.5 ? 0 : k > 0.9 ? 4 : 9` —
plus an always-on set for the selection, its neighbours and any active path.
Labels get a `--canvas-bg` backplate so they stay legible over edges.

**Node size is a world value but a screen measurement.** Radii feed the force
layout in world units, so they must live there — but drawing with them means a
zoomed-in node inflates into a blob and a zoomed-out one vanishes. The fix is one
line at the draw call:

```js
const drawR = (n) => Math.max(3 / S.k, Math.min(n.r, 26 / S.k));
```

Hit-testing and label placement use the same function, so what you can click is
always what you can see. This was invisible until the neon halos went on — at
2.5× the node radius, the zoom bug turned four selected nodes into four
overlapping discs.

**The atmosphere has to lose.** The first neon pass drew the grid at 0.42 alpha
and haloed all 233 nodes equally; the result was a pretty haze you could not read
a graph out of. Grid down to 0.26, scanlines to 0.34, halos to 0.10 alpha except
on lit nodes, edges brightened. The scenery reads as scenery in a still frame and
gets out of the way the moment you look for data.

**Labels are placed in screen space, and collisions are dropped.** Candidates are
sorted — selection, hover, path, neighbours, then by degree — and each is tested
against the rects already placed; a clash means the label is skipped, not
squeezed. World-space label sizing looks fine at the desktop's `k ≈ 1` and falls
apart at the `k ≈ 0.36` a phone opens at, where every neighbour name lands in the
same pile of plates. The same guard quietly improves the desktop hairball.

**Slider extremes mean "unbounded".** The year filter spans the era the corpus
lives in, not its literal min/max — a single 1870 traditional song would
otherwise waste 60% of the slider's travel. At either end the bound is dropped
entirely, so the outliers stay visible at rest.

This one has now been wrong twice, in opposite directions. First a hardcoded
1954 floor silently hid nine entities, including both ends of the best path in
the dataset. The fix computed the floor as `Math.min(1950, YMIN)` — which is
`1870` whenever the data reaches back past 1950, so the slider went right back to
spanning the full 153 years it was meant to avoid. It reads correctly and is
backwards; it took building the timeline, which draws the same bounds as a visible
axis, to notice. `Math.max` is the answer. A bound you cannot see is a bound you
cannot check.

**Overlay persistence, not seeded rows.** The corpus ships in the page as
content. The `db` capability holds only an *overlay* — added, edited and
tombstoned records keyed by id — merged over the baseline in `buildGraph()`.
Consequences: the file works offline with no store, published viewers get live
shared editing, and nothing races to seed a store on load.

## Known limits

- **O(n²) repulsion.** Fine to roughly 600 nodes. Past that it needs a
  Barnes–Hut quadtree or a grid.
- **One shortest path.** BFS returns the first route it finds; ties are
  arbitrary and there is no "show me all paths of length 3".
- **No merge conflict handling.** Two people editing the same entity is
  last-writer-wins, like everything else in the store. Fine for a few people,
  wrong for a crowd.
- **Suggestions are unverified.** Validation checks that a row *fits the schema
  and is not a duplicate*, which is not the same as checking it is true. The
  review list is the verification step, and `src:claude` exists so you can always
  ask what you have not checked yet.
- **Import trusts the file's relationship vocabulary.** An unknown `rel` is
  skipped rather than mapped or created, so a graph built with different
  relationship names imports as entities with no connections.
- **The phone still opens on a hairball**, just a legible one. Below about 0.4
  zoom the graph is a texture, and the query language is how you actually get
  anywhere.
- **Web mode is still a hairball**, and always will be — that is what 233 nodes
  and 376 edges look like without an opinion imposed on them. Clusters and
  Timeline are that opinion. The query language is still how you find one
  specific thing.
- **The two reading layouts each hide something.** Clusters throws away the
  topology's shape; Timeline throws away everything except the year. Neither
  replaces Web, which is why the switch stays visible rather than picking a
  default for you.
