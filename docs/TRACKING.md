# Joshify — Build Tracker

**This is the live source of truth for build progress.** Update it in the same
commit as the work it describes.

Last updated: 2026-09-05

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
| 3 | Now Playing | 14 | 13 | 🟨 In progress |
| 4 | Control surfaces | 10 | 5 | 🟨 In progress |
| 5 | **Visualizer + librespot** | 38 | 0 | ⬜ Not started (3 cut) |
| 6 | Search & library | 9 | 3 | 🟨 In progress |
| 7 | Appliance & hardening | 12 | 0 | ⬜ Not started |
| 8 | Packaging, CI/CD & audio module | 11 | 0 | ⬜ Not started |
| | **Total** | **122** | **50** | |

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
| P3-05 | Server-side blur pre-render, served as a static image | ⬜ | Avoids `backdrop-filter` on VC4 entirely |
| P3-06 | Svelte app shell + WebSocket client store | ✅ | Vite + Svelte 5. The panel is three slots — stage, rail, plate — which is the whole navigation model. The store implements the Svelte contract by hand so its reconnect logic is testable in Node against a fake socket (D-043). Desktop fit uses `zoom`, not `transform`: `transform` scales paint but not the layout box, which is what overflowed the first prototype |
| P3-07 | Theme application via CSS custom properties | ✅ | Token *contract* moved to core so both ends share one definition; extraction stays server-side. Fixed chrome is `--jf-*`, the album's five are `--joshify-*`, so a rule says which half can change under you. Hex is validated before writing — a bad custom property is not an error, it is a silently unstyled panel |
| P3-08 | Album art hero component + crossfade on track change | ✅ | The outgoing frame is held until the incoming one has *pixels* — `load` **and** `decode()` — because swapping on `load` alone flashes empty surface on every track change. Keyed on the image URL, not the track: two tracks from one album share a cover (D-045) |
| P3-09 | Drifting blurred backdrop | ✅ | Procedural motion only (no audio-reactivity exists — D-010). Drift on the wrapper's transform, blur on the image: a filter is dear to rasterise and cheap to re-composite, so it is computed once per track. Source is the 64px variant — downscale-then-upscale is a free blur |
| P3-10 | Transport control components (≥48px targets) | ✅ | Reachable and composed into the panel. Deliberately unequal per D-040: 96px accent play disc, bare skip glyphs, toggles at `--jf-ink-faint` until active. Glyphs are drawn SVG, not characters — the self-hosted faces carry no media symbols, so text would render tofu |
| P3-11 | Interpolated progress bar rendering | ✅ | Reachable and composed into the panel. Frame loop runs only when something moves — paused, none; dragging, none. Zero extra API calls. Transport and Scrubber run the *same* pure model rather than sharing a value, so they cannot disagree (D-046) |
| P3-12 | Idle / nothing-playing / not-Premium states | ✅ | `PlaybackNotice` composed into the plate. Offline returns *no* notice when a last known state exists — the amber lamp does the talking, and a banner over a working screen is the spinner mistake in another costume |
| P3-14 | **Put the account's Premium flag on the wire** | ✅ | Read once at engine start and published. Three-valued: `null` until asked, and a failed profile read leaves it null rather than guessing |
| P3-13 | **Deliver the theme over the wire** | ✅ | `PanelState` (core) = playback + `theme` + `themeFor` + `isPremium`, flat so the diff stays granular. The engine publishes the track first and the colour when extraction lands; the UI holds the *previous* album's colour across the gap rather than flashing grey. Generation-fenced, so a slow decode cannot repaint the wrong track (D-050). **Prepared artwork URLs are not included** — that needs the static-serving route, which belongs with P3-05 |

---

## Phase 4 — Control surfaces

> **Exit criterion:** move playback between real devices, change volume, scrub — by touch, on hardware.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P4-01 | Device list endpoint + polling | ✅ | `GET /api/devices` serves the normalised list. An unreadable entry is dropped, not fatal — refusing to draw six working speakers because a seventh reported something odd is the wrong trade. `device-source.ts` polls at 5s **only while the Devices surface is open** — a wall panel showing Now Playing has no use for a fresh list, and polling one for hours spends the budget the transport needs (D-049) |
| P4-02 | Devices screen UI with active-device indicator | ✅ | Reachable and composed into the panel. Restricted devices (`id: null`) stay listed but dimmed and untappable — dropping them leaves the viewer hunting for a speaker Spotify can see and Joshify apparently cannot |
| P4-03 | Transfer playback on tap | ✅ | Reachable and composed into the panel. The **active** device is not a transfer target: moving playback to where it already is achieves nothing, and a control that visibly does nothing reads as broken |
| P4-04 | Queue fetch + Queue screen | 🟨 | Server half done: `getQueue` + `normaliseQueue` + `GET /api/queue`, with `additional_types=episode` so a queued podcast is not a null row. Screen still to build |
| P4-05 | Document queue-reorder impossibility in the UI | ⬜ | No fake affordance. See PRODUCT.md §6 |
| P4-06 | Volume slider + device volume support detection | ✅ | Reachable and composed into the panel. `volumePercent: null` draws **no slider at all** (D-022). Commits once on release, not per drag frame — one command per gesture, not fifty |
| P4-07 | Touch scrubbing on the progress bar | ✅ | Reachable and composed into the panel. On release the tracker re-anchors at the chosen position so the bar runs on through the round trip instead of snapping back. A track change under a held finger drops the drag — the fraction was chosen against the old duration |
| P4-08 | Navigation model between surfaces | ⬜ | Gesture + tap, no chrome |
| P4-09 | Shuffle / repeat toggles wired to real state | ✅ | Reachable and composed into the panel. Repeat cycles off → context → track, matching Spotify's own clients; `aria-pressed` cannot express three states, so the mode rides on `data-repeat` |
| P4-10 | Component + interaction tests for all control surfaces | ⬜ | |

---

## Phase 5 — Visualizer

> **Exit criterion:** full-screen visualizer on hardware, holding frame budget, beat-reactive, preset switching by touch, legibility floor measured.

Design: [VISUALIZER.md](./VISUALIZER.md) · [PS1_MODE.md](./PS1_MODE.md) · [THEMES.md](./THEMES.md)

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P5-01 | WebGL2 render pipeline: ping-pong FBOs, pass chain, uniform contract | ⬜ | Presets are data (JSON), not code paths |
| P5-02 | 🔬 **Spike: BPM source bake-off.** Coverage test against Josh's real library | ⬜ | GetSongBPM vs AcousticBrainz dump vs Deezer-by-ISRC |
| P5-03 | `ReactivityProvider` interface + Tier 0 procedural implementation | ⬜ | Always-available floor. Injected, so testable headlessly |
| P5-04 | Tier 1: ISRC→BPM lookup, permanent disk cache, phase-locked pulse | ⬜ | `external_ids.isrc` is **not** deprecated |
| P5-05 | Tier 2: PCM tap + FFT + beat detection | ⬜ | librespot `--backend pipe`: s16le, 44.1kHz, stereo. **Gated on V1** |
| P5-06 | Effect family A — feedback (zoom tunnel, rotational, warp, echo) | ⬜ | The Milkdrop core technique |
| P5-07 | Effect family B — glitch (RGB split, block displace, pixel sort, tear, dropout, bit crush) | ⬜ | |
| P5-08 | Effect family C — analog lofi (VHS wobble, CRT, grain, dither, posterize, bloom, halftone) | ⬜ | |
| P5-09 | Effect family D — Winamp classics (spectrum bars, oscilloscope, kaleidoscope, particles) | ⬜ | Bars are non-negotiable |
| P5-10 | Effect family E — art-derived (shatter, palette cycle, slit-scan, displacement) | ⬜ | The cover is the *source texture*, not a backdrop |
| P5-11 | Tap-tempo / nudge-phase touch control | ⬜ | Fixes Tier 1's missing downbeat phase in two taps |
| P5-12 | Preset system: named looks, touch switching, shuffle-on-track-change | ⬜ | `VHS`, `Tunnel`, `Datamosh`, `Ghost`, `Newsprint`, `Vapor` |
| P5-13 | Half-resolution render + upscale, exposed as a "grain" slider | ⬜ | 4x fragment saving **and** the aesthetic |
| P5-14 | Auto-degrade on missed frames (drop scale, then passes) | ⬜ | |
| P5-15 | Visualizer modes: Now Playing / Ambient / Full / auto-enter on idle | ⬜ | The screensaver behaviour |
| P5-16 | **Legibility floor test** — contrast behind text at any intensity | ⬜ | Enforced in tests, not by eye |
| P5-17 | Headless engine tests driven by a scripted reactivity sequence | ⬜ | No GPU needed in CI |
| P5-18 | `librespot` install + run as a Spotify Connect target | ⬜ | Promoted from Phase 8 by D-013. **Opt-in** — Tiers 0-1 must work without it |
| P5-19 | PCM tee: librespot pipe backend -> ALSA **and** -> server | ⬜ | s16le / 44.1kHz / stereo. Must not add audible latency |
| P5-20 | Audio output on Pi 5: USB DAC support + detection | ⬜ | **Pi 5 has no 3.5mm jack.** USB DAC preferred over a HAT (GPIO/case conflict) |
| P5-21 | librespot device surfaces in the Devices screen | ⬜ | Moved from P8-10 |
| P5-22 | **Scene stage** ahead of the post chain (`flat` \| `tunnel`) | ⬜ | D-014. Post effects compose over any scene |
| P5-23 | Tunnel scene: ring geometry, camera, curve-with-near-fade | ⬜ | `smoothstep` ease keeps the near ring centred on the camera |
| P5-24 | PS1 artefact shader set (all six, individually toggleable) | ⬜ | Port from [`spikes/n2o-tunnel/`](../spikes/n2o-tunnel/) |
| P5-25 | Album art as tunnel texture: 256px, `NEAREST`, `REPEAT` | ⬜ | Ring-aligned V so the scroll wrap is invisible |
| P5-26 | `N2O` preset — speed, radius and flash bound to `uBeat` | ⬜ | |
| P5-27 | PS1-idiom UI chrome for Now Playing | ⬜ | **Original assets only** (D-015). PS1 BIOS CD player is the reference |
| P5-28 | Original attract / boot sequence | ⬜ | Also covers the P7-05 boot handoff |
| P5-29 | Combination presets: tunnel + datamosh / VHS / pixel sort | ⬜ | The payoff of D-014 |
| P5-30 | Measure the tunnel on Pi 5 hardware | ⬜ | Folded into the P3-01 measurement |
| P5-31 | **Theme bundle format**: palette + scene + chain + chrome as one unit | ⬜ | D-017. The Microsoft Plus! model, not the Winamp-skin model |
| P5-32 | Tokenise UI chrome so themes can reach it | ⬜ | Must land in **Phase 3**, not retrofitted later |
| P5-33 | `VGA` theme — 16-colour quantise + ordered dither | ⬜ | ~15 lines on top of existing dither; maximally unlike `N2O` |
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
| P6-02 | On-screen keyboard component | 🟨 | Built and tested; the Search surface is not reachable yet. 62px keys from stated arithmetic: `(720 − 28 padding − 72 gaps) / 10`. Shift is one-shot → lock → off |
| P6-03 | Search results UI (tracks / albums / artists / playlists) | 🟨 | Built and tested; not reachable — needs `/api/library` reshaped and the surface wired into App |
| P6-04 | **Virtualised list component** | 🟨 | Built and tested; not reachable. Height is a prop, never measured — jsdom reports 0×0 and D-039 makes the panel arithmetic anyway |
| P6-05 | Saved albums browse | ✅ | Paged. Advances by rows **sent**, not rows kept — Spotify ships null rows (D-031) |
| P6-06 | Playlists browse + playlist detail | ✅ | Server side done; the UI is P6-03 |
| P6-07 | Play-in-context from any result | ⬜ | Album/playlist context, not just single track |
| P6-08 | Thumbnail loading strategy for long lists | 🟨 | Built and tested; not reachable. Virtualisation is the real eviction — unmounted rows take their decoded bitmaps with them. The bookkeeping is an LRU bounded at 128, because an unbounded map is a leak that shows up in month three, not in a test |
| P6-09 | Performance test: long-list scroll on hardware | ⬜ | Explicit budget, fails CI-on-hardware if exceeded |

---

## Phase 7 — Appliance & hardening

> **Exit criterion:** all seven PRODUCT.md §9 success criteria measured and met.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P7-01 | 64-bit Raspberry Pi OS Lite base image documented | ⬜ | Pi 5 needs **Bookworm 64-bit or later**; Bullseye does not support it |
| P7-02 | Kiosk browser on DRM/KMS, no desktop environment | ⬜ | Chromium or `cog`, per the P3-01 measurement |
| P7-03 | systemd unit for `joshify-server` | ⬜ | Restart-on-failure, journald logging |
| P7-04 | systemd unit for the kiosk UI | ⬜ | Ordered after server readiness |
| P7-05 | Boot splash → app handoff with no flicker or console text | ⬜ | |
| P7-06 | Display config: resolution, rotation, blanking policy | ⬜ | Touch Display 2 via the 22→15-way DSI adapter cable |
| P7-07 | Network-loss resilience + offline state | ⬜ | Shows last known truth, recovers silently |
| P7-08 | Spotify outage / 5xx resilience | ⬜ | Backoff, no error spam |
| P7-09 | Unattended token refresh over multi-day runtime | ⬜ | Success criterion #5 |
| P7-10 | Memory budget enforcement: RSS < 700MB combined | ⬜ | Success criterion #6. Relaxed by D-008 |
| P7-11 | 7-day soak test with leak detection | ⬜ | Success criterion #5 |
| P7-12 | Cold-boot-to-Now-Playing < 60s measurement | ⬜ | Success criterion #1 |

---

## Phase 8 — Packaging, CI/CD & optional audio

> **Exit criterion:** blank SD card → working Joshify in under 30 minutes via the README.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P8-01 | Multi-arch container build (`linux/arm64`) via buildx + QEMU | ⬜ | |
| P8-02 | Container image published from CI on tag | ⬜ | |
| P8-03 | `docker-compose.yml` for the container path | ⬜ | |
| P8-04 | One-line install script (non-container path) | ⬜ | Installs systemd units + first-run auth |
| P8-05 | Release pipeline: versioning, changelog, tagged artefacts | ⬜ | |
| P8-06 | E2E smoke test in CI against the fake Spotify server | ⬜ | Playwright |
| P8-07 | Installation documentation | ⬜ | Written for a stranger, not for us |
| P8-08 | Hardware guide: screen, case, wiring, OS flashing | ⬜ | Must call out the 22→15-way DSI cable and the 27W supply |
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
