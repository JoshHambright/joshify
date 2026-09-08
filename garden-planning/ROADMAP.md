# Garden — Phased Build Plan

Status: `DRAFT v1` · Last updated: 2026-09-08
Companion documents: [PRODUCT.md](./PRODUCT.md) · [DATA_MODEL.md](./DATA_MODEL.md) · [DECISIONS.md](./DECISIONS.md)

---

## How we work

Each phase has an **exit criterion** — a demonstrable, testable thing. We don't
start phase N+1 until phase N's criterion is met and green in CI.

Every phase ships with tests. There is no "testing phase."

**The riskiest unknowns get pulled forward.** Two things could sink this project:

- **The bed editor.** It's the hardest interaction in the app, it's the one most
  likely to feel wrong on a phone, and it's load-bearing for four later phases.
  It gets a published prototype *before* Phase 1 turns into tasks.
- **Storage volume.** Photos are the bulk of the data and browser storage has
  quotas and eviction rules that are easy to discover too late. Phase 0 measures
  it rather than assuming.

**Phase ordering follows the calendar, not just dependency.** Phases 0–4 make a
tool that's useful for one full season. Phase 5 (winter starts) is deliberately
after the in-season log even though it happens earlier in the year, because you
can't plan starts well without the record from the season before.

---

## Phase 0 — Foundation

*Goal: an empty but rigorous repo, and one hard question answered.*

Scaffold the project, TypeScript config, linting, formatting, tests, CI on every
push. Establish a pure domain package with zero I/O — the scheduling arithmetic
and spacing maths live there and are the most testable code in the app. Stand up
the IndexedDB layer and the PWA shell.

Then measure the storage question: write N downscaled photos, confirm the quota
behaviour, and decide the per-photo budget from data.

**Exit criterion:** `verify` (lint + typecheck + test + build) green in CI on a
placeholder module; the app installs to a phone home screen and opens with the
network off; a written per-photo storage budget backed by a measurement.

---

## Spike A — the bed editor *(before Phase 1 becomes tasks)*

A published page, opened on Josh's actual phone: draw a bed, divide it into a
square-foot grid, place things in cells, pan and zoom, with a thumb. Iterate on
feedback until it feels right.

**Exit criterion:** an approved interaction, and a short written note on what it
proved — which gestures work, what cell size is thumb-reachable, whether the map
is a screen or a component.

---

## Phase 1 — Beds and the map

*Goal: your actual garden, on your phone.*

Site with frost dates. Create, edit, archive beds with real dimensions. The map
view: beds laid out spatially, pan/zoom, tap to select. The bed detail view with
its grid.

**Exit criterion:** Josh's real garden is entered, and the map is recognisable as
his garden on a phone held outdoors.

---

## Phase 2 — Varieties and seed inventory

*Goal: know what you could grow, and what you actually have.*

The bundled starter catalog and its versioning. Variety browse, search, detail.
Custom varieties. Seed packets: what's on hand, purchased when, how much left,
and a computed viability indicator driven by species longevity.

**Exit criterion:** Josh's seed box is entered, and the app correctly flags which
packets are past their reliable life.

---

## Phase 3 — Season planning and the derived schedule

*Goal: a plan you didn't have to type dates into.*

Place plantings into bed cells. Spacing validation against `plantsPerCell`. The
scheduling engine from DATA_MODEL §3, in both directions — spring plantings
anchored to last frost, fall plantings counted back from first frost. The bed
occupancy timeline. Copy a previous season as a starting point.

This is the phase where the app first does something a spreadsheet can't.

**Exit criterion:** a complete plan for one real season, every date derived, and
the occupancy timeline correctly showing a bed that turns over mid-summer.

---

## Phase 4 — The in-season log

*Goal: the thing you open standing in the garden.*

Planting lifecycle transitions. Harvest logging on the shortest possible path —
this screen gets designed to a tap count, not a feature list. Photos. Free-text
observations. The "ready now" queue. Full JSON export as the backup story.

**Exit criterion:** a harvest is logged in under three taps from a cold app
launch, offline, with one hand.

> **Phases 0–4 are a genuinely useful app for one season.** Everything after this
> compounds on the record they produce.

---

## Phase 5 — Winter starts and succession

*Goal: February.*

The seed-starting calendar computed backward from transplant dates. Trays and
cells: what's sown in what, germination rate per sowing, hardening-off schedule.
Succession planting as one action that generates a series. The seed order list,
grouped by vendor, driven by the gap between the plan and the inventory.

**Exit criterion:** a full winter start schedule generated from a season plan,
plus a seed order list that reflects what's genuinely missing from the seed box.

---

## Phase 6 — History and analysis

*Goal: the record earns its keep.*

Per-bed history across years. Yield per bed, per square foot, per variety.
Variety verdicts — the grow-again rating, prompted at end of season. Rotation
heatmap by family, and rotation warnings fed back into Phase 3's planner.
Year-over-year comparison.

**Exit criterion:** the planner refuses — or at least argues — when you put a
nightshade where a nightshade grew last year, using real recorded history.

---

## Phase 7 — Sharing and output

*Goal: get it out of the app.*

Printable season plan. QR bed stakes: printed labels that deep-link to a bed.
Read-only share links for a season or a bed. This is the first phase that needs a
server, and its scope is deliberately the smallest thing that publishes a
snapshot — not a sync engine.

**Exit criterion:** a stake in the ground, scanned with a phone camera, opens
that bed; and a link sent to someone without the app shows them the season.

---

## Phase 8 — Environment and research

*Goal: the context around the plants.*

Weather integration: frost warnings, rainfall, growing-degree-days accumulated
per planting. Pest and disease log with treatments and whether they worked. Soil
tests and amendments. Side-by-side variety trials. Push notifications for frost,
seed-start dates and harvest nudges.

**Exit criterion:** a frost warning arrives on the phone in time to cover the
peppers.

---

## Phase 9 — Sync and multi-user

*Goal: two devices, two people.*

Accounts, and last-write-wins field-level sync against the model's `id` /
`updatedAt` / `deletedAt` discipline from DATA_MODEL §4. Partner edit access.

Deliberately last. Everything before it works without it, and by this point the
model has survived a real season, which is the only honest way to know what
syncing it should mean.

**Exit criterion:** a harvest logged on a phone in the garden appears on the
laptop, and an edit made offline on each device reconciles without data loss.

---

## Not scheduled

Aggregate community data, cost-vs-yield accounting, irrigation logs, compost
batches, polygon bed shapes, multiple draft plans per season, plan import as a
template. All in PRODUCT.md §7 with a tier. Recorded, not deleted.
