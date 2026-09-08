# Garden — Product Description

*(working name)*

**Plan, track, and remember a home garden — vegetables, perennials, and plants
native to the place it's actually in. Mobile-first, local-first, offline by
default.**

Status: `DRAFT v2` · Last updated: 2026-09-08

---

## 1. The one-liner

A garden app that lives in your pocket while you're standing in the dirt,
remembers enough about last year to make this year better, and knows the
difference between what will grow here and what belongs here.

## 2. The problem

Garden knowledge is perishable in a way that garden *data* is not. You know in
August that the Sungold outproduced the Black Krim four to one, that the bed by
the fence got shaded out by July, that the bee balm needs dividing. By February —
when you're actually ordering — all of it is gone.

The existing tools split badly into three camps:

- **Planners** that draw a beautiful bed layout in January and are never opened
  again, because logging a harvest takes eleven taps and a signal bar.
- **Journals** that record everything and structure nothing, so the record is
  unqueryable — you can read your notes, but you can't ask them a question.
- **Vegetable-only tools** that treat a perennial border as an annual bed with
  the dates left blank, and have no concept of native range at all.

The interesting product closes the loop: *the plan generates the record, and the
record improves next year's plan* — across a garden that isn't only tomatoes.

## 3. What it is (and is not)

**It is:**
- A **planning tool** — beds, layouts, schedules, succession, seed and plant orders.
- A **field log** — harvests, blooms, observations, photos, problems, in one tap.
- A **memory** — every planting you've made, queryable by bed, variety, family,
  region and year.
- **Regionally opinionated** — it knows your zone, your frost dates and your
  ecoregion, and it uses all three.

**It is not:**
- A social network. Sharing is a link you send, not a feed you scroll.
- A farm management system. No labour costs, no CSA shares, no compliance.
- An identification app. It won't tell you what that bug is.
- A vendor's storefront. Sourcing sends you *to* independent growers, it doesn't
  replace them.
- Dependent on a service being up. It plans and logs in airplane mode, in a field.

## 4. Who it's for

One gardener with a mixed home garden: raised beds of annual vegetables, plus
perennial and native plantings — borders, a pollinator patch, fruit, bulbs. Home
scale: 4–20 beds, tens to low hundreds of varieties. A partner with edit rights,
eventually. Not market-garden scale, and the model shouldn't pretend otherwise.

The native-plant emphasis is a real design position, not a filter: the app should
make it easy to choose a plant that belongs in this ecoregion, and should be
honest about the scale a nativity claim is made at.

## 5. Design principles

1. **The garden has no signal.** Every read and write works offline. Sync and
   vendor search are enhancements, never preconditions. If logging requires
   connectivity, logging doesn't happen, and every history feature becomes
   worthless.
2. **Derive, don't type.** Enter your location and frost dates once. The app
   computes start-indoors, transplant, direct-sow, harvest and care dates.
   Anything the app can calculate is something you should never enter — though
   you can always override it.
3. **One tap to log a harvest.** The highest-frequency action gets the shortest
   path. Everything else can afford a form.
4. **A record you can question.** Structured enough to answer "what grew in bed 3
   in 2024, and did it do well?" Free text supplements the store; it isn't it.
5. **Place is a first-class input.** Hardiness zone, frost dates, heat zone and
   ecoregion are four different facts that gate four different things
   (DATA_MODEL §2). "Native" without a stated scale is a marketing word.
6. **Sunlight and dirty hands.** Big targets, high contrast, wet fingers, gloves.
   The phone is the primary device; the garden is the primary place.
7. **History that pays off.** Any data we ask for must resurface later as a
   decision it helped make. If it never does, don't collect it.

## 6. Platform constraints

- **Mobile-first, desktop-supported.** Phone in the garden, laptop for planning
  in January. The bed editor is the one screen with genuinely distinct touch and
  pointer affordances.
- **Installable PWA.** Home screen, offline shell, camera, notifications — no app
  store.
- **Local-first storage.** IndexedDB. No account required. Sync is additive and
  late.
- **Photos are the bulk of the data.** Downscale on capture, keep a budget, show
  it.
- **US-first units, metric internally.** Store mm and grams, display imperial by
  default, switchable.

## 7. Feature inventory

Legend: **v1** = phases 0–5, the first useful year · **v2** = phases 6–10 ·
**backlog** = worth doing, unscheduled · **cut** = decided against

### 7.1 Garden structure

| Feature | Tier |
|---|---|
| Beds with dimensions, kind, and purpose (annual veg / perennial / native / mixed) | v1 |
| Bed map — pan/zoom, tap to select, mobile-native | v1 |
| Square-foot grid within a bed | v1 |
| **Photo-traced beds — shoot a bed, tap four corners, plan on the rectified image** | v1 |
| Containers, greenhouse, cold frame, border as bed types | v1 |
| Sun exposure per bed, and how it shifts across the season | v2 |
| Multiple sites (home + community plot) | v2 |
| Free placement at real coordinates | v2 |
| Automatic bed-boundary detection from a photo | backlog (D-015) |
| Irregular / polygon bed shapes | backlog |

### 7.2 Plant library

| Feature | Tier |
|---|---|
| Annuals, biennials, perennials, shrubs, trees, bulbs as first-class lifecycles | v1 |
| Variety catalog: family, days to maturity, spacing, mature spread and height | v1 |
| **Hardiness and heat zone limits, used to filter what's offered** | v1 |
| **Native-to-region data, with a user-set strictness (ecoregion / state / off)** | v1 |
| Bloom window for perennials and natives | v1 |
| Bundled starter catalog, versioned and local | v1 |
| Custom varieties, user-editable, survive catalog updates | v1 |
| Pollinator value and larval host genera | v2 |
| Division interval and perennial care calendar | v2 |

> Nativity is stored as a **set of regions**, not a boolean, because native to
> North America is not native to your county. The app states which region a claim
> is relative to rather than hiding it behind a badge.

### 7.3 Seed, bulb and plant inventory

| Feature | Tier |
|---|---|
| **What's on hand — seed, bulbs, tubers, rhizomes, bare root, plugs** | v1 |
| Computed viability from species longevity and packet age | v1 |
| Germination test results per packet | v2 |
| Vendor, price, catalog link per packet | v2 |
| Wishlist → order list, grouped by vendor | v2 |

### 7.4 Sourcing — search across vendors

| Feature | Tier |
|---|---|
| **Search a variety across independent seed houses and Etsy** | v2 |
| Live price, stock, and form (seed / bulb / bare root) per listing | v2 |
| Deep-link fallback for vendors with no structured data | v2 |
| "Seeds I need" — the gap between the plan and the inventory, per vendor | v2 |
| Price and restock watch | backlog |

> Independent growers first — Prairie Moon, Baker Creek, Fedco, Southern
> Exposure, High Mowing, and the Etsy long tail for the things nobody else
> carries. This is a shopping assistant that drives traffic *to* small seed
> houses; see D-014 for the adapter tiers and the conduct rules.

### 7.5 Planning

| Feature | Tier |
|---|---|
| Place plantings into beds for a season | v1 |
| Spacing validation ("9 carrots per sq ft; you've drawn 20") | v1 |
| Schedule derived from frost dates and days to maturity, spring and fall | v1 |
| **Perennial occupancy — cells reserved year-round, including dormancy** | v1 |
| Bed occupancy timeline — a time axis, not just a map | v1 |
| Copy last season as a starting point | v1 |
| Mature-spread projection (a shrub's footprint is a function of its age) | v1 |
| Succession planting ("sow every 2 weeks × 5") | v2 |
| Crop rotation warnings by family — annual beds only | v2 |
| Bloom succession — find the gaps in the flowering calendar | v2 |
| Companion / antagonist hints | v2 |
| Multiple draft plans per season, side by side | backlog |

### 7.6 Tasks and reminders

| Feature | Tier |
|---|---|
| **Today / this week / overdue — the in-season home screen** | v1 |
| One-off and recurring tasks | v1 |
| **Derived tasks generated from plantings** ("thin carrots 14 days after germination") | v1 |
| Snooze and dismiss | v1 |
| Notification config — categories, lead time, quiet hours, digest vs per-task | v1 |
| Push notifications for frost, seed-start dates, harvest windows | v1 |
| Weather-conditional skip ("don't nag me to water, it rained") | v2 (D-017) |

### 7.7 In-season tracking

| Feature | Tier |
|---|---|
| Planting lifecycle: sown → germinated → transplanted → harvesting → pulled | v1 |
| Perennial states: established, dormant, divided | v1 |
| **Harvest log — weight or count, one tap** | v1 |
| "Ready now" queue | v1 |
| Photo journal per bed and per planting | v1 |
| Bloom events | v1 |
| Free-text observations, timestamped | v1 |
| Pest & disease log, with treatment and whether it worked | v2 |
| Soil tests and amendments | v2 |
| Weather: frost warnings, rainfall, growing-degree-days | v2 |
| Irrigation log, compost batches | backlog |

### 7.8 History & analysis

| Feature | Tier |
|---|---|
| Per-bed history — everything that ever grew here | v2 |
| **Bed photo time-lapse from a fixed photo point, across seasons and years** | v2 |
| **Variety verdict: grow again? plus one line of why** | v2 |
| Yield per bed, per square foot, per variety | v2 |
| Rotation heatmap by family | v2 |
| Year-over-year comparison | v2 |
| Perennial age and division history | v2 |
| End-of-season retrospective prompt, cost vs yield | backlog |

> The photo point is the cheap trick that makes the photo journal into a record:
> mark one spot and one angle per bed, shoot from it each time, and the shots
> stack into something you can scrub. Without it you get an album; with it you
> get a time-lapse.

### 7.9 Research

| Feature | Tier |
|---|---|
| Zone, heat zone, frost dates and ecoregion, entered once, used everywhere | v1 |
| Per-variety notes and saved links | v2 |
| Side-by-side variety trials — same conditions, recorded verdict | v2 |
| Local extension-service and native-society references | backlog |
| Aggregate community data ("in 6b this variety averages…") | cut for now |

### 7.10 Sharing

| Feature | Tier |
|---|---|
| Export everything to JSON — the backup story, pre-sync | v1 |
| Printable season plan | v2 |
| Bed stakes with QR codes → scan in the garden, open that bed | v2 |
| Read-only public link for a season or a bed | v2 |
| Multi-user garden with edit rights | v2 |
| Season summary card as a shareable image, CSV export, plan import | backlog |

### 7.11 Cross-cutting

| Feature | Tier |
|---|---|
| Offline-first architecture, installable PWA | v1 |
| Sunlight-readable UI, large touch targets | v1 |
| Unit switching (imperial / metric) | v1 |
| Sync across devices, accounts and auth | v2 |

## 8. Open questions

1. **Where is this garden?** Now genuinely blocking rather than merely useful.
   Native filtering needs an ecoregion, perennial selection needs a hardiness
   zone, annual scheduling needs frost dates. A city and state resolves all four.
2. **What's the balance?** Mostly vegetables with native borders, or a native and
   perennial garden that also grows food? It doesn't change the model — it
   changes which screen is the home screen.
3. **Name.** "Garden" is a placeholder.
4. **Which vendors do you actually buy from?** The sourcing adapters should be
   built for those first; everything else degrades to a deep link.
5. **How many beds, and are any of them existing perennial plantings** that need
   entering as already-established rather than planned?
6. **Kitchen scale, or counting?** If harvests are tallied rather than weighed,
   yield-per-square-foot gets fuzzy and the model should know up front.
