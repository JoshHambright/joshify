# Joshify — Build Tracker

**This is the live source of truth for build progress.** Update it in the same
commit as the work it describes.

Last updated: 2026-09-06

---

## How to use this tracker

Every task has a stable ID (`P2-04`). Reference it in commit messages and PR
titles: `P2-04: add progress interpolation to PlaybackState`.

**Status key**

| Symbol | Meaning |
|:---:|---|
| ⬜ | Not started |
| 🟨 | In progress |
| ✅ | Done, tested, merged |
| 🔬 | Spike / research — timeboxed, may produce a decision not code |
| ⛔ | Blocked (blocker noted inline) |
| ❌ | Cut from scope (reason noted inline) |

**Rules**
1. A task is only ✅ when its tests pass in CI. Not when the code "works".
2. Any task that produces a non-obvious choice gets an entry in [DECISIONS.md](./DECISIONS.md).
3. If a task turns out to be wrong, mark it ❌ with a reason. Don't delete it —
   the record of what we chose *not* to do is worth as much as the rest.

---

## Progress summary

| Phase | Title | Tasks | Done | Status |
|---|---|:---:|:---:|---|
| 0 | Foundation | 8 | **8** | ✅ **Complete** |
| 1 | Spotify identity & API client | 11 | **10** | ✅ Code complete (1 cut) — awaiting a real-account run |
| 2 | Playback state engine | 10 | **10** | ✅ **Complete** |
| 3 | Now Playing | 14 | 13 | 🟨 Code complete — P3-01 needs hardware |
| 4 | Control surfaces | 10 | 8 | 🟨 In progress |
| 5 | **Visualizer + librespot** | 39 | 18 | 🟨 In progress (3 cut) |
| 6 | Search & library | 9 | 8 | 🟨 In progress |
| 7 | Appliance & hardening | 12 | 8 | 🟨 In progress |
| 8 | Packaging, CI/CD & audio module | 11 | 5 | 🟨 In progress |
| | **Total** | **123** | **90** | |

---

## Phase 0 — Foundation

> **Exit criterion:** `pnpm verify` passes locally and in GitHub Actions.
> ✅ **Met** — [run #1 green](https://github.com/JoshHambright/joshify/actions/runs/33610057450) on `79ff85b`.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P0-01 | Clear the feature branch and scaffold the pnpm workspace | ✅ | `packages/core`, `apps/server`, `apps/ui`. pnpm 10 + Node 22 |
| P0-02 | Base TypeScript config (strict) shared across workspaces | ✅ | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, project references |
| P0-03 | ESLint + Prettier, wired to a single `pnpm lint` | ✅ | `strictTypeChecked`. Caught a real unsound generic on its first run |
| P0-04 | Vitest set up with coverage reporting | ✅ | v8 provider, 90% thresholds. Currently 100% |
| P0-05 | `pnpm verify` composite script (lint + typecheck + test + build) | ✅ | One command; CI runs exactly this |
| P0-06 | GitHub Actions CI workflow on push + PR | ✅ | Node from `.nvmrc`, pnpm cache, `--frozen-lockfile` |
| P0-07 | Repo hygiene: `.gitignore`, `.nvmrc`, `.env.example`, LICENSE | ✅ | `.env` gitignored. MIT licence |
| P0-08 | README skeleton pointing at the docs | ✅ | Commands, layout, and the docs map |

---

## Phase 1 — Spotify identity & API client

> **Exit criterion:** CLI authenticates a real account, persists tokens, survives restart, refreshes unattended.
> 🟨 **Code complete and fully tested against the fake Spotify.** The remaining
> half needs a human at a browser: Josh runs `joshify auth` against the real
> account once. That is the first moment any of this touches Spotify for real.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P1-01 | 🔬 **Spike: headless PKCE** | ✅ | **Solved.** Device Grant is allowlisted to Spotify's own TV apps — unusable. PKCE + loopback works; the Pi authorises on its own touchscreen. [`spikes/pkce-loopback/`](../spikes/pkce-loopback/) |
| P1-02 | Register the Spotify app; document required scopes | ✅ | App created. Redirect `http://127.0.0.1:8080/callback` (+ IPv6 and 8888 spare) |
| P1-03 | ~~Store client credentials in GitHub Secrets~~ | ❌ | **Cut.** PKCE uses no client secret, and CI runs against the fake server — so there is nothing to store. Client ID lives in a gitignored `.env` |
| P1-04 | PKCE challenge/verifier generation + authorize URL builder | ✅ | Pure, injectable randomness, 17 tests. Validated against RFC 7636 Appendix B |
| P1-05 | Token exchange + refresh logic with expiry-ahead scheduling | ✅ | 80% of TTL with a 30s floor; keeps the refresh token when Spotify omits it. Tested over real HTTP against the fake |
| P1-06 | Token store: encrypted at rest, atomic writes | ✅ | AES-256-GCM, local `0600` key, write-temp→fsync→rename→fsync-dir. 22 tests incl. tampering, wrong key, failed-save-keeps-previous. Threat model stated honestly (D-021) |
| P1-07 | Typed Spotify HTTP client (only the endpoints we need) | ✅ | Transport only — returns raw payloads so shape-parsing stays in the P2-01 normaliser. 204 → null |
| P1-08 | Rate-limit handling: honour `Retry-After`, backoff | ✅ | Full-jitter exponential backoff; obeys `Retry-After`; never retries what cannot succeed. Proactive budget deferred to P2-03, which owns request volume |
| P1-09 | Error taxonomy: auth / rate-limit / network / no-device / not-premium | ✅ | 8 kinds chosen by *what the device should do*, not by status. 403 splits on message: scope vs Premium |
| P1-10 | **Fake Spotify server** for tests — same shapes, scriptable failures | ✅ | Real HTTP on a loopback port, so the code under test does real `fetch`, real form encoding, real status handling. Scriptable failures, recorded requests. Every suite in P1–P2 runs against it; CI never needs a credential |
| P1-11 | `joshify auth` CLI command for first-run setup | ✅ | Also `status` and `logout`. Flags a non-Premium account at setup rather than letting every control 403 later |

---

## Phase 2 — Playback state engine

> **Exit criterion:** a WebSocket client shows accurate, smooth state; REST commands control real playback.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P2-01 | `PlaybackState` model + normaliser for Spotify's player payloads | ✅ | Tracks, episodes, local files, null device/item/volume/progress. `show` beats `type` as the episode signal. Absence modelled, not defaulted (D-022) |
| P2-02 | Injected clock abstraction | ✅ | Wall-clock and monotonic kept separate — the Pi 5 has no RTC and steps its clock on first network contact (D-023) |
| P2-03 | Adaptive polling scheduler | ✅ | Sized as a request budget, not by feel (D-025). Hard floor so an upstream bug cannot flood |
| P2-04 | Local progress interpolation between polls | ✅ | Monotonic only. A stale poll never rewinds the bar (D-024); local files keyed by title+duration since they have no id |
| P2-05 | Optimistic command application + reconciliation | ✅ | Two-axis: settle window **and** which value came back, so another device is adopted in one poll rather than one window (D-028) |
| P2-06 | Transport command handlers (play/pause/next/prev/seek/shuffle/repeat) | ✅ | Plus volume and device transfer. Exact query strings asserted — Spotify ignores unknown params rather than rejecting them (D-026) |
| P2-07 | Fastify server + localhost-only binding | ✅ | Loopback default asserted by a real refused LAN connection. Plus `Host` validation against DNS rebinding and JSON-only bodies against cross-origin forms (D-034) |
| P2-08 | WebSocket state push with diffing | ✅ | Diffs carry `from` as well as `version`; an unchanged tick sends nothing (D-033) |
| P2-09 | Reconnect/resume semantics for the UI socket | ✅ | Recovery is always a fresh snapshot — no replay buffer, so no second correctness path |
| P2-10 | Full unit suite for the engine against the fake server | ✅ | The wording undersold it: there was no engine — P2-01…09 were parts nobody composed. `engine/playback-engine.ts` is that composition; 24 tests drive it against the fake with an injected clock and a hand-driven scheduler, so the whole loop runs without a real timer (D-042) |

---

## Phase 3 — Now Playing

> **Exit criterion:** full-screen Now Playing on real hardware, re-themes on track change, steady frame rate.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P3-01 | 🔬 **Spike: render on real Pi 5. Chromium vs `cog`.** Measure FPS + RSS | ⬜ | **Second-highest risk.** Settles the kiosk runtime with numbers. Do before building the real UI |
| P3-02 | Album art fetch + on-disk cache (640px hero, 64px source) | ✅ | Buffered then temp→fsync→rename, so a dropped connection cannot truncate. True LRU eviction for an appliance running for months (D-037) |
| P3-03 | Server-side theme extraction → token set | ✅ | Accent is salience, not dominance — a small hot-pink logo beats the grey card it sits on (D-036) |
| P3-04 | Contrast checking / correction on derived colours | ✅ | 4.5:1 for anything text can land on, 3:1 for chrome. AAA rejected as unreachable, so the guarantee is true (D-035). 121 hostile pairings tested |
| P3-05 | Server-side blur pre-render, served as a static image | ✅ | The render already existed in the pipeline; what was missing was serving it. `GET /api/artwork/:key[/:kind]` answers from the device's own cache, content-addressed and marked `immutable`. Keys are validated as whole strings against lowercase hex — an allowlist cannot express a traversal, which a `..` check both would and could not (D-054) |
| P3-06 | Svelte app shell + WebSocket client store | ✅ | Vite + Svelte 5. The panel is three slots — stage, rail, plate — which is the whole navigation model. The store implements the Svelte contract by hand so its reconnect logic is testable in Node against a fake socket (D-043). Desktop fit uses `zoom`, not `transform`: `transform` scales paint but not the layout box, which is what overflowed the first prototype |
| P3-07 | Theme application via CSS custom properties | ✅ | Token *contract* moved to core so both ends share one definition; extraction stays server-side. Fixed chrome is `--jf-*`, the album's five are `--joshify-*`, so a rule says which half can change under you. Hex is validated before writing — a bad custom property is not an error, it is a silently unstyled panel |
| P3-08 | Album art hero component + crossfade on track change | ✅ | The outgoing frame is held until the incoming one has *pixels* — `load` **and** `decode()` — because swapping on `load` alone flashes empty surface on every track change. Keyed on the image URL, not the track: two tracks from one album share a cover (D-045) |
| P3-09 | Drifting blurred backdrop | ✅ | Procedural motion only (no audio-reactivity exists — D-010). Drift on the wrapper's transform, blur on the image: a filter is dear to rasterise and cheap to re-composite, so it is computed once per track. Source is the 64px variant — downscale-then-upscale is a free blur |
| P3-10 | Transport control components (≥48px targets) | ✅ | Reachable and composed into the panel. Deliberately unequal per D-040: 96px accent play disc, bare skip glyphs, toggles at `--jf-ink-faint` until active. Glyphs are drawn SVG, not characters — the self-hosted faces carry no media symbols, so text would render tofu |
| P3-11 | Interpolated progress bar rendering | ✅ | Reachable and composed into the panel. Frame loop runs only when something moves — paused, none; dragging, none. Zero extra API calls. Transport and Scrubber run the *same* pure model rather than sharing a value, so they cannot disagree (D-046) |
| P3-12 | Idle / nothing-playing / not-Premium states | ✅ | `PlaybackNotice` composed into the plate. Offline returns *no* notice when a last known state exists — the amber lamp does the talking, and a banner over a working screen is the spinner mistake in another costume |
| P3-14 | **Put the account's Premium flag on the wire** | ✅ | Read once at engine start and published. Three-valued: `null` until asked, and a failed profile read leaves it null rather than guessing |
| P3-13 | **Deliver the theme over the wire** | ✅ | `PanelState` (core) = playback + `theme` + `themeFor` + `isPremium`, flat so the diff stays granular. The engine publishes the track first and the colour when extraction lands; the UI holds the *previous* album's colour across the gap rather than flashing grey. Generation-fenced, so a slow decode cannot repaint the wrong track (D-050). Prepared artwork URLs ride along too, now that P3-05 serves them. Artwork takes the *opposite* staleness rule from colour: it follows the item strictly, because a stale accent is invisible for 300ms and a stale album cover is not (D-053) |

---

## Phase 4 — Control surfaces

> **Exit criterion:** move playback between real devices, change volume, scrub — by touch, on hardware.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P4-01 | Device list endpoint + polling | ✅ | `GET /api/devices` serves the normalised list. An unreadable entry is dropped, not fatal — refusing to draw six working speakers because a seventh reported something odd is the wrong trade. `device-source.ts` polls at 5s **only while the Devices surface is open** — a wall panel showing Now Playing has no use for a fresh list, and polling one for hours spends the budget the transport needs (D-049) |
| P4-02 | Devices screen UI with active-device indicator | ✅ | Reachable and composed into the panel. Restricted devices (`id: null`) stay listed but dimmed and untappable — dropping them leaves the viewer hunting for a speaker Spotify can see and Joshify apparently cannot |
| P4-03 | Transfer playback on tap | ✅ | Reachable and composed into the panel. The **active** device is not a transfer target: moving playback to where it already is achieves nothing, and a control that visibly does nothing reads as broken |
| P4-04 | Queue fetch + Queue screen | ✅ | `queue-source.ts` mirrors `device-source.ts` exactly — one pattern for "a screen that polls a list" beats two clever ones. Current item pinned outside the scroller; upcoming rows go through the existing `VirtualList` (a 300-item queue draws 11) |
| P4-05 | Document queue-reorder impossibility in the UI | ✅ | Rows are inert — no button, no `:active`. Building the screen found the *third* missing endpoint: no jump-to-position either. Walking there with repeated `next` was considered and rejected (D-051). **Corrected `SCREENS.md`**, which had specified tap-to-jump |
| P4-06 | Volume slider + device volume support detection | ✅ | Reachable and composed into the panel. `volumePercent: null` draws **no slider at all** (D-022). Commits once on release, not per drag frame — one command per gesture, not fifty |
| P4-07 | Touch scrubbing on the progress bar | ✅ | Reachable and composed into the panel. On release the tracker re-anchors at the chosen position so the bar runs on through the round trip instead of snapping back. A track change under a held finger drops the drag — the fraction was chosen against the old duration |
| P4-08 | Navigation model between surfaces | ✅ | The plate grows, and a flick down shrinks it — the idiom every touchscreen has used for a decade. Two ways to qualify: a slow drag that goes far enough, or a fast flick that does not. Upward drag is rubber-banded, because the plate has nowhere to go up (D-057). The Done button stays: a control reachable only by a known gesture is one most people never find |
| P4-09 | Shuffle / repeat toggles wired to real state | ✅ | Reachable and composed into the panel. Repeat cycles off → context → track, matching Spotify's own clients; `aria-pressed` cannot express three states, so the mode rides on `data-repeat` |
| P4-10 | Component + interaction tests for all control surfaces | ✅ | Transport, Scrubber, VolumeSlider, DeviceList, QueueList, SearchScreen, Keyboard, VirtualList, PlaybackNotice, Backdrop, Hero and the four surfaces in `App.svelte`. Closed by the last gap, `Thumbnail` — whose stated rules (absent artwork is a state and draws no `<img>`, the URL comes from the cache under the row key, a row seen before appears rather than fading again) were only ever asserted about the cache, never about the row |

---

## Phase 5 — Visualizer

> **Exit criterion:** full-screen visualizer on hardware, holding frame budget, beat-reactive, preset switching by touch, legibility floor measured.

Design: [VISUALIZER.md](./VISUALIZER.md) · [PS1_MODE.md](./PS1_MODE.md) · [THEMES.md](./THEMES.md)

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P5-01 | WebGL2 render pipeline: ping-pong FBOs, pass chain, uniform contract | ✅ | **Three** targets, not a pair — a pair loses last frame's image to the scene, which is the read-write-same-texture bug and looks like a driver fault (D-061). Presets are data: a pass's params map onto uniforms, so an effect is a JSON entry rather than a branch. Split so the decisions test in Node against a recording fake |
| P5-02 | 🔬 **Spike: BPM source bake-off.** Coverage test against Josh's real library | ⬜ | GetSongBPM vs AcousticBrainz dump vs Deezer-by-ISRC |
| P5-03 | `ReactivityProvider` interface + Tier 0 procedural implementation | ✅ | A fixed period reads as a screensaver and jitter reads as broken, so Tier 0 layers beat/bar/phrase, accents the bar, and drifts ±6% over 37s — computed as a **closed-form integral**, because recomputing `t·bpm(t)/60` per frame retroactively moves every past beat and makes the pulse jitter instead of speed up (D-063). Frame is provider-owned and reused: zero allocation per frame |
| P5-04 | Tier 1: ISRC→BPM lookup, permanent disk cache, phase-locked pulse | 🟨 | Client half done: the phase-locked pulse, and `setAnchor` absorbing poll jitter the way D-024 does for the progress bar — at 120 BPM a ±100ms stale poll is ±20% of a beat, so the pulse would trip once per poll. **Server half (ISRC lookup + disk cache) still to do**, and it is blocked on P5-02's bake-off |
| P5-05 | Tier 2: PCM tap + FFT + beat detection | ⬜ | librespot `--backend pipe`: s16le, 44.1kHz, stereo. **Gated on V1** |
| P5-06 | Effect family A — feedback (zoom tunnel, rotational, warp, echo) | ⬜ | The Milkdrop core technique |
| P5-07 | Effect family B — glitch (RGB split, block displace, pixel sort, tear, dropout, bit crush) | ✅ | Six passes, 16 fetches for the family. "Pixel sort" is named `smear` and is honestly a thresholded running maximum — a real sort needs scatter and a data-dependent loop, neither of which a fragment shader on a tiler has. `dropout` punches through to `uArt`, so corruption *reveals the cover* rather than replacing it with noise |
| P5-08 | Effect family C — analog lofi (VHS wobble, CRT, grain, dither, posterize, bloom, halftone) | ✅ | Every pass documents what it does to contrast, for P5-16. The CRT scanline is `1 + sin(πy)k`, which averages to exactly 1.0 across two rows — the naive `0.5 + 0.5sin` everyone writes is a 50% luminance cut. Bloom is a single-pass two-ring Kawase gather: 9 fetches read 33 texels, because the 6-pass budget and three targets rule out a real pyramid |
| P5-09 | Effect family D — Winamp classics (spectrum bars, oscilloscope, kaleidoscope, particles) | ✅ | Bars and scope are **overlays** — a 1px bar edge through a half-res upscale is a bar chart seen through a wet window. Kaleido cannot be one: it re-samples what is beneath it, so with no `uTexture` it has nothing to mirror. The scope is honestly a **resynthesis** — sixteen harmonics at the band amplitudes, i.e. the waveform *of a signal with this spectrum*, not of the track, because a magnitude spectrum carries no phase (D-069) |
| P5-10 | Effect family E — art-derived (shatter, palette cycle, slit-scan, displacement) | ✅ | Plus `edge` and `matrix`. `cycle`'s palette is a **Vogel sunflower over the cover** — a real extraction needs a readback the engine forbids, and consecutive sunflower entries are never neighbours, so rotating the table reads as a cycle rather than a slow pan. `slitscan` is honestly a per-row one-pole filter, not a tap delay: there is one frame of history (D-061), so no row corresponds to an exact frame and the docblock says so (D-072) |
| P5-11 | Tap-tempo / nudge-phase touch control | ✅ | Three controls, not one: phase takes **one** tap, tempo takes **four**, nudge moves 1/16 of a beat. Estimator is least-squares through (beat number, instant) — the mean interval telescopes to `(last−first)/(n−1)` and throws the middle taps away. A bounced touch is rejected; a *missed* beat is not, because it is a good observation two beats along (D-064) |
| P5-12 | Preset system: named looks, touch switching, shuffle-on-track-change | ✅ | Six looks — `Ghost`, `VHS`, `Datamosh`, `Newsprint`, `Vapor`, `Tunnel` — each a scene id, an ordered list of pass ids and some numbers. No code path per look, which is the test of whether "presets are data" was true or merely asserted. A look naming a pass somebody renamed is dropped with a reason rather than taking the visualiser down |
| P5-43 | **Flash floor** — beat-driven luminance capped below the photosensitivity threshold | ✅ | WCAG 2.2 §2.3.1 is three flashes a second, which is **180 BPM** — drum and bass, not an exotic tempo. `REEF` was described as "no strobe" as a property of one theme; nothing stopped `N2O` or `SURGE` crossing the line on ordinary music, on a wall, unattended. Enforced on `uBeat` in the uniform build, so no effect can bypass it and effects nobody has written are covered (D-071) |
| P5-13 | Half-resolution render + upscale, exposed as a "grain" slider | ✅ | A scale factor, not a boolean — `uResolution` is the size *that stage* renders at, not the panel |
| P5-14 | Auto-degrade on missed frames (drop scale, then passes) | ✅ | 45-frame window, degrade above 20% missed, recover below 2% after 3s. **The window is cleared on every change** — without it one bad second walks the ladder to the floor before the first step has been measured. Dwell is counted in frames, so a backgrounded tab cannot wait it out. Scene is never dropped; overlays go last |
| P5-15 | Visualizer modes: Now Playing / Ambient / Full / auto-enter on idle | 🟨 | State machine done; wiring into the panel waits on the effect families. **The touch that wakes it is swallowed** — delivering it means a tap meant to bring the controls back also lands on whatever control was under the finger (D-067). Ambient keeps the chrome; that is the whole difference between it and Full |
| P5-16 | **Legibility floor test** — contrast behind text at any intensity | ✅ | Proved as a property of the *plate*, not of any preset: if every possible backdrop composites to something the ink still contrasts against, no effect can break it — including ones nobody has written. **It found a live bug**: over a white sleeve the subtitle was at 2.7:1, below the 4.5 floor, before any visualiser existed (D-068) |
| P5-17 | Headless engine tests driven by a scripted reactivity sequence | ✅ | 105 tests, all in Node. One file touches a GL API; everything else asserts against a fake that records calls *and* the bind state each draw happened under — so a stale binding shows up rather than vanishing |
| P5-18 | `librespot` install + run as a Spotify Connect target | ⬜ | Promoted from Phase 8 by D-013. **Opt-in** — Tiers 0-1 must work without it |
| P5-19 | PCM tee: librespot pipe backend -> ALSA **and** -> server | ⬜ | s16le / 44.1kHz / stereo. Must not add audible latency |
| P5-20 | Audio output on Pi 5: USB DAC support + detection | ⬜ | **Pi 5 has no 3.5mm jack.** USB DAC preferred over a HAT (GPIO/case conflict) |
| P5-21 | librespot device surfaces in the Devices screen | ⬜ | Moved from P8-10 |
| P5-22 | **Scene stage** ahead of the post chain (`flat` \| `tunnel`) | ✅ | The chain cannot tell which scene produced its input — asserted by planning the same chain over both scenes and comparing |
| P5-23 | Tunnel scene: ring geometry, camera, curve-with-near-fade | ✅ | Ported from `spikes/n2o-tunnel/`. Painter's ordering is now real — the spike leaned on `cullFace(FRONT)`, and with no culling in the context, draw order is the *only* thing deciding what is in front, so indices emit far ring first. Also a `w == 0` guard the spike lacked: one ring on the camera plane makes one NaN vertex and takes the whole triangle |
| P5-24 | PS1 artefact shader set (all six, individually toggleable) | ✅ | Only **two** are post passes. Vertex snap and affine mapping are properties of the interpolation between vertex and fragment stages; no-z-buffer is pipeline state and index order; and fog needs *distance*, which the chain's RGBA8 targets do not carry — a post fog could only fake it from screen position, which comes apart the moment the tunnel bends (D-070) |
| P5-25 | Album art as tunnel texture: 256px, `NEAREST`, `REPEAT` | ✅ | The mesh never moves; the vertex shader scrolls it by a whole ring, which is invisible **iff** consecutive rings carry the same texture content — so the V step must be a whole number of copies. `buildTunnelGeometry` throws on fractional repeats, so a seam cannot be built by accident |
| P5-26 | `N2O` preset — speed, radius and flash bound to `uBeat` | ✅ | Shipped as the `Tunnel` look. The scene alone, with its two artefact passes: stacking post over it wastes budget the geometry needs |
| P5-27 | PS1-idiom UI chrome for Now Playing | ⬜ | **Original assets only** (D-015). PS1 BIOS CD player is the reference |
| P5-28 | Original attract / boot sequence | ⬜ | Also covers the P7-05 boot handoff |
| P5-29 | Combination presets: tunnel + datamosh / VHS / pixel sort | 🟨 | The mechanism works — the chain cannot tell which scene produced its input — and the six named looks prove the shape. The specific tunnel-plus-glitch combinations want a look at a real screen first |
| P5-30 | Measure the tunnel on Pi 5 hardware | ⬜ | Folded into the P3-01 measurement |
| P5-31 | **Theme bundle format**: palette + scene + chain + chrome as one unit | ✅ | `gl/themes.ts`. A theme resolves a look id, an allow-listed chrome set, and *optionally* a pinned palette — pinning is the exception a theme justifies in a comment, since the album's colour arriving on the panel is the product. A pinned palette is held to the same four pairings the extractor's output is (`themeContrastProblems`, now shared from core) and a theme that fails is dropped rather than shown |
| P5-32 | Tokenise UI chrome so themes can reach it | ✅ | `lib/chrome.ts` — an allow-list of eight properties, not the whole `--jf-*` half. The inks, the plate substrate, the touch floor and the type scale stay unreachable, because the legibility floor (D-068) was solved for *those* values and a theme that breaks it fails no test (D-073) |
| P5-33 | `VGA` theme — 16-colour quantise + ordered dither | ✅ | Zero new shader lines in the end: a `vga` look (`posterize` → `dither` at two stops a channel) plus the first pinned palette and the first chrome override set. Eight stops cannot absorb an arbitrary sleeve hue, which is *why* it pins |
| P5-34 | `PLUS!` theme — bevelled chrome + `ambient` scene | ⬜ | **Working title, must be renamed** (D-015). Proves chrome theming works |
| P5-35 | `ambient` scene — slow geometric solids | ⬜ | The Plus!-era screensaver lineage |
| P5-36 | Theme switching UI + shuffle-on-track-change | ⬜ | |
| P5-37 | `reef` scene — caustics, god rays, drifting silhouettes | ⬜ | **The calm mode** (D-018). Product gap, not a nice-to-have |
| P5-38 | `REEF` theme — slow, dark, no strobe, safe to leave running | ⬜ | The tonal opposite of `N2O` |
| P5-39 | ~~Spike: autostereogram from the depth buffer~~ | ❌ | **Cut.** Technically interesting, but off-vision — it serves the effect, not the music. Notes kept in THEMES.md |
| P5-40 | ~~Autostereogram effect pass~~ | ❌ | **Cut** with P5-39 |
| P5-41 | ~~`LAGOON` theme~~ | ❌ | **Cut from schedule** — moved to the theme backlog, not a tracked task |

---

## Phase 6 — Search & library

> **Exit criterion:** find and play an arbitrary track from the touchscreen alone, scrolling smoothly.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P6-01 | Search endpoint proxy with debouncing + cancellation | ✅ | Generation-fenced after the await, so a slow "bea" cannot overwrite a fast "beatles" (D-032) |
| P6-02 | On-screen keyboard component | ✅ | Reachable from the Search chip. 62px keys from stated arithmetic: `(720 − 28 padding − 72 gaps) / 10`. Shift is one-shot → lock → off |
| P6-03 | Search results UI (tracks / albums / artists / playlists) | ✅ | Reachable. `search-source.ts` fences on the client as well as the server: the session guards its own idea of the newest query, but responses can still be reordered on the way back (D-052) |
| P6-04 | **Virtualised list component** | ✅ | Reachable, and reused by the Queue screen. Height is a prop, never measured — jsdom reports 0×0 and D-039 makes the panel arithmetic anyway |
| P6-05 | Saved albums browse | ✅ | Paged. Advances by rows **sent**, not rows kept — Spotify ships null rows (D-031) |
| P6-06 | Playlists browse + playlist detail | ✅ | Server side done; the UI is P6-03 |
| P6-07 | Play-in-context from any result | ✅ | An album or playlist plays *in context* so the queue fills with the rest of it. A track uri sent as a context would be refused, and an album sent as a track would drop everything after the first song |
| P6-08 | Thumbnail loading strategy for long lists | ✅ | Reachable. Virtualisation is the real eviction — unmounted rows take their decoded bitmaps with them. The bookkeeping is an LRU bounded at 128, because an unbounded map is a leak that shows up in month three, not in a test |
| P6-09 | Performance test: long-list scroll on hardware | ⬜ | Explicit budget, fails CI-on-hardware if exceeded |

---

## Phase 7 — Appliance & hardening

> **Exit criterion:** all seven PRODUCT.md §9 success criteria measured and met.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P7-01 | 64-bit Raspberry Pi OS Lite base image documented | ✅ | Bookworm 64-bit, Lite (no desktop). [`docs/APPLIANCE.md`](./APPLIANCE.md) |
| P7-02 | Kiosk browser on DRM/KMS, no desktop environment | ✅ | `deploy/kiosk/joshify-kiosk` ships **three modes** behind one `Environment=` line — Chromium on DRM (recommended), Chromium under `cage`, and `cog`. P3-01 changes a setting, not a design; the three thresholds that would flip the recommendation are tabled in APPLIANCE.md |
| P7-03 | systemd unit for `joshify-server` | ✅ | Deliberately **not** `Wants=network-online.target`: waiting for NetworkManager can eat 30s of the 60s cold-boot budget for a wait the server does not need (D-048). `systemd-analyze verify` caught `StartLimitIntervalSec` sitting in `[Service]`, where systemd ignores it silently |
| P7-04 | systemd unit for the kiosk UI | ✅ | `After=` only proves the server was *exec'd*. Readiness is a bounded `/health` poll in the launcher — the same endpoint the UI's own reconnect loop uses. `Type=notify` was rejected because nothing calls `sd_notify`, and declaring it would make systemd wait for a signal that never comes |
| P7-05 | Boot splash → app handoff with no flicker or console text | ✅ | 20 things that would otherwise appear, each with the setting that suppresses it. The one most often missed: `--default-background-color=ff101114`, or the browser paints white before first paint. The plymouth theme must be the same `#101114`, or three stages each shift shade and read as flicker |
| P7-06 | Display config: resolution, rotation, blanking policy | ✅ | 720×1280 native portrait, **no rotation** (D-039). `consoleblank=0` and no DE screensaver. Traded away: backlight hours and ~2–3W; the mitigation is the design itself, and the future lever is scheduled dimming via sysfs rather than blanking |
| P7-07 | Network-loss resilience + offline state | ✅ | The screen keeps its last truth and the lamp goes amber (D-048); the loop notices the transition in *both* directions, because nothing else in the system finds out Spotify has started answering again. Recovery says how long the outage lasted (D-060) |
| P7-08 | Spotify outage / 5xx resilience | ✅ | Backoff already existed (P1-08). The spam did not: a poll every 2s for eight hours wrote ~14,000 identical lines to an SD card with a finite number of writes in it. A run of the same failure is now reported once and then counted, with a reminder every five minutes — about a hundred lines instead (D-060) |
| P7-09 | Unattended token refresh over multi-day runtime | ⬜ | Success criterion #5 |
| P7-10 | Memory budget enforcement: RSS < 700MB combined | ⬜ | Success criterion #6. Relaxed by D-008 |
| P7-11 | 7-day soak test with leak detection | ⬜ | Success criterion #5 |
| P7-12 | Cold-boot-to-Now-Playing < 60s measurement | ⬜ | Success criterion #1 |

---

## Phase 8 — Packaging, CI/CD & optional audio

> **Exit criterion:** blank SD card → working Joshify in under 30 minutes via the README.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P8-01 | Multi-arch container build (`linux/arm64`) via buildx + QEMU | 🟨 | Multi-stage, non-root, ~285MB. **Unbuilt** — there is no Docker daemon in the dev container, so this is checked structurally and not yet run |
| P8-02 | Container image published from CI on tag | 🟨 | Workflow written; never run |
| P8-03 | `docker-compose.yml` for the container path | ✅ | `network_mode: host` is required, not lazy: under bridge networking the browser's `127.0.0.1` during PKCE is the *host* while the listener is in the container, so the callback lands nowhere |
| P8-04 | One-line install script (non-container path) | ✅ | Run end to end as root against a synthetic bundle: first install, re-run, permissions, uninstall, double-uninstall and the loud-failure paths. Found a real bug — `--skip-systemd` reported success and did nothing |
| P8-05 | Release pipeline: versioning, changelog, tagged artefacts | 🟨 | Changelog grouped by the `P<phase>-<task>` prefix this repo already uses, so notes and tracker share a vocabulary. Never run against a real tag. Caught a genuine bug in testing: `pnpm install --prod` leaves workspace links in per-project `node_modules`, so a root-only copy produces a bundle that installs and then dies on `ERR_MODULE_NOT_FOUND` — the workflow now proves the bundle resolves its own imports before publishing |
| P8-06 | E2E smoke test in CI against the fake Spotify server | ✅ | Seven tests against `dist/` — real browser at 720×1280, real `joshify serve`, fake Spotify. Deliberately small: this is the only suite that can see the pieces failing to be *assembled*, and the one that would have caught the missing `/` route (D-059) |
| P8-07 | Installation documentation | ✅ | [`docs/INSTALL.md`](./INSTALL.md) |
| P8-08 | Hardware guide: screen, case, wiring, OS flashing | ✅ | In `INSTALL.md`, cross-linked from `HARDWARE.md`. Both traps called out: the 22→15-way DSI cable and the 27W supply |
| P8-09 | Optional `librespot` module: install + systemd unit | ⬜ | Opt-in; must not break core install |
| P8-10 | librespot device appears in Devices screen | ⬜ | |
| P8-11 | Audio output guide (Zero 2 W has no analogue out — DAC/HAT options) | ⬜ | |

---

## Open questions

Things we don't yet know. Resolve and move to DECISIONS.md.

| # | Question | Blocks | Owner |
|---|---|---|---|
| ~~Q1~~ | ~~Board + touchscreen?~~ | — | ✅ **Resolved: Pi 5 + Touch Display 2** (D-008) |
| ~~Q2~~ | ~~Does headless PKCE work on-device?~~ | — | ✅ **Resolved: yes**, via the Pi's own touchscreen (P1-01) |
| Q3 | Chromium or `cog`/WPE for the kiosk runtime on a Pi 5? | P3-01 | Claude (spike) |
| Q7 | Which self-hosted faces ship on the device? Archivo/Barlow Condensed/Share Tech Mono are the prototype's choice | P3-06 | Claude, at Phase 3 |
| Q4 | Container or native install as the *recommended* path? | P8-01, P8-04 | Both, after P7 |
| ~~Q6~~ | ~~Image decoding library?~~ | — | ✅ **Resolved: pure-JS `jimp`** (D-027). We only decode 64px, so speed is moot and the native install hazard is not |
| Q5 | Which USB DAC for the librespot module? | P5-20 | Josh, before P5 |
| ~~V1~~ | ~~Promote librespot to Phase 5?~~ | — | ✅ **Resolved: yes** (D-013) |
| ~~V2~~ | ~~Add a mic for room-listening FFT?~~ | — | ✅ **Resolved: not for now.** Same PCM path, cheap to add later |
| V3 | Which BPM source wins the bake-off? | P5-04 | Claude (spike) |
