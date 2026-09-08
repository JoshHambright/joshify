# Garden — Domain Model

Status: `DRAFT v1` · Last updated: 2026-09-08

**Read this before ROADMAP.md.** Almost every feature in PRODUCT.md is a
different view over the same handful of objects. If the model is right, features
get cheap. If it's wrong, we rewrite in month two.

---

## 1. The spine

```
Site ──< Bed ──< Planting >── Variety ──< SeedPacket
                    │
                    └──< Event
```

Read the middle of that diagram carefully, because it's the whole design:

> **A Planting is `{ variety, bed, position, dateRange }` — an instance of a
> variety occupying a place for a span of time.**

Not a point in time. A span. That single choice is what makes the rest work:

| Feature | Falls out of a time-ranged Planting as… |
|---|---|
| Bed map, today | plantings where `today ∈ dateRange` |
| Next season's plan | plantings where `dateRange` is in the future |
| History | plantings where `dateRange` is in the past |
| Succession | several plantings, same bed, staggered ranges |
| Bed occupancy timeline | plantings drawn on a time axis |
| Rotation check | families of past plantings in this bed |
| "What's ready?" | plantings whose expected-harvest window is open |

Most garden apps model a bed as a static picture of one moment, then bolt time on
afterwards, and can never answer "what was in bed 3 last August."

## 2. Entities

### Site
A physical location. Most users have exactly one; the model supports more so the
community-plot case doesn't require a migration.

```
Site { id, name, zone?, lastFrostDate, firstFrostDate, latitude?, longitude? }
```

Frost dates live here, not in settings, because a community plot ten miles away
genuinely has different ones.

### Bed
```
Bed { id, siteId, name, kind, widthMm, lengthMm, x, y, rotation,
      gridCellMm, soilNotes?, sunHours?, archivedAt? }
```

- `kind` — `raised | inGround | container | greenhouse | coldFrame`
- `widthMm/lengthMm` plus `x/y/rotation` give a real map, not a list.
- `gridCellMm` defaults to 1 ft. Making it a per-bed field means a herb bed can
  use 6 in cells without a schema change.
- Beds are **archived, never deleted** — a deleted bed orphans a decade of
  history.

### Variety
The catalog entry. What you could grow.

```
Variety { id, commonName, cultivar?, family, daysToMaturity,
          spacingMm, plantsPerCell?, sunRequirement, sowMethod,
          frostTolerance, isCustom, notes? }
```

- `family` is load-bearing — it's what rotation checking runs on.
- `daysToMaturity` is measured from **sow** for direct-sown crops and from
  **transplant** for started ones. Store which; getting this wrong silently
  breaks every derived date.
- `plantsPerCell` is the square-foot-gardening number (carrots 16, tomato ¼).
  Derivable from `spacingMm`, but the conventional numbers don't always match the
  arithmetic, so store it and fall back to computing.
- Ships with a bundled starter catalog; `isCustom` marks user additions so a
  catalog update never clobbers them.

### SeedPacket
What you actually have, as opposed to what exists.

```
SeedPacket { id, varietyId, vendor?, purchasedYear, lotYear?,
             quantity?, quantityUnit, germinationTest?, notes?, usedUpAt? }
```

Viability is computed, not stored: seed longevity is a property of the species
(onion 1 yr, tomato 4–6, cucumber 5–10), so it belongs on Variety and gets
applied to the packet's age.

### Planting — the centre
```
Planting { id, bedId, varietyId, seedPacketId?, seasonYear,
           cells[] | { x, y, radiusMm },
           method,                       // directSow | transplant | purchasedStart
           plannedSowDate, plannedTransplantDate?,
           plannedFirstHarvest, plannedEndDate,
           actualSowDate?, actualTransplantDate?,
           actualFirstHarvest?, actualEndDate?,
           status, notes? }
```

- **Planned and actual are separate fields.** Comparing them *is* the
  learning — "I always start peppers three weeks late" is a query, not a memory.
- `status` — `planned | sown | germinated | transplanted | growing | harvesting |
  finished | failed`. `failed` is a first-class outcome and needs a reason.
- `cells[]` for grid mode; the `{x, y, radiusMm}` alternative is reserved so free
  placement in v2 is additive rather than a migration.
- Planned dates are **derived** on creation (see §3) and then editable. Store the
  result, not the formula — a later catalog change to `daysToMaturity` must not
  silently rewrite history.

### Event
The append-only log. Everything that happened.

```
Event { id, plantingId?, bedId?, siteId?, occurredAt, kind, payload, photoIds[] }
```

`kind` ∈ `harvest | observation | pest | disease | treatment | amendment |
water | weather | photo | statusChange`

One table, discriminated by kind, because every one of these is "a thing that
happened at a time, attached to something, possibly with photos." The alternative
— a table per kind — makes the single most-wanted screen (a bed's timeline) a
seven-way union query forever.

`payload` for a harvest is `{ grams?, count?, quality?, notes? }`. Both measures
optional: tomatoes get weighed, cucumbers get tallied.

### Photo
```
Photo { id, blob, capturedAt, width, height, bytes, plantingId?, bedId? }
```
Downscaled on capture. These will be 95% of storage; the budget needs to be
visible in the UI.

### VarietyVerdict
```
VarietyVerdict { id, varietyId, seasonYear, rating, growAgain, note }
```

Deliberately its own entity rather than a field on Variety: the answer is
per-season, and the *change* over seasons is the interesting part.

## 3. Derived scheduling

The rule from PRODUCT.md §5.2, made concrete. Given a Site's frost dates and a
Variety, a new Planting computes:

```
transplant date  = lastFrost + variety.transplantOffsetDays   (may be negative
                                                                for hardy crops)
start indoors    = transplant − variety.weeksIndoors
direct sow       = lastFrost + variety.directSowOffsetDays
first harvest    = (sow | transplant) + daysToMaturity
end of planting  = firstHarvest + variety.harvestWindowDays
```

Fall and overwintering crops invert it, counting backward from `firstFrostDate`.
That's the same arithmetic with a different anchor, and it's worth building both
directions at once — a fall planting calendar is a large fraction of the value
and is trivial once the spring one exists.

Every derived date is an editable default. Nothing is ever locked.

## 4. Storage & sync readiness

Local-first (D-002), IndexedDB. Sync is not being built now, but three cheap
rules now make it possible later without a migration:

1. **Every record has a UUIDv7 `id`** generated client-side. No autoincrement
   keys — they collide the moment a second device exists.
2. **Every record has `updatedAt` and `deletedAt`.** Soft deletes only. A hard
   delete cannot be replicated.
3. **Records are small and independently writable.** Two devices editing
   different plantings in the same bed must not conflict. This is why `Event` is
   append-only and why photos are separate rows from the things they illustrate.

That's enough for last-write-wins field-level sync, which is the right ceiling
for a single-household app. **No CRDT library.** Automerge/Yjs solve concurrent
editing of shared documents; two people are not going to co-edit a bed layout in
the same second, and the runtime cost and modelling constraints aren't worth it.

## 5. What the model deliberately does not have

- **Users.** v1 has no accounts. Adding an `ownerId` later is additive; designing
  multi-tenancy now is speculative work with no v1 payoff.
- **A generic tagging system.** Families, kinds and statuses are enumerations
  because we want to query them, and free tags are a way of avoiding the decision
  about what the enumeration should be.
- **A plant-database API dependency.** Bundled versioned JSON instead — see
  D-006.
