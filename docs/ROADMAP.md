# Joshify — Phased Build Plan

Status: `DRAFT v1` · Last updated: 2026-09-02
Companion documents: [PRODUCT.md](./PRODUCT.md) · [TRACKING.md](./TRACKING.md) · [DECISIONS.md](./DECISIONS.md)

---

## How we work

Each phase has an **exit criterion** — a demonstrable, testable thing. We don't
start phase N+1 until phase N's exit criterion is met and green in CI.

Every phase ships with tests. There is no "testing phase"; a phase is not done if
it isn't tested.

The **riskiest unknowns are pulled forward deliberately**: the two things most
likely to sink this project are (a) the OAuth first-run flow on a headless
appliance and (b) whether a Zero 2 W can actually render the UI we want. Both get
a hardware spike well before we've built enough to be painful to change.

---

## Phase 0 — Foundation

*Goal: an empty but rigorous repo. Everything after this is downhill.*

Scaffold the pnpm monorepo, TypeScript config, linting, formatting, the test
runner, and a CI pipeline that runs on every push. Establish `packages/core`
(pure domain logic, zero I/O) as the place where all the interesting, testable
code lives.

**Exit criterion:** `pnpm verify` (lint + typecheck + test + build) passes locally
and in GitHub Actions on a trivial placeholder module.

---

## Phase 1 — Spotify identity & the API client

*Goal: we can hold a valid token indefinitely and make typed calls.*

The Authorization Code + PKCE flow, an encrypted-at-rest token store, and
transparent refresh-ahead-of-expiry. A typed Spotify client wrapping only the
endpoints we actually need, with rate-limit handling (`Retry-After`) and
sane error taxonomy.

Critically, this phase also builds the **fake Spotify server** — a local
stand-in that speaks the same shapes. Every later phase tests against it, so CI
never needs real credentials and we can simulate failures on demand.

**Risk spike (do this first):** prove the loopback-redirect PKCE flow works for a
device with no keyboard. Spotify now rejects `localhost` and non-HTTPS redirects,
so the first-run experience needs a real answer before we build around it.

**Exit criterion:** a CLI command authenticates a real account, persists tokens,
survives a process restart, and refreshes without user interaction.

---

## Phase 2 — The playback state engine

*Goal: a correct, smooth model of "what is playing", headless.*

The adaptive polling scheduler, local progress interpolation, optimistic command
application with reconciliation, and normalisation of Spotify's messy player
payloads into one clean `PlaybackState`. All of this is pure logic in
`packages/core` driven by an injected clock — meaning it is **fully unit
testable with no network and no timers**.

Then the local transport: Fastify serving a REST command API and a WebSocket that
pushes state diffs to any connected UI.

**Exit criterion:** with the server running and music playing on a phone, a
terminal WebSocket client shows a smoothly-advancing, accurate playback state,
and commands sent over REST control real playback.

---

## Phase 3 — Now Playing (the hero screen)

*Goal: the thing the product actually is.*

Server-side theme extraction and blur pre-rendering (§8.1 of PRODUCT.md), the
image cache, and then the Svelte UI: album art, drifting blurred backdrop,
art-derived control theming, transport controls, and the interpolated progress
bar.

**Hardware spike (do this early in the phase):** get *something* rendering on the
real Zero 2 W under `cog` and measure it. If WPE can't do it, we need to know now,
not at Phase 7.

**Exit criterion:** on real hardware, a full-screen Now Playing view that tracks
real playback, re-themes on track change, and holds a steady frame rate.

---

## Phase 4 — Control surfaces

*Goal: the Pi becomes genuinely more convenient than your phone.*

The Devices screen (list + transfer playback), the Queue view, volume control,
and touch scrubbing. Navigation between surfaces, sized and gestured for fingers.

Queue is view + add + jump-by-skip; reordering is not possible via the API
(PRODUCT.md §6) and the UI will not pretend otherwise.

**Exit criterion:** playback can be moved between real devices, volume changed,
and a track scrubbed — entirely by touch, on hardware.

---

## Phase 5 — Visualizer

*Goal: the sick part. Winamp-lineage visuals driven by the album art.*

A WebGL2 post-processing engine that takes the album cover as its source texture
and runs it through a composable chain of shader passes: Milkdrop-style feedback,
glitch and datamosh, VHS/CRT degradation, and the classic spectrum bars.

The hard problem is reactivity, since Spotify's audio endpoints are gone. We solve
it with **three interchangeable providers behind one uniform contract** —
procedural (always works), BPM-lookup by ISRC (works while remote-controlling),
and real FFT off the librespot PCM tap (when the Pi plays the audio). The shaders
never know which one is feeding them.

Presets combine effects into named looks and can shuffle on track change. The
visualizer is a *mode*, with an auto-enter-on-idle screensaver behaviour.

Key insight: rendering at half resolution cuts fragment cost 4x **and is the
lofi aesthetic we want anyway**. The performance dial and the art direction are
the same slider.

Full design in [VISUALIZER.md](./VISUALIZER.md).

**Exit criterion:** on real hardware, a full-screen visualizer holding its frame
budget, reacting to the beat, with preset switching by touch and a measured
legibility floor behind the controls.

---

## Phase 6 — Search & library

*Goal: you never need to reach for your phone.*

An on-screen keyboard, debounced multi-type search, and browse of saved albums
and playlists. Long lists are virtualised — this is the screen most likely to
blow the memory budget, so list rendering gets explicit attention and its own
performance test.

**Exit criterion:** find and play an arbitrary track from the touchscreen alone,
with the list scrolling smoothly on hardware.

---

## Phase 7 — Appliance & hardening

*Goal: it stops being a program and becomes a device.*

Boot-to-app: systemd units, `cog` in kiosk mode on DRM/KMS with no desktop,
splash screen, display/rotation config, and screen blanking behaviour. Then the
resilience work: network loss, Spotify outages, token expiry, and a long-run soak
test for leaks. Finally the on-device performance pass against the §9 budgets.

**Exit criterion:** all seven success criteria in PRODUCT.md §9 are measured and
met, including the 7-day soak.

---

## Phase 8 — Packaging, CI/CD & the optional audio module

*Goal: someone else can install it.*

Multi-arch (`linux/arm64`) container images built in CI, a one-line install
script that sets up the systemd services, a release pipeline with versioned
artefacts, and real installation documentation.

Then the opt-in `librespot` module, so the Pi can *also* be a Connect target.
It lands last deliberately: it's a bonus, and it must never be able to break the
core install.

**Exit criterion:** a clean Pi goes from blank SD card to working Joshify by
following the README, in under 30 minutes, with no manual code steps.

---

## Sequencing rationale

```
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 ──► P7
       │             │
       │             └── HW spike: can a Zero 2 W render this?
       └── Risk spike: does headless PKCE actually work?
```

- **P1 and P2 are headless.** We build and fully test the hard logic before any
  pixel exists, because debugging a polling scheduler through a UI is misery.
- **The fake Spotify server (P1) is load-bearing.** It's what makes P2–P5
  testable in CI at all.
- **P3 before P4/P5** because Now Playing is 95% of the screen-time. If we only
  ever shipped Phase 3, the product would still be worth having.
- **P6 before P7** because there's no point packaging something that isn't stable.
- **P7's librespot module is last** so it can be cut without consequence.
