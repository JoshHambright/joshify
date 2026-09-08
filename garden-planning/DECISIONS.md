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
