# Garden — Product Description

*(working name)*

**Plan, track, and remember a home vegetable garden. Mobile-first, local-first,
offline by default.**

Status: `DRAFT v1` · Last updated: 2026-09-08

---

## 1. The one-liner

A garden app that lives in your pocket while you're standing in the dirt, and
remembers enough about last year to make this year better.

## 2. The problem

Garden knowledge is perishable in a way that garden *data* is not. You know in
August that the Sungold outproduced the Black Krim four to one, that the bed by
the fence got shaded out by July, that you started peppers three weeks too late.
By February — when you're actually ordering seed — all of that is gone.

The existing tools split badly into two camps:

- **Planners** that draw a beautiful bed layout in January and are never opened
  again, because logging a harvest takes eleven taps and a signal bar.
- **Journals** that record everything and structure nothing, so the record is
  unqueryable — you can read your notes, but you can't ask them a question.

The interesting product is the one that closes the loop: *the plan generates the
record, and the record improves next year's plan.*

## 3. What it is (and is not)

**It is:**
- A **planning tool** — beds, layouts, schedules, succession, seed orders.
- A **field log** — harvests, observations, photos, problems, in one tap while
  holding a colander.
- A **memory** — every planting you've ever made, queryable by bed, variety,
  family and year.

**It is not:**
- A social network. Sharing is a link you send, not a feed you scroll.
- A farm management system. No labour costs, no CSA shares, no compliance.
- An identification app. It won't tell you what that bug is.
- Dependent on a service being up. It works in airplane mode, in a field.

## 4. Who it's for

One gardener with a handful of raised beds, plus possibly a partner with edit
rights. Home scale: 4–20 beds, tens of varieties, hundreds of plantings a year.
Not market-garden scale, and the model should not pretend otherwise.

## 5. Design principles

1. **The garden has no signal.** Every read and write works offline. Sync, when
   it exists, is an enhancement — never a precondition. If logging requires
   connectivity, logging doesn't happen, and every history feature in §7 becomes
   worthless.
2. **Derive, don't type.** You enter your frost dates once. The app computes
   start-indoors, transplant, direct-sow, and expected-harvest dates from days to
   maturity. Any date the app can calculate is a date you should never have to
   enter — though you can always override one.
3. **One tap to log a harvest.** The highest-frequency action in the app gets the
   shortest path in the app. Everything else can afford a form.
4. **A record you can question.** Structured enough to answer "what grew in bed 3
   in 2024, and did it do well?" Free-text notes are a supplement, not the store.
5. **Sunlight and dirty hands.** Big targets, high contrast, works with wet
   fingers and gloves. The phone is the primary device and the garden is the
   primary place.
6. **History that pays off.** Any data we ask the gardener to enter must show up
   later as a decision it helped make. If it never resurfaces, don't collect it.

## 6. Platform constraints

- **Mobile-first, desktop-supported.** Phone in the garden, laptop for planning
  in January. Layout is responsive; the bed editor is the one screen that gets
  genuinely distinct touch and pointer affordances.
- **Installable PWA.** Home-screen icon, offline shell, camera and notification
  access — without an app store.
- **Local-first storage.** Data lives in the browser (IndexedDB). No account
  required to use the app. Sync and sharing arrive in a later phase and are
  additive.
- **Photos are the bulk of the data.** Downscale on capture; keep a storage
  budget and show it.
- **US-first units, metric internally.** Store canonical metric, display
  imperial by default, switchable.

## 7. Feature inventory

Legend: **v1** = phases 0–4, the first useful season · **v2** = phases 5–8 ·
**backlog** = worth doing, not scheduled · **cut** = decided against

### 7.1 Garden structure

| Feature | Tier |
|---|---|
| Beds with dimensions, orientation, soil notes | v1 |
| Bed map — pan/zoom, tap to select, mobile-native | v1 |
| Square-foot grid layout within a bed | v1 |
| Containers, greenhouse, cold frame as bed types | v1 |
| Sun exposure per bed (hours, and how it shifts across the season) | v2 |
| Multiple sites (home + community plot) | v2 |
| Free placement at real coordinates | v2 |
| Irregular / polygon bed shapes | backlog |

### 7.2 Plant library & seed inventory

| Feature | Tier |
|---|---|
| Variety catalog: species, cultivar, days to maturity, spacing, family | v1 |
| Bundled starter catalog of common varieties (versioned, local) | v1 |
| Custom varieties, user-editable | v1 |
| **Seed inventory — packets on hand, year, quantity, viability** | v1 |
| Germination test results, per packet | v2 |
| Vendor, price, catalog link per packet | v2 |
| Wishlist → seed order list, grouped by vendor | v2 |

> Seed inventory is the piece most often missing from garden apps and the one
> most often wanted. You cannot plan winter starts without knowing what you have
> and whether it's still alive. It's also the thing you want on a phone while
> standing in front of a seed rack in February.

### 7.3 Planning

| Feature | Tier |
|---|---|
| Place plantings into beds for a season | v1 |
| Spacing validation ("9 carrots per sq ft; you've drawn 20") | v1 |
| Schedule derived from frost dates + days to maturity | v1 |
| Copy last season as a starting point | v1 |
| Bed occupancy timeline — a time axis, not just a map | v1 |
| Succession planting ("sow every 2 weeks × 5") | v2 |
| Crop rotation warnings by plant family, 3–4 year lookback | v2 |
| Companion / antagonist hints | v2 |
| Multiple draft plans per season, side by side | backlog |

> The occupancy timeline is the structural idea the whole app leans on. A bed is
> not a picture of one moment; it's a strip of time with plantings laid along it.
> Get that right and succession, rotation and history all fall out for free.

### 7.4 Winter starts

| Feature | Tier |
|---|---|
| Seed-starting calendar, computed backward from transplant dates | v2 |
| Tray and cell tracking — what's in which tray, sown when | v2 |
| Germination rate per sowing | v2 |
| Hardening-off schedule | v2 |
| Grow-shelf capacity check ("240 cells planned, 144 available") | backlog |

### 7.5 In-season tracking

| Feature | Tier |
|---|---|
| Planting lifecycle: sown → germinated → transplanted → harvesting → pulled | v1 |
| **Harvest log — weight or count, one tap** | v1 |
| "Ready now" queue, from days-to-maturity plus observation | v1 |
| Photo journal per bed and per planting | v1 |
| Free-text observations, timestamped, attached to a planting or bed | v1 |
| Tasks and reminders — water, thin, side-dress, trellis | v2 |
| Pest & disease log, with treatment applied and whether it worked | v2 |
| Soil tests and amendments | v2 |
| Weather: frost warnings, rainfall, growing-degree-days | v2 |
| Irrigation log | backlog |
| Compost batch tracking | backlog |

### 7.6 History & analysis

| Feature | Tier |
|---|---|
| Per-bed history — everything that ever grew here | v2 |
| **Variety verdict: grow again? yes / no / maybe, plus one line of why** | v2 |
| Yield per bed, per square foot, per variety | v2 |
| Rotation heatmap by plant family | v2 |
| Year-over-year comparison (this June vs last June) | v2 |
| End-of-season retrospective prompt | backlog |
| Cost vs. yield | backlog |

> The variety verdict is the highest-value item in this whole document and almost
> nobody builds it. Ten years of gram-accurate yield data is worth less than
> fifty honest one-line opinions.

### 7.7 Research

| Feature | Tier |
|---|---|
| Per-variety notes and saved links | v2 |
| Zone and frost dates, entered once, used everywhere | v1 |
| Side-by-side variety trials — same conditions, recorded verdict | v2 |
| Local extension-service references | backlog |
| Aggregate community data ("in 6b this variety averages…") | cut for now |

### 7.8 Sharing

| Feature | Tier |
|---|---|
| Export everything to JSON (the backup story, pre-sync) | v1 |
| Printable season plan | v2 |
| Bed stakes with QR codes → scan in the garden, open that bed | v2 |
| Read-only public link for a season or a bed | v2 |
| Multi-user garden with edit rights (partner, family) | v2 |
| Season summary card, as an image worth posting | backlog |
| CSV export | backlog |
| Import someone else's plan as a template | backlog |

> QR bed stakes are cheap to build and disproportionately good: a stake in the
> ground becomes a deep link into the app, and identification-in-the-garden stops
> being a memory problem.

### 7.9 Cross-cutting

| Feature | Tier |
|---|---|
| Offline-first architecture | v1 |
| Installable PWA | v1 |
| Sunlight-readable UI, large touch targets | v1 |
| Unit switching (imperial / metric) | v1 |
| Push notifications: frost alerts, seed-start dates, harvest nudges | v2 |
| Sync across devices | v2 |
| Accounts and auth | v2 |

## 8. Open questions

1. **Location and frost dates.** Nearly every schedule keys off last-spring and
   first-fall frost. Needs Josh's real numbers, or at least a zone, before the
   scheduling work in Phase 3.
2. **Name.** "Garden" is a placeholder.
3. **How many beds, actually?** Drives whether the map is a first-class screen or
   a list with a diagram attached.
4. **Does anyone else need edit access?** Determines how early sync matters.
5. **Weight or count for harvests?** Probably both, per variety — a kitchen scale
   for tomatoes, a tally for cucumbers. Worth confirming a scale exists at all;
   if not, count-and-size is the whole model and yield-per-sq-ft gets fuzzier.
