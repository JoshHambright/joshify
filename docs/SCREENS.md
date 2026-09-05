# Joshify — Screens

The interface, specified. Settled by prototype (`spikes/now-playing/`) and the
decisions it produced: **D-038** (instrument), **D-039** (fixed fullscreen panel),
**D-040** (glass plate over full-bleed art, portrait), **D-041** (`backdrop-filter`).

This document exists because the visualiser had three design documents and the
screens people actually use had forty-five lines. That was backwards.

---

## The one idea

> **The album fills the device. One glass plate floats over it, and the plate
> grows to hold whatever you are doing.**

Now Playing is the plate at rest — short, most of the album showing. Devices,
Queue and Search are the *same plate*, taller. Nothing ever navigates "away" from
the album; the plate simply covers more of it.

That is the whole navigation model, and it is why there is no tab bar, no back
button and no page transitions to design.

---

## Panel

**720 × 1280, portrait, fullscreen.** Raspberry Pi Touch Display 2, native
orientation, no rotation configured. Nothing scrolls the panel itself — a layout
that overflows is broken, not inconvenient (D-039).

## Tokens

The five theme tokens come from the server per track (D-035/036/037) and arrive
as CSS custom properties. The UI computes nothing.

| Token | Role |
|---|---|
| `--accent` | The only colour that moves with the album. Corrected to **4.5:1** against the plate |
| `--on-accent` | Text/glyphs on an accent fill |
| `--ink` `--ink-dim` `--ink-faint` | Three levels of foreground, fixed |
| `--plate` | The glass tint, fixed |

**Only one colour changes per track.** That restraint is what makes the contrast
guarantee tractable: a hostile cover can affect exactly one token.

## Type

| Role | Face | Use |
|---|---|---|
| Display | **Archivo** 700/800 | Track titles, screen headings |
| Label | **Barlow Condensed** 600, uppercase, `.13em` tracking | Panel labels — reads like silkscreen |
| Data | **Share Tech Mono**, `tabular-nums` | Times, counts, volume. Tabular so digits do not jitter |

**Fonts must be self-hosted.** The kiosk has no guarantee of reaching a font CDN,
and a fallback face would break every measurement below.

Scale: `54 / 34 / 23 / 17 / 15 / 14`.

## Touch

Minimum target **48px**; nothing important is below 56px. No hover states, no
right-click, no tooltips. `:active` gives immediate feedback because the network
round trip does not (D-028 covers the optimistic update behind it).

---

## Now Playing — the plate at rest

The default, and roughly 95% of screen-time.

```
┌──────────────────────────────┐  720
│ ● KITCHEN  SPOTIFY CONNECT   │  status rail, 74px, floats on art
│                       21:47  │  own gradient scrim for legibility
│                              │
│         album art            │  full bleed, object-fit: cover
│        fills the panel       │
│                              │
├──────────────────────────────┤
│ ▓▓▓▓▓▓▓▓░░░░░░░░  1:04 -2:27 │  scrubber, on the plate's top edge
│                              │
│ PLAYING FROM ALBUM           │  eyebrow, accent
│ Velocity Division            │  54px, one line, ellipsis
│ Nitrous Cartel               │  23px
│                              │
│  ⤨   ⏮    ( ▶ )   ⏭    ↻     │  hierarchy, not five equal keys
│                              │
│  VOL 62   QUEUE 14  VISUAL   │  chips: their own row in portrait
└──────────────────────────────┘  1280
```

**The transport is deliberately unequal.** Play is an 96px accent disc; skip is a
bare glyph with no box; shuffle and repeat stay `--ink-faint` until active, then
go accent. Five equal-weight buttons give the eye nothing to land on — that was
most of why the first attempt read as generic (D-040).

**Chips get their own row in portrait.** They are hidden in the landscape
prototype for want of width; portrait has the vertical room, so they sit below
the transport rather than being dropped.

### States

| State | What shows |
|---|---|
| Nothing playing | Last artwork, dimmed. Plate reads *"Nothing playing"*, transport shows play only |
| No active device | Plate offers **Choose a device** as the primary action. Not an error |
| Not Premium | A plain explanation. Every control disabled, because Spotify will refuse them all |
| Offline | Last known state, the status lamp goes amber. **Never a spinner over the album** |
| Podcast | Same layout. Subtitle is the show name; skip becomes ±15s |
| Local file | Same layout, no artwork — the plate expands into the empty space |

**Never a raw error, never a spinner where last-known truth exists.** The device
is always showing something plausible.

---

## Devices — the plate, grown

The highest-value screen after Now Playing: the "move it to the kitchen" button.

Full-width rows, 88px each: name, type glyph, and volume when the device reports
one. The active device carries an accent lamp and sits first. Tapping transfers
playback and the plate falls back to rest.

**A device reporting `volumePercent: null` shows no slider at all** — several
Connect types do not report volume, and drawing a slider at 0 would be a
confident lie (D-022).

---

## Queue — the plate, grown

Rows of 76px: position, title, artist. The currently playing item is pinned at
the top and marked.

**There is no drag handle, and never will be.** Spotify's API has no reorder and
no remove endpoint (D-007). Tapping a row skips forward to it, which is the only
honest affordance. An affordance that cannot work is worse than a missing one.

---

## Search — the plate, full

The only screen that takes the whole panel, because the keyboard needs it.

On-screen keyboard across the bottom; results above, grouped by type; the query
in a mono readout. Debounced at 250ms, and results are generation-fenced so a
slow answer for "bea" can never replace a fast one for "beatles" (D-032).

Lists are virtualised — a real library is long and the device's memory is not.
Thumbnails load lazily and evict, so scrolling a thousand albums cannot grow
without bound.

**Empty query shows the library**, not a blank screen: saved albums and
playlists, paged (D-031).

---

## Visualiser

A *mode*, not a screen (VISUALIZER.md). The plate slides away, the album stays,
the effects take the panel. Any touch brings the plate back. Auto-enters after
idle — a screensaver, which is what it has been all along.

---

## What this does not cover

Settings, first-run pairing beyond `joshify auth`, and any error screen more
elaborate than a sentence. All deliberate: an appliance that needs a settings
screen has usually failed to make a decision somewhere else.
