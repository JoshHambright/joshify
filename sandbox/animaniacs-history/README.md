# The Animaniacs Playbill

A one-off, self-contained history site about *Animaniacs* (1993–1998, 2020–2023),
built in this session at the user's request.

**This is not Joshify.** It is unrelated to the Spotify touchscreen product and is
deliberately parked in `sandbox/` so it does not touch `docs/TRACKING.md`, the
roadmap, or the phase scope (see D-019). Nothing in the build pipeline references it.

## What it is

`index.html` — a single file, no build step, no dependencies. Open it directly or
publish it as an Artifact. Fonts come from Google Fonts; everything else ships in
the file.

Published: https://claude.ai/code/artifact/ffa5b1d4-d7be-4208-bd13-da91fe0bef27

## Design notes

- **Committed single theme.** The Warner backlot after dark: violet-biased near-black
  ground, cel-paint cream text, water-tower aqua as the primary accent, title-card red
  and marquee gold spent sparingly. Every colour is painted explicitly, so the page
  holds on either host ground without a light/dark token set.
- **Type.** Alfa Slab One (Clarendon slab, circus-playbill idiom) for display, Archivo
  for text, Courier Prime for production data — the face the writers' room typed in.
- **Structure follows the show.** The series was a revue, so the page is a programme:
  cold open, the setup, the run, the bill of acts, the pit, the take, the lexicon.
  Numbered markers appear only on the chronology, where order is real information.

## Techniques worth keeping

- **Marquee bulb scroll rail** — a fixed column of theatre bulbs that light with scroll
  progress, driven by one `requestAnimationFrame`-throttled scroll listener. Reads as
  ornament, works as a progress indicator.
- **Cel registration offset** — cards carry a hard `box-shadow` in their own accent
  colour, offset 7px, snapping to 3px on hover, like misaligned animation cels. Note the
  trap this replaced: an absolutely-positioned `::before` at `z-index: -1` paints *over*
  its own element's background, not behind it, even with `isolation: isolate`.
- **Reveal without hiding** — the scroll-in settle animates `transform` only, never
  `opacity`, so the page's first still frame is fully readable and nothing is stranded
  at `opacity: 0` if the observer never fires.
- **CSS-only star field and music staff** — layered `radial-gradient` and
  `repeating-linear-gradient` instead of images.

## Content

All illustration is original geometry. No studio artwork, logos, character designs or
wordmarks are reproduced — consistent with the homage-not-reproduction rule in D-015.

Sources: Wikipedia (*Animaniacs*, episode list, *Wakko's Wish*) and Variety's 2020
report on the Hulu revival.
