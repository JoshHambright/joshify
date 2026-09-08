# Garden — Domain Model

Status: `DRAFT v2` · Last updated: 2026-09-08

**Read this before ROADMAP.md.** Almost every feature in PRODUCT.md is a
different view over the same handful of objects. If the model is right, features
get cheap. If it's wrong, we rewrite in month two.

---

## 1. The spine

```
Region ──┐
         ├─ Site ──< Bed ──< Planting >── Variety ──< SeedPacket
         │            │         │  │                      │
         │            │         │  └──< Event         VendorListing
         │            │         └──< Planting  (division lineage)
         │            └──< BedPhoto
         └─────────────────────< TaskRule ──< Task
```

Read the middle carefully, because it's still the whole design:

> **A Planting is `{ variety, bed, footprint, dateRange }` — an instance of a
> variety occupying a place for a span of time.**

A span, not a point. That single choice is what makes the rest work:

| Feature | Falls out of a time-ranged Planting as… |
|---|---|
| Bed map, today | plantings where `today ∈ dateRange` |
| Next season's plan | plantings where `dateRange` is in the future |
| History | plantings where `dateRange` is in the past |
| Succession | several plantings, same bed, staggered ranges |
| Bed occupancy timeline | plantings drawn on a time axis |
| Rotation check | families of past *annual* plantings in this bed |
| "What's ready?" | plantings whose expected-harvest window is open |
| **Perennial beds** | **plantings with an open-ended range (see §3)** |

Most garden apps model a bed as a static picture of one moment, then bolt time on
afterwards, and can never answer "what was in bed 3 last August."

## 2. Geography — four different facts

"Zone" gets used as one word for four unrelated questions. They resolve
differently and each gates a different feature, so they're stored separately.

| Fact | Answers | Gates |
|---|---|---|
| **USDA hardiness zone** | how cold does it get | will a *perennial* survive the winter |
| **Frost dates** (last spring, first fall) | how long is the season | every *annual* schedule |
| **AHS heat zone** | how many days above 86°F | whether cool-season crops bolt, whether a perennial cooks |
| **EPA Level III/IV ecoregion** + state/county | what grew here before us | what counts as **native** |

```
Region { id, kind, code, name }        // kind: ecoregion3 | ecoregion4 | state | county
Site   { id, name, latitude?, longitude?,
         hardinessZone, heatZone?, lastFrostDate, firstFrostDate,
         regionIds[],                  // resolved from lat/lng, user-overridable
         nativeStrictness }            // ecoregion | state | continent | off
```

`nativeStrictness` matters more than it looks. "Native" with no scale attached is
a marketing word. The user picks how strict the badge is, and the app is honest
about which region a claim is relative to.

## 3. Lifecycle — annuals, perennials, and the things in between

`Variety.lifecycle` ∈ `annual | biennial | tenderPerennial | perennial | shrub |
tree | bulb`

The distinction that actually changes code is not annual-vs-perennial. It's
**does this occupancy end on a known date, and does the ground free up.**

| Lifecycle | `dateRange` ends | Frees the cells | Rotation applies |
|---|---|:---:|:---:|
| Annual | yes, computed | yes | yes |
| Biennial | yes, year 2 | yes | yes |
| Tender perennial | yes, at frost — *or* lifted and overwintered | yes | yes |
| Perennial / bulb | **open-ended** | **no — reserved year-round** | no |
| Shrub / tree | **open-ended** | **no, and the footprint grows** | no |

### The dormancy trap
A perennial in March is bare soil that is *already occupied*. This is the single
most likely bug in the whole app: the planner sees empty cells and offers them.

So the occupancy query is **not** "is there a planting whose range covers today."
It is:

```
occupied(bed, date) = plantings where
    dateRange covers date                       // annuals, in season
    OR (lifecycle is perennial-like AND startDate <= date AND endDate is null)
```

Perennial cells are reserved on the planner grid year-round, drawn differently
when dormant, and the planner refuses to place over them without an explicit
"this replaces it."

### Establishment and spread
```
Planting {
  ...
  establishedYear?,          // sleep / creep / leap — year 1, 2, 3+
  currentSpreadMm?,          // grows each season for perennials and woodies
  dividedFromPlantingId?,    // lineage: one plant becomes three
  dormantFrom?, dormantTo?,  // month-of-year, for the "it's not dead" affordance
}
```

`dividedFromPlantingId` is a self-reference and it earns its place: dividing a
hosta into three is the commonest perennial operation there is, and losing the
provenance loses the answer to "how old is this actually."

`currentSpreadMm` growing over time means a shrub's footprint on the map is a
function of its age. Planting a serviceberry 3 ft from a bed is fine in year one
and wrong in year six, and the app should be able to say so at planting time.

## 4. Entities

### Bed
```
Bed { id, siteId, name, kind, purpose, widthMm, lengthMm, x, y, rotation,
      gridCellMm, soilNotes?, sunHours?, photoPointId?, archivedAt? }
```
- `kind` — `raised | inGround | container | greenhouse | coldFrame | border`
- `purpose` — `annualVeg | perennial | mixed | native` — drives whether rotation
  checking runs at all, and which planting defaults apply.
- Beds are **archived, never deleted.** A deleted bed orphans a decade of history.

### BedPhoto — the traced backdrop and the time-lapse
```
BedPhoto { id, bedId, photoId, capturedAt, isPhotoPoint,
           corners?: [{x,y} × 4],   // user-tapped, for perspective correction
           homography?,             // derived from corners
           referenceEdgeMm? }       // one real measurement gives the rest scale
```

Two jobs, one entity. **Setup:** tap the four corners of the bed in a photo,
enter one measured edge, and the homography rectifies it to a top-down plan you
can lay a grid on. **History:** flag one angle as the bed's `photoPoint` and
every later shot from that spot stacks into an aligned time-lapse. See D-015 for
why this is a tracing aid and not an auto-detector.

### Variety
```
Variety { id, commonName, scientificName?, cultivar?, family, lifecycle,
          daysToMaturity?, dtmFrom,           // sow | transplant — see below
          spacingMm, matureSpreadMm?, matureHeightMm?, plantsPerCell?,
          hardinessZoneMin?, hardinessZoneMax?, heatZoneMax?,
          sunRequirement, moisture, sowMethod, frostTolerance,
          bloomStartMonth?, bloomEndMonth?,   // natives & perennials
          nativeToRegionIds[],                // from USDA PLANTS + curation
          pollinatorValue?, hostGenera[],     // what larvae eat it
          seedLongevityYears, isCustom, notes? }
```

- `dtmFrom` is not a detail. Days-to-maturity counts from **sow** for direct-sown
  crops and from **transplant** for started ones. Store which; getting it wrong
  silently breaks every derived date in the app.
- `nativeToRegionIds` is a set, not a flag, per §2.
- `hostGenera` is the Tallamy-style "this oak feeds 500 caterpillar species"
  data. It's the single most persuasive number in native gardening and the
  hardest to source cleanly — see D-012.
- `seedLongevityYears` lives here, not on the packet: viability is a property of
  the species (onion 1, tomato 4–6, cucumber 5–10) applied to a packet's age.

### SeedPacket
```
SeedPacket { id, varietyId, form, vendor?, purchasedYear, lotYear?,
             quantity?, quantityUnit, germinationTest?, usedUpAt?, notes? }
```
`form` — `seed | bulb | tuber | rhizome | bareRoot | plug | potted`. The user's
sourcing request spans all of these, and a bareroot order has a receive-by window
that a seed packet doesn't.

### Planting
```
Planting { id, bedId, varietyId, seedPacketId?, seasonYear,
           cells[] | { x, y, radiusMm },
           method,                       // directSow | transplant | purchasedStart
                                         // | bulbPlant | bareRoot | division
           plannedSowDate, plannedTransplantDate?,
           plannedFirstHarvest?, plannedEndDate?,      // null = perennial
           actualSowDate?, actualTransplantDate?,
           actualFirstHarvest?, actualEndDate?,
           establishedYear?, currentSpreadMm?, dividedFromPlantingId?,
           dormantFrom?, dormantTo?,
           status, notes? }
```
**Planned and actual are separate fields.** Comparing them *is* the learning —
"I always start peppers three weeks late" becomes a query, not a memory.

`status` ∈ `planned | sown | germinated | transplanted | growing | harvesting |
established | dormant | finished | failed`. `failed` is first-class and takes a
reason.

### Event
```
Event { id, plantingId?, bedId?, siteId?, occurredAt, kind, payload, photoIds[] }
```
`kind` ∈ `harvest | observation | pest | disease | treatment | amendment | water |
bloom | division | weather | photo | statusChange`

One table, discriminated by kind — see D-007. `bloom` is new: bloom-time
succession (something flowering every week, March to October) is the core
planning question in a pollinator planting, the way yield is in a veg bed.

### Task and TaskRule
```
TaskRule { id, kind, sourceType, sourceId?, title, category,
           schedule,                    // oneOff | recurring | derived
           offsetFrom?, offsetDays?,    // derived: "14d after germination"
           recurEvery?, recurUnit?,
           weatherSkip?,                // e.g. skip watering if rain > 12mm/48h
           notify, leadTimeDays, active }

Task { id, ruleId?, plantingId?, bedId?, title, category,
       dueDate, completedAt?, snoozedTo?, notes? }
```
Three kinds of task, and the third is the interesting one:

1. **One-off** — "fix the fence."
2. **Recurring** — "check drip lines weekly."
3. **Derived** — generated from plantings by the same engine that computes
   planting dates. "Thin carrots 14 days after germination." "Side-dress tomatoes
   at first fruit set." "Divide the hostas in year 4." "Cut back the natives
   *after* the birds have had the seed heads, not in fall."

Derived tasks are where a task list stops being a to-do app and starts being the
thing that makes you a better gardener, because they encode the knowledge you
otherwise have to remember to look up.

### VendorListing
Cached results from the sourcing search (§ D-014). Deliberately a cache, not a
catalog — it has a TTL, it is never the source of truth for a Variety, and the
app works completely without it.

```
VendorListing { id, vendorId, varietyId?, matchConfidence,
                title, form, price?, currency, inStock, url,
                imageUrl?, fetchedAt, ttl }
```
`varietyId` is nullable and `matchConfidence` exists because vendor product
titles are free text — "Cherokee Purple" vs "Tomato, Cherokee Purple (OP)" — and
pretending that match is exact would corrupt the catalog.

### VarietyVerdict
```
VarietyVerdict { id, varietyId, seasonYear, rating, growAgain, note }
```
Its own entity, not a field on Variety: the answer is per-season, and the change
across seasons is the interesting part.

## 5. Derived scheduling

Given a Site and a Variety, a new **annual** Planting computes:

```
transplant date  = lastFrost + variety.transplantOffsetDays   (negative for hardy)
start indoors    = transplant − variety.weeksIndoors
direct sow       = lastFrost + variety.directSowOffsetDays
first harvest    = (sow | transplant) + daysToMaturity   // per dtmFrom
end of planting  = firstHarvest + variety.harvestWindowDays
```

Fall and overwintering crops invert it, anchored to `firstFrostDate`. Same
arithmetic, different anchor, and worth building both directions at once.

**Perennials use a different calculation entirely** — there is no maturity date,
there's an establishment curve. Year 1 is survival, year 2 is growth, year 3 is
bloom. What gets derived is the *care* calendar (divide in year N, cut back in
month M, first bloom expected in year 3), which is exactly what feeds derived
tasks above.

Every derived date is an editable default. Nothing is ever locked.

## 6. Storage & sync readiness

Local-first (D-002), IndexedDB. Sync isn't being built now, but three cheap rules
now make it possible later without a migration:

1. **Every record has a client-generated UUIDv7 `id`.** No autoincrement keys —
   they collide the moment a second device exists.
2. **Every record has `updatedAt` and `deletedAt`.** Soft deletes only; a hard
   delete cannot be replicated.
3. **Records are small and independently writable.** This is why `Event` is
   append-only and why photos are separate rows from what they illustrate.

Enough for field-level last-write-wins, which is the right ceiling here. **No CRDT
library** — see D-008.

## 7. What the model deliberately does not have

- **Users.** v1 has no accounts. `ownerId` later is additive.
- **A generic tagging system.** Families, lifecycles and statuses are
  enumerations because we want to query them. Free tags are how you avoid
  deciding what the enumeration should be.
- **A live plant-database dependency.** Bundled versioned JSON — see D-006, D-012.
- **Vendor catalogs as first-class data.** They're a cache with a TTL — D-014.
