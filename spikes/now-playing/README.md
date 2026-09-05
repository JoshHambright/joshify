# Spike: Now Playing — the front panel

Direction **B, the instrument** (D-038), at true panel pixels (D-039) — as a
smoked-glass control plate laid over a full-bleed album.

## What the first version got wrong

It was art-left, text-right, five identical buttons in a row: the stock media
player layout. The bevels were finish applied to a generic skeleton, which is
why they did not rescue it — **the structure was the problem**. It was also hard
to read, because text sat over unpredictable artwork.

Both faults have one fix. The album now fills the entire device and the controls
live on a single translucent plate floating over it. The plate is a **known
surface**, so contrast against it can actually be guaranteed; text over bare
artwork never can be.

**Open `index.html` in any browser.** No build, no dependencies.

## What it settles

| Question | Answer here |
|---|---|
| Does "instrument, not picture frame" actually look good? | The art sits *in* a recessed well; chrome is always present and characterful |
| Portrait or landscape? | Toggle between them. **The panel is natively 720×1280 portrait** — landscape needs a rotation in config |
| Does the contrast guarantee hold on real covers? | Accent is extracted then corrected to **4.5:1** against the chassis. The `Bone White` cover is included precisely because a near-white sleeve breaks naive theming |
| Do bevels read as period or as dated? | Toggle them off to compare |

## Techniques worth keeping

**Light comes from above, consistently.** Raised elements take a light top edge
and a dark bottom; recessed take the inverse. Two CSS custom properties
(`--raise`, `--recess`) applied by *role* — this is what makes it read as
moulded plastic rather than as boxes with shadows.

**The accent is the only live colour.** Chassis, rules and ink are fixed. One
colour moves with the album, so re-theming reads as a lamp changing rather than
the whole device repainting — and it means a hostile cover can only ever affect
one token, which is what makes the contrast guarantee tractable.

**Real WCAG correction, not eyeballing.** `ensureContrast` keeps hue and
saturation and moves only lightness, in quantised steps, so the measured ratio
belongs to the colour that ships (D-035). The near-white `Bone White` cover
exercises it.

**True-pixel panel, scaled to the viewer.** The device element is exactly
720×1280 and CSS-scaled to fit. Every measurement is the real one, so nothing
has to be re-derived when it moves to the Pi.

**Type carries the idiom.** Archivo for the title (a sturdy grotesque with real
weight), Barlow Condensed for the uppercase panel labels — it reads like
silkscreen — and Share Tech Mono with tabular figures for the readouts, so the
clock and timers do not jitter as digits change.

## Known gaps (it is a spike)

- Covers are procedurally generated, not fetched from Spotify.
- Progress advances locally with no server; the real one interpolates from a
  monotonic clock and reconciles against polls (D-024).
- Volume and queue slots are indicators, not working controls.
- Not yet run on Pi hardware — that is P3-01.
