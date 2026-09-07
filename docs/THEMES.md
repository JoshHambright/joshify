# Joshify — Theme Roster

Status: `DRAFT v1` · Last updated: 2026-09-02
Related: [PS1_MODE.md](./PS1_MODE.md) · [VISUALIZER.md](./VISUALIZER.md)

---

## The insight: don't blend them, make them themes

A pile of 90s references blended together produces pastiche. But these references
are all from **1992–1999**, and they sort cleanly into *registers* that don't mix
and shouldn't be asked to:

- Windows 95 is corporate beige and bevels.
- Surge is acid-green and jagged.
- Magic School Bus is friendly saturated primaries.
- Oregon Trail is austere and quiet.

Forced together they fight. Kept **separate and named**, they're a roster.

And there's already a perfect model for that, from exactly the right year.

### Microsoft Plus! is the architecture, not just a vibe

**Microsoft Plus! for Windows 95** (1995) shipped **12 desktop themes** —
*Dangerous Creatures, Leonardo da Vinci, Mystery, Nature, Science, The 60's USA,
Travel*, and more — plus extra screensavers.

The important part: a Plus! theme changed **wallpaper, colour scheme, icons,
cursors, fonts and system sounds together**. It skinned the *whole machine*, not
one app.

That is a better model for Joshify's presets than Winamp skins are. Winamp skinned
the player; Plus! skinned everything. So:

> **A Joshify theme is not an effect chain. It is a palette + a scene + an effect
> chain + UI chrome + transition behaviour, switched as one unit.**

This expands **D-012** (presets are data, not code paths) to cover the whole
interface. Logged as **D-017**.

### And the screensaver lineage is literal

Joshify's auto-enter-on-idle visualiser mode *is* a screensaver. The Plus!-era
screensavers were ambient generative art that ran when you walked away — the
direct functional ancestor of what Phase 5 builds. That's not a reference we're
borrowing; it's the same thing, thirty years later.

---

## The roster

Each theme is a full spec, not a mood. `N2O` is built; the rest are specified.

| Theme | Palette | Chrome | Scene | Signature effect |
|---|---|---|---|---|
| **`N2O`** ✅ | Void purple, cyan, magenta, lime | PS1 bevels, squared techno type | `tunnel` | Vertex snap + affine warp |
| **`PLUS!`** | Teal `#008080`, silver, navy title-bar blue | Raised/sunken 3D bevels, MS Sans-alike | `ambient` — slow geometric solids | Full-window drag ghosting |
| **`VGA`** | Strict 16-colour EGA/VGA palette | Program Manager: flat, tiled, iconic | `flat` | **16-colour quantise + ordered dither** |
| **`SURGE`** | Acid lime, hot magenta, black | Jagged shards, hazard stripes, italic caps | `tunnel` at speed | Velocity streaks, aggressive beat flash |
| **`GOOP`** | Radioactive green, violet, wet black | Dripping edges, moulded plastic | `flat` | Ooze displacement, specular slime |
| **`METROPOLIS`** | Muted daylight, SimCity 2000 earth tones | Dense icon toolbar | `isometric` — a city that builds with the track | Pixel-grid snap |
| **`FIELD TRIP`** | Saturated primaries, paper white | Hand-drawn rules, annotation callouts | `flat` | Marker-pen outline, halftone |
| **`TRAIL`** | 4-colour limited, amber-on-black option | Pixel type, boxed status readout | `flat` | Heavy dither, deliberate stillness |
| **`REEF`** | Deep blue, teal, sunlit cyan, sand | Soft, rounded, minimal | `reef` — underwater ambient | Caustics, god rays, drifting silhouettes |
| **`LAGOON`** | Sunset magenta→orange→purple, chrome | Airbrushed gradients, chrome bevels | `reef` | Autostereogram overlay |

`ambient`, `isometric` and `reef` are new **scenes** under the D-014 scene stage,
joining `flat` and `tunnel`. Every post-chain effect composes over all of them.

---

## Dolphins (yes, seriously)

Dolphins are not a novelty request. They are one of the most load-bearing visual
signifiers of the decade, across at least four separate registers:

| Register | What it actually was |
|---|---|
| **Autostereograms** | The single most reproduced optical illusion of 1993–95, and the canonical subject was a dolphin. Mall poster shops, book covers, everywhere |
| **Airbrush / Trapper Keeper** | Dolphins leaping over a sunset gradient — a whole genre of school-folder and beach-shop art |
| **Ambient underwater games** | *Ecco the Dolphin* (Sega, 1992): surreal, slow, beautiful, and unusually musical for its era |
| **Screensavers & desktop themes** | Aquatic wallpaper and 3D swimming screensavers were a default of the period — the Plus! roster even shipped *Dangerous Creatures* |

### They also fill a real hole in the product

More important than the reference: **Joshify currently has no calm mode.**

`N2O` is aggressive — a strobing tunnel at speed. That's correct for loud music at
8pm. It is *wrong* for an always-on object on a desk playing something quiet at
11pm, which is a large share of what this device will actually do.

`REEF` is the tonal opposite: slow, drifting, dark, no strobe. Ambient underwater
with caustics and god rays, dolphin silhouettes passing at the edge of the light.
It's the mode you leave running.

**So dolphins arrive as a product requirement wearing a costume.** Logged as
**D-018**.

### ❌ Autostereograms — considered and cut

An autostereogram could be generated live from the `tunnel` scene's depth buffer,
and defocusing your eyes would resolve the visualiser into genuine 3D.

**Cut anyway.** It's a clever effect in search of a reason. Joshify is a music
appliance — every visual should serve *the music playing right now*, and a
stereogram serves itself. It also demands the viewer stop and refocus, which is
the opposite of glanceable (PRODUCT.md §5.3).

Recorded rather than deleted, per the tracker convention. If it ever returns:
SIRDS walks each scanline sequentially, so it needs iterative backward sampling
to work in a fragment shader, and *Magic Eye* is a brand — the generic terms are
**autostereogram** / **SIRDS**.

---

## What each reference actually contributes

Mood-boarding is cheap. The useful question is **which interface pattern does this
give us** — and several of these turn out to solve screens we already need.

| Reference | Transferable pattern | Where it lands |
|---|---|---|
| **Windows 95 / Plus!** | Theme packs that skin everything at once | The preset architecture itself (D-017) |
| **Windows 3.1** | 16-colour palette + ordered dithering; flat iconic chrome | `VGA` theme; a real shader mode |
| **Carmen Sandiego** | The **dossier / case file** — dense structured record | Artist & album detail screens (Phase 6) |
| **Oregon Trail** | The **status readout** — a few vital numbers, boxed, always visible | Diagnostics / now-playing stats |
| **SimCity** | Dense icon toolbar with tooltips; isometric world | Control surfaces; `METROPOLIS` scene |
| **Beakman's World** | High-contrast hazard graphics; the **annotated diagram** | An "audio path" view — where the sound is actually going |
| **Magic School Bus** | Friendly saturated primaries; callout annotations | `FIELD TRIP` theme |
| **Creepy Crawlers** | Radioactive palette, wet/moulded texture | `GOOP` theme |
| **Surge** | Extreme-sports energy: jagged, acid, high velocity | `SURGE` theme |
| **Pizza Hut / BOOK IT!** | *Reward mechanic* — the sticker chart | ⚠️ See below |

### The honest one

**Pizza Hut is the weakest of these** for a music appliance. It's powerful
cultural memory but not a transferable visual system — the actual content is
red plastic tumblers and stained-glass lamps, which say "restaurant", not "music".

The one real idea in there is **BOOK IT!'s reward mechanic** — the sticker chart
for hitting a reading goal. That would map to listening streaks or milestones.
But we have no stats feature and shouldn't add one just to justify a reference.

**Filed as an idea, not a theme.** If a listening-stats screen ever exists, the
sticker chart is the right shape for it.

---

## ⚠️ IP: homage, not reproduction — extends D-015

Every name on that list is a live trademark. The rule from the PS1 work applies
unchanged, and now covers more ground.

**Never reproduce:**
- The Windows logo, flag, wordmark, or the actual Win95/3.1 UI bitmaps and icons
- The Surge wordmark or logo
- Pizza Hut's roof mark, or BOOK IT! branding
- Ms. Frizzle, the bus, Carmen Sandiego, Ecco, or any character or likeness
- The **Magic Eye** name (a brand — use *autostereogram*), Lisa Frank artwork,
  or any Sega asset
- MECC/Broderbund/Maxis art assets, or any game's sprites
- Any theme *named* after a trademark

**Always original.** Build the *idiom* — bevels, palettes, layout grammar, type
treatment — from scratch. Theme names must be ours: `PLUS!` and `SURGE` are
working titles and both **need renaming before any public release** (`BOOST` and
`DESKTOP` are candidates).

This costs nothing creatively. Original work in a period idiom is better than a
copy, and it keeps the repo publishable.

---

## Scheduled vs backlog

The roster is a **backlog**, not a plan. Only four themes are scheduled; the rest
are specified so they're cheap to add later, and are explicitly **not** tracker
tasks.

| Scheduled | Backlog |
|---|---|
| `N2O` ✅ built · `VGA` · `REEF` · `PLUS!` | `SURGE` · `GOOP` · `METROPOLIS` · `FIELD TRIP` · `TRAIL` · `LAGOON` |

A theme leaves the backlog only when it closes a gap in the **product** — as
`REEF` did with the calm mode (D-018) — not because the reference is good.

## Sequencing

Not all at once. `N2O` is built; the next two should be the ones that prove the
theme architecture is real, by being maximally *unlike* each other:

1. **`VGA`** — because 16-colour quantisation is ~15 lines of shader on top of the
   dither we already have, and it looks radically different from `N2O` for almost
   no work.
2. **`REEF`** — because it closes the calm-mode gap (D-018), which is a product
   hole rather than a nice-to-have.
3. **`PLUS!`** — because it's the one that forces **UI chrome** into the theme
   system rather than just effects. If the architecture survives that, it works.

The rest are content, addable one file at a time once the system holds.

---

## Effect ideas, triaged

A round of suggestions, sorted by what actually applies. Recorded here rather
than in the tracker, per D-019 — these are theme-backlog until one of them
closes a gap in the *product*.

### Already built

| Idea | Where |
|---|---|
| Particles | `particles`, family D (P5-09) |
| Kaleidoscope | `kaleido`, family D — a mirror *is* a kaleidoscope with two segments, so a separate mirror pass is a parameter, not a feature |
| Cel shading | `posterize` (family C) supplies the flat bands; `edge` (family E) supplies the ink line. Together they are the look |

### Already decided

**Autostereograms** were considered and cut (P5-39/P5-40), on the grounds
recorded above: technically interesting, off-vision, and they serve the effect
rather than the music. Nothing has changed that. Reopening it is a decision, not
an addition.

### Trademarked — the idiom, never the artefact (D-015)

| Suggested | The problem | What we can build |
|---|---|---|
| Flying toasters | *After Dark*, Berkeley Systems. The toaster is the trademark | **`FLYBY`** — objects on parallax layers drifting across a dark field. Make the objects the **album covers themselves**: on-thesis, since the artwork is the source material, and it belongs to nobody else |
| 3D Pipes | The Windows 95 screensaver, Microsoft | **`PLUMBING`** — additive extruded geometry growing through space, jointed on the beat, coloured from the album palette. The *technique* is 1994 OpenGL demo, not anyone's asset |
| "Magic Eye" | Trademark of Magic Eye Inc. | Use "autostereogram" — and see above, it is cut anyway |

### Worth building, ranked

| Idea | Why it earns a place | Cost |
|---|---|---|
| **Orbit-trap fractal** (`scene`) | The strongest of the new ones. A Julia/Mandelbrot orbit that uses the **album as the trap texture** — so the cover is genuinely the source material rather than a palette donor. Zoom and rotation on `uBeat`. Pure fragment, no geometry | One scene, moderate |
| **Voxel heightfield** (`scene`) | The cover's *luminance as terrain*, flown over. Uses the artwork as data, which almost nothing else does, and the voxel-terrain look is exactly 1993–96. Reads well at 2m | One scene, moderate |
| **Starfield** (`scene`) | The other canonical period screensaver, and it is nobody's IP — it predates all of them. Cheap, calm, and a good `REEF`-adjacent resting scene | Low |
| **LED / dot matrix** (`matrix`, family E) | Not nostalgia: the panel is read at ~2m (PRODUCT.md §5.3), and a coarse emissive grid **reads at distance where fine detail does not**. This is a legibility argument that happens to look period | Low |

### Considered and not recommended

**Anaglyph (red/blue 3D).** Cheap to implement and genuinely fun — but it needs
the viewer to be wearing glasses, and this is a device on a wall that nobody is
standing in front of. It would be a novelty preset that is wrong 99.9% of the
time, and actively unpleasant the rest. Two further problems: the chain's targets
carry no depth (D-070), so it would have to fake depth from luminance; and
red-blue anaglyph destroys the colour that the whole theme system is built on.
If it ever ships it should be an explicit toy, not part of the shuffle.

**True stereoscopic.** Same glasses problem, and the display is not stereo
capable.

