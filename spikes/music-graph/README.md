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

## The query language

Terms are ANDed; a leading `-` negates; a bare word matches names.

```
type:album,song          entity kind, comma = or
rel:produced             participates in an edge of this kind
year:1991..1994          also year:>1990, year:<1980, year:1991
deg:>7                   connection count
name:albini              substring on the name
near:"Steve Albini"~2    within N hops (default 1)
path:"Kurt Cobain"->"Josh Homme"    shortest route, drawn on the graph
```

`near:` and `path:` walk only the relationship types currently enabled in the
left rail, so turning off `issued by` stops routes tunnelling through record
labels — which is usually what you want, because a label connects everything to
everything.

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

**Slider extremes mean "unbounded".** The year filter spans the era the corpus
lives in (1950–2010), not its literal min/max — a single 1870 traditional song
would otherwise waste 60% of the slider's travel. At either end the bound is
dropped entirely, so the outliers stay visible at rest. The first build got this
wrong and silently hid nine entities, including both ends of the best path in
the dataset.

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
- **No editing of baseline entities.** You can add and connect, and remove your
  own additions, but you cannot rename a corpus entity — the overlay supports it,
  the UI doesn't expose it.
- **No import.** Export writes JSON; there is no matching paste-to-load.
- **Force layout is still a hairball at rest.** The query language, not the
  default view, is how you actually find anything. That is the honest finding,
  and it is why the filters came before the prettiness.
