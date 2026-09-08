# Garden — Phased Build Plan

Status: `DRAFT v2` · Last updated: 2026-09-08
Companion documents: [PRODUCT.md](./PRODUCT.md) · [DATA_MODEL.md](./DATA_MODEL.md) · [DECISIONS.md](./DECISIONS.md)

---

## How we work

Each phase has an **exit criterion** — a demonstrable, testable thing. We don't
start phase N+1 until phase N's criterion is met and green in CI.

Every phase ships with tests. There is no "testing phase."

**The riskiest unknowns get pulled forward.** Three things could sink this:

- **The bed editor**, including the photo tracing. Hardest interaction in the
  app, most likely to feel wrong on a phone, load-bearing for five later phases.
  It gets a published prototype *before* Phase 1 becomes tasks.
- **Storage volume.** Photos are the bulk of the data, and browser quota and
  eviction rules are easy to discover too late. Phase 0 measures rather than
  assumes.
- **Native plant data quality.** The whole native-first premise rests on data we
  don't have yet. Phase 2 starts with a hard look at what USDA PLANTS actually
  gives us and how much hand-curation the gap costs (D-012).

**Phase order follows the season, not just dependency.** Phases 0–5 make a tool
that's useful for one full year. Winter starts land after the in-season log even
though they happen earlier in the calendar, because you can't plan starts well
without last season's record.

---

## Phase 0 — Foundation

Scaffold, TypeScript, lint, format, tests, CI on every push. A pure domain
package with zero I/O — the scheduling arithmetic, occupancy queries and spacing
maths live there and are the most testable code in the app. IndexedDB layer and
PWA shell.

Then answer the storage question with a measurement: write N downscaled photos,
observe quota behaviour and `navigator.storage.persist()`, decide the per-photo
budget from data rather than a guess.

**Exit:** `verify` green in CI; the app installs to a phone home screen and opens
with the network off; a written per-photo storage budget backed by a measurement.

---

## Spike A — the bed editor and the photo trace *(before Phase 1 becomes tasks)*

A published page opened on Josh's actual phone. Two things to prove:

1. Draw a bed, grid it, place things in cells, pan and zoom, with a thumb.
2. Photograph a real bed, tap four corners, enter one edge length, and see
   whether the rectified top-down image is *good enough to plan on* — including
   from a normal standing-height shot, not just from a ladder.

**Exit:** an approved interaction, plus a written note on what it proved — which
gestures work, what cell size is thumb-reachable, and what camera angle the
homography needs before the result stops being usable.

---

## Phase 1 — Site, beds, and the map

Site with its four geographic facts (DATA_MODEL §2) resolved from a location.
Create, edit, archive beds with real dimensions and a `purpose`. The map: beds
laid out spatially, pan/zoom, tap to select. Bed detail with its grid, over the
traced photo where one exists.

**Exit:** Josh's real garden is entered, and the map is recognisable as his
garden on a phone held outdoors in sunlight.

---

## Phase 2 — Plant library: annuals, perennials, natives

The bundled catalog and its versioning. The nativity data build from USDA PLANTS,
plus curation of the regional shortlist (D-012). Variety browse, search, detail —
filtered by hardiness zone, sun, moisture, lifecycle, and **native to my region**
at the strictness the user chose. Custom varieties. Seed inventory: packets,
bulbs, tubers and bare root, with computed viability from species longevity.

**Exit:** a zone-and-region-filtered browse that returns a genuinely useful
native perennial shortlist for Josh's actual location, and his seed box entered
with correct viability flags.

---

## Phase 3 — Planning and the derived schedule

Place plantings into cells. Spacing validation. The scheduling engine from
DATA_MODEL §5 in both directions — spring anchored to last frost, fall counted
back from first frost. **Perennial occupancy**: open-ended plantings, cells
reserved year-round through dormancy, the planner refusing to place over them
(D-013). Mature-spread projection so a shrub's footprint is a function of its
age. The bed occupancy timeline. Copy a previous season as a starting point.

This is the phase where the app first does something a spreadsheet can't.

**Exit:** a complete plan for one real season, every date derived; the occupancy
timeline correctly shows a bed turning over mid-summer; and the planner refuses
to put lettuce on top of a dormant coneflower in March.

---

## Phase 4 — The in-season log

Planting lifecycle transitions. Harvest logging on the shortest possible path —
designed to a tap count, not a feature list. Photos, including shots from a bed's
photo point. Free-text observations. Bloom events. The "ready now" queue. Full
JSON export as the backup story.

**Exit:** a harvest is logged in under three taps from a cold app launch,
offline, one-handed.

---

## Phase 5 — Tasks and reminders

One-off, recurring, and **derived** tasks — the third generated from plantings by
the same date engine (D-016). Today / this week / overdue views, which become the
app's in-season home screen. Snooze and dismiss from the start. Notification
config: which categories notify, lead time, quiet hours, digest versus per-task.
`weatherSkip` reserved in the schema, behaviour deferred to Phase 9 (D-017).

**Exit:** a week of real tasks arrives correctly — including at least one derived
task the app knew about and Josh didn't — with notifications firing on a phone
with the app closed.

> **Phases 0–5 are a genuinely useful app for a full year.** Everything after
> this compounds on the record they produce.

---

## Phase 6 — Winter starts, succession, and sourcing

Seed-starting calendar computed backward from transplant dates. Trays and cells,
germination rate per sowing, hardening-off. Succession as one action generating a
series. The seed order list, driven by the gap between the plan and the
inventory.

Then **sourcing** (D-014): search a variety across independent seed houses and
Etsy, with the three-tier adapter strategy. This introduces the first server
component — a thin proxy for CORS, caching and rate limiting — and it is
explicitly an online-only enhancement that never blocks planning.

**Exit:** a full winter start schedule generated from a season plan; and a "seeds
I need" list that returns live prices and stock from at least three real vendors,
degrading to deep links for the rest, with the app still fully usable offline.

---

## Phase 7 — History, analysis, and the bed time-lapse

Per-bed history across years. Yield per bed, per square foot, per variety.
Variety verdicts, prompted at end of season. Rotation heatmap by family, feeding
warnings back into Phase 3 — annual beds only. Bloom-succession analysis: where
are the gaps in the flowering calendar. **The bed photo time-lapse**: every shot
from a bed's photo point, aligned and scrubbable across a season and across
years.

**Exit:** the planner argues when you put a nightshade where a nightshade grew
last year, from real recorded history; and a bed's photo point plays back a
season in one gesture.

---

## Phase 8 — Sharing and output

Printable season plan. QR bed stakes that deep-link to a bed. Read-only share
links for a season or a bed. Extends the Phase 6 server rather than introducing
a new one; scope is deliberately the smallest thing that publishes a snapshot.

**Exit:** a stake in the ground, scanned with a phone camera, opens that bed; and
a link sent to someone without the app shows them the season.

---

## Phase 9 — Environment and research

Weather: frost warnings, rainfall, growing-degree-days per planting, and the
`weatherSkip` behaviour that makes watering reminders trustworthy. Pest and
disease log with treatments and whether they worked. Soil tests and amendments.
Side-by-side variety trials.

**Exit:** a frost warning arrives in time to cover the peppers, and a watering
reminder correctly suppresses itself after real rain.

---

## Phase 10 — Sync and multi-user

Accounts, and field-level last-write-wins sync against the `id` / `updatedAt` /
`deletedAt` discipline from DATA_MODEL §6. Partner edit access.

Deliberately last. Everything before works without it, and by now the model has
survived a real year — the only honest way to know what syncing it should mean.

**Exit:** a harvest logged on a phone in the garden appears on the laptop, and
offline edits on both devices reconcile without data loss.

---

## Not scheduled

Automatic bed-boundary detection (D-015), aggregate community data,
cost-vs-yield, irrigation logs, compost batches, polygon bed shapes, multiple
draft plans per season, plan import as a template. All carry a tier in
PRODUCT.md §7. Recorded, not deleted.
