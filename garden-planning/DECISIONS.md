# Garden — Decision Log

Lightweight ADRs. One entry per non-obvious choice, so future-us knows *why*.

Format: **What we chose · Why · What it costs us · Status**

Status key: ✅ Accepted · 🔬 Proposed (needs Josh's OK) · ⚠️ Revisit later

---

### D-001 · A separate repository, not part of joshify
**Chose:** `JoshHambright/garden`, its own repo.
**Why:** Joshify is a Raspberry Pi Spotify appliance. Sharing a repo would mean
sharing a CLAUDE.md, a roadmap, a tracker and a CI pipeline with a project that
has nothing in common with this one.
**Costs:** Tooling set up twice.
**Status:** ✅ Accepted — *blocked on repo creation; the session's GitHub app
returns 403 on `POST /user/repos`, so Josh has to create it manually. Planning
docs are staged on the `claude/garden-planning-app-xhc4mx` branch of joshify in
the meantime, under `garden-planning/`, and must never be merged to joshify main.*

---

### D-002 · Local-first, sync later
**Chose:** All data in the browser (IndexedDB). No account, no server in v1. Sync
and sharing are later phases.
**Why:** The garden has no signal. An app that needs the network to record a
harvest doesn't get used to record harvests, and every history feature in the
product depends on the record being complete. Local-first makes offline the
default state rather than a mode to be engineered.
**Costs:** No cross-device use until Phase 9. Data lives in one browser profile
until then, so JSON export in Phase 4 is the backup story and is not optional.
Browser storage can be evicted — needs `navigator.storage.persist()` and a
visible warning if it's denied.
**Status:** ✅ Accepted

---

### D-003 · A Planting is time-ranged, not a point in time
**Chose:** `Planting` carries a date range and a status, and the bed map is a
query over it (`today ∈ range`) rather than a stored state.
**Why:** It's the difference between an app that can answer "what's in bed 3" and
one that can answer "what was in bed 3 last August." Succession, rotation,
history and the occupancy timeline all become views over one model instead of
four separate features.
**Costs:** Every read of "what's in this bed" is a date-filtered query, not a
field lookup. Needs an index and a small amount of discipline.
**Status:** ✅ Accepted

---

### D-004 · Square-foot grid in v1, real coordinates in the model from day one
**Chose:** v1 places plants in 1 ft cells. `Planting` reserves an alternative
`{x, y, radiusMm}` shape so free placement is additive in v2.
**Why:** The grid is dramatically easier to build, far easier to hit with a
thumb, and gives spacing validation for free. But if v1 stores only cell indices,
free placement later is a data migration rather than a feature.
**Costs:** Sprawling and irregular plantings are approximated in v1. Cell size is
per-bed (`gridCellMm`) to take some of the edge off.
**Status:** ✅ Accepted

---

### D-005 · Derived dates, stored as values
**Chose:** Planting dates are computed from frost dates and days-to-maturity at
creation, then **stored** and freely editable — not recomputed on read.
**Why:** Derivation is the point (PRODUCT §5.2), but recomputing on read means a
later correction to a variety's `daysToMaturity` silently rewrites what you did
in 2024. History has to be immutable to be worth keeping.
**Costs:** A plan made before a catalog correction keeps the old dates. Correct,
but needs a "recompute this plan" affordance so it isn't a trap.
**Status:** ✅ Accepted

---

### D-006 · Bundled plant catalog, no external plant API
**Chose:** Ship a curated, versioned JSON catalog of common varieties in the app.
User additions are marked `isCustom` and survive catalog updates.
**Why:** The available plant-data APIs are variously unmaintained, rate-limited,
inconsistent about days-to-maturity, or unclear on licensing. More decisively: an
external dependency in the catalog breaks D-002 — you'd need the network to plan.
**Costs:** We maintain the catalog. Starts small and grows from real use, which
is honest — a curated hundred varieties beats a scraped ten thousand with bad
spacing numbers.
**Status:** ✅ Accepted

---

### D-007 · One `Event` table, discriminated by kind
**Chose:** Harvests, observations, pest sightings, treatments, amendments and
photos are all `Event` rows with a `kind` and a `payload`.
**Why:** Every one of them is "something that happened at a time, attached to
something, possibly with photos." The most-wanted screen in the app is a bed's
timeline; with a table per kind that's a seven-way union query forever.
**Costs:** `payload` is loosely typed at the storage boundary. Mitigated by a
discriminated union in TypeScript and validation on write.
**Status:** ✅ Accepted

---

### D-008 · Last-write-wins sync, no CRDT library
**Chose:** UUIDv7 ids, `updatedAt`, soft deletes — enough for field-level
last-write-wins when Phase 9 arrives. No Automerge, no Yjs.
**Why:** CRDTs solve concurrent editing of a shared document. Two people in one
household are not going to edit the same bed layout in the same second. The
runtime weight and the modelling constraints buy nothing here.
**Costs:** A genuine simultaneous edit loses one side. Acceptable at this scale;
the append-only `Event` log — where most writes happen — never conflicts anyway.
**Status:** ✅ Accepted

---

### D-009 · Metric stored, imperial displayed
**Chose:** Canonical storage in mm and grams. Display defaults to imperial,
switchable per user.
**Why:** Unit conversion at the boundary is a solved problem; unit ambiguity in
the store is a permanent source of bugs. Square-foot gardening is an imperial
idiom and the UI should speak it.
**Costs:** Conversion code and rounding decisions at every input. `gridCellMm`
defaulting to 304.8 looks odd and is correct.
**Status:** ✅ Accepted

---

### D-010 · Svelte + Vite, TypeScript throughout
**Chose:** The same stack as joshify.
**Why:** Josh is actively fluent in it right now; running two concurrent projects
on one stack removes a context switch. The bed editor re-renders a grid on every
drag frame, which is the case where no-virtual-DOM actually shows up.
**Costs:** Smaller ecosystem than React — the drag-and-drop and virtualised list
work is likelier to be hand-built. Given that the bed editor is bespoke either
way, that's a smaller cost here than it looks.
**Status:** 🔬 Proposed — React + Vite is the reasonable alternative if the
ecosystem argument wins.

---

### D-011 · Phases follow the season, not just dependencies
**Chose:** In-season logging (Phase 4) ships before winter starts (Phase 5), even
though starts happen earlier in the calendar year.
**Why:** Planning starts well requires the record from the previous season. Phase
5 built first would be built blind.
**Costs:** If the build lands mid-winter, the first genuinely useful phase is out
of season. Acceptable — Phase 3's planner is the winter tool.
**Status:** ✅ Accepted

---

### D-012 · Native plant data: USDA PLANTS as the base, curated on top
**Chose:** Bundle USDA PLANTS Database state-level nativity (public domain,
downloadable) as the nativity base layer. Hand-curate horticultural attributes —
bloom window, mature height and spread, moisture, sun, division interval — for a
regional shortlist of a few hundred species. Link out to Prairie Moon and the
Lady Bird Johnson Wildflower Center for everything else.
**Why:** USDA PLANTS is the only source that is comprehensive, authoritative,
public domain, and redistributable. What it is *not* is horticultural — it will
tell you *Echinacea pallida* is native to Illinois and nothing about when it
blooms or how far apart to plant it. That gap is exactly the part that has to be
curated, and it's small if scoped to a region.
**Costs:** State-level nativity is coarser than ecoregion. We store
`nativeToRegionIds` as a set so ecoregion data can be layered in later without a
migration, but the v1 badge will say "native to Illinois," not "native to the
Central Corn Belt Plains."
**Open:** Lepidoptera host-plant counts (the Tallamy/NWF "this oak feeds 500
species" data) are the most persuasive numbers in native gardening and the least
cleanly licensed. Treat `hostGenera` as a schema slot we may only be able to fill
by hand for the top ~50 genera.
**Status:** ✅ Accepted

---

### D-013 · Perennials are an occupancy mode, not a flag
**Chose:** `Variety.lifecycle` drives whether a Planting's date range is
open-ended, and the bed occupancy query reserves perennial cells **year-round,
including dormancy.**
**Why:** A dormant coneflower in March is bare soil that is already occupied. If
occupancy is "is there a planting whose range covers today," the planner will
offer those cells for lettuce every single spring. This is the most likely bug in
the app and it's a modelling problem, not a UI problem.
**Costs:** Two occupancy paths instead of one. Rotation checking has to exclude
perennial-purpose beds. The planner needs an explicit "this replaces the existing
planting" gesture rather than silently overwriting.
**Status:** ✅ Accepted

---

### D-014 · Vendor search as adapters with graceful degradation
**Chose:** Per-vendor adapters behind a small server-side proxy, in three tiers:
structured JSON where a vendor's platform exposes it, schema.org product parsing
where it doesn't, and a plain deep link ("search Prairie Moon for *Liatris*")
where neither works. Results are a **cache with a TTL**, never catalog truth.
**Why:** There is no unified seed-vendor API and there isn't going to be. Tiering
means the feature ships useful on day one — a deep link is worth real money to a
gardener comparing four tabs — and gets better per vendor rather than being
blocked on the hardest one. Etsy is the exception with a genuine public API,
gated on app approval.
**Costs:** Adapters break when vendors redesign; this is a maintenance treadmill
and should be scoped to vendors Josh actually buys from. Requires a server, which
is the first crack in D-002 — so sourcing is explicitly an **online-only
enhancement** that never blocks planning.
**Conduct:** Respect `robots.txt`, rate-limit hard, cache aggressively, show
name/price/availability/link only, and send the traffic to the vendor. We are
building a shopping assistant that drives sales to independent seed houses, not
a mirror of their catalogs. Several of these companies run affiliate programs;
that is the relationship to aim for.
**Status:** ✅ Accepted

---

### D-015 · Photo-to-bed is a tracing aid, not an auto-detector
**Chose:** Photograph a bed, tap its four corners, enter one measured edge. A
homography rectifies the image to a top-down plan with real scale, and the grid
lays over it. No automatic edge detection in v1.
**Why:** The valuable half of "build the bed from a photo" is *planning against
what the bed actually looks like* — and that's a perspective transform, which is
about forty lines of well-understood linear algebra and works every time.
Automatic bed-boundary detection from a phone photo is a segmentation problem
against low-contrast subjects (soil, mulch, weathered cedar, shadow) that fails
in ways the user cannot correct. Four taps beats a wrong answer.
**Costs:** Four taps and one tape-measure reading per bed, once. In exchange the
scale is *right*, which no photo-only method can guarantee without a reference
object or depth sensor.
**Later:** Auto-corner-suggestion as an assist on top of the manual tracer — it
can be wrong without being harmful, because the user is already adjusting
handles. Overhead shots (a ladder, a phone on a pole) rectify almost perfectly
and are worth documenting as the recommended technique.
**Status:** ✅ Accepted

---

### D-016 · Derived tasks share the scheduling engine
**Chose:** Task rules can be anchored to planting events — "14 days after
germination," "at first fruit set," "year 4 after planting" — and are generated
by the same date engine that computes planting dates.
**Why:** A to-do list you fill in yourself only ever contains what you already
remembered. A derived task list contains what you *should* have remembered, which
is the entire value proposition. It also means the horticultural knowledge lives
in the variety catalog, in data, rather than scattered through UI copy.
**Costs:** Generated tasks need a lifecycle — regenerate when a planting date
moves, don't resurrect ones already completed or dismissed. Snooze and dismiss
are required from the start, or the list becomes noise and gets ignored.
**Status:** ✅ Accepted

---

### D-017 · Weather-conditional tasks, deliberately deferred
**Chose:** `TaskRule.weatherSkip` exists in the schema from the start; the
behaviour ships with the weather work, not with tasks.
**Why:** "Don't remind me to water if it rained half an inch" is the difference
between a reminder you trust and one you mute. But it depends on a weather
integration we don't have yet, and shipping tasks *without* it is still useful.
Reserving the field means it's a feature later, not a migration.
**Status:** ✅ Accepted
