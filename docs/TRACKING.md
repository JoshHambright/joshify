# Joshify — Build Tracker

**This is the live source of truth for build progress.** Update it in the same
commit as the work it describes.

Last updated: 2026-09-02

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
| 0 | Foundation | 8 | 0 | ⬜ Not started |
| 1 | Spotify identity & API client | 11 | 0 | ⬜ Not started |
| 2 | Playback state engine | 10 | 0 | ⬜ Not started |
| 3 | Now Playing | 12 | 0 | ⬜ Not started |
| 4 | Control surfaces | 10 | 0 | ⬜ Not started |
| 5 | Search & library | 9 | 0 | ⬜ Not started |
| 6 | Appliance & hardening | 12 | 0 | ⬜ Not started |
| 7 | Packaging, CI/CD & audio module | 11 | 0 | ⬜ Not started |
| | **Total** | **83** | **0** | |

---

## Phase 0 — Foundation

> **Exit criterion:** `pnpm verify` passes locally and in GitHub Actions.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P0-01 | Clear the feature branch and scaffold the pnpm workspace | ⬜ | `packages/core`, `apps/server`, `apps/ui` |
| P0-02 | Base TypeScript config (strict) shared across workspaces | ⬜ | `strict`, `noUncheckedIndexedAccess` |
| P0-03 | ESLint + Prettier, wired to a single `pnpm lint` | ⬜ | |
| P0-04 | Vitest set up with coverage reporting | ⬜ | Coverage floor enforced from P1 |
| P0-05 | `pnpm verify` composite script (lint + typecheck + test + build) | ⬜ | One command; CI runs exactly this |
| P0-06 | GitHub Actions CI workflow on push + PR | ⬜ | Node 22, pnpm cache |
| P0-07 | Repo hygiene: `.gitignore`, `.nvmrc`, `.env.example`, LICENSE | ⬜ | |
| P0-08 | README skeleton pointing at the docs | ⬜ | |

---

## Phase 1 — Spotify identity & API client

> **Exit criterion:** CLI authenticates a real account, persists tokens, survives restart, refreshes unattended.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P1-01 | 🔬 **Spike: headless PKCE.** Prove loopback redirect works with no keyboard on the device | ⬜ | **Highest-risk unknown.** Spotify rejects `localhost` and non-HTTPS. Timebox: 1 session |
| P1-02 | Register the Spotify app; document required scopes | ⬜ | Needs Josh — see [SPOTIFY_SETUP.md](./SPOTIFY_SETUP.md) |
| P1-03 | Store client credentials in GitHub Secrets | ⬜ | Needs Josh. Never committed |
| P1-04 | PKCE challenge/verifier generation + authorize URL builder | ⬜ | Pure, unit tested |
| P1-05 | Token exchange + refresh logic with expiry-ahead scheduling | ⬜ | Refresh at 80% of TTL, not on failure |
| P1-06 | Token store: encrypted at rest, atomic writes | ⬜ | Survives power loss mid-write |
| P1-07 | Typed Spotify HTTP client (only the endpoints we need) | ⬜ | |
| P1-08 | Rate-limit handling: honour `Retry-After`, backoff, request budget | ⬜ | |
| P1-09 | Error taxonomy: auth / rate-limit / network / no-device / not-premium | ⬜ | Drives all UI error states later |
| P1-10 | **Fake Spotify server** for tests — same shapes, scriptable failures | ⬜ | Load-bearing for P2–P5 CI |
| P1-11 | `joshify auth` CLI command for first-run setup | ⬜ | |

---

## Phase 2 — Playback state engine

> **Exit criterion:** a WebSocket client shows accurate, smooth state; REST commands control real playback.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P2-01 | `PlaybackState` model + normaliser for Spotify's player payloads | ⬜ | Handles null device, null item, podcasts |
| P2-02 | Injected clock abstraction | ⬜ | Makes everything below testable without real time |
| P2-03 | Adaptive polling scheduler | ⬜ | ~5s idle, ~1s near boundary, immediate after command |
| P2-04 | Local progress interpolation between polls | ⬜ | Monotonic clock; must not drift or jump backwards |
| P2-05 | Optimistic command application + reconciliation | ⬜ | Tap feels instant, truth wins later |
| P2-06 | Transport command handlers (play/pause/next/prev/seek/shuffle/repeat) | ⬜ | |
| P2-07 | Fastify server + localhost-only binding | ⬜ | Must not be reachable off-device by default |
| P2-08 | WebSocket state push with diffing | ⬜ | Send diffs, not full state, per tick |
| P2-09 | Reconnect/resume semantics for the UI socket | ⬜ | UI recovers silently from server restart |
| P2-10 | Full unit suite for the engine against the fake server | ⬜ | Includes clock-driven interpolation tests |

---

## Phase 3 — Now Playing

> **Exit criterion:** full-screen Now Playing on real hardware, re-themes on track change, steady frame rate.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P3-01 | 🔬 **Spike: render on real Zero 2 W under `cog`.** Measure FPS + RSS | ⬜ | **Second-highest risk.** Do before building the real UI |
| P3-02 | Album art fetch + on-disk cache (640px hero, 64px source) | ⬜ | 64px feeds both theme and blur |
| P3-03 | Server-side theme extraction → token set | ⬜ | Accent, foreground, control tint |
| P3-04 | Contrast checking / correction on derived colours | ⬜ | Text must stay readable on any album |
| P3-05 | Server-side blur pre-render, served as a static image | ⬜ | Avoids `backdrop-filter` on VC4 entirely |
| P3-06 | Svelte app shell + WebSocket client store | ⬜ | |
| P3-07 | Theme application via CSS custom properties | ⬜ | UI computes nothing |
| P3-08 | Album art hero component + crossfade on track change | ⬜ | |
| P3-09 | Drifting blurred backdrop | ⬜ | Procedural motion — no audio-reactivity available |
| P3-10 | Transport control components (≥48px targets) | ⬜ | |
| P3-11 | Interpolated progress bar rendering | ⬜ | Smooth at refresh rate, zero extra API calls |
| P3-12 | Idle / nothing-playing / not-Premium states | ⬜ | Never a raw error |

---

## Phase 4 — Control surfaces

> **Exit criterion:** move playback between real devices, change volume, scrub — by touch, on hardware.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P4-01 | Device list endpoint + polling | ⬜ | |
| P4-02 | Devices screen UI with active-device indicator | ⬜ | |
| P4-03 | Transfer playback on tap | ⬜ | |
| P4-04 | Queue fetch + Queue screen | ⬜ | View + add + jump-by-skip only |
| P4-05 | Document queue-reorder impossibility in the UI | ⬜ | No fake affordance. See PRODUCT.md §6 |
| P4-06 | Volume slider + device volume support detection | ⬜ | Some Connect devices reject volume changes |
| P4-07 | Touch scrubbing on the progress bar | ⬜ | Suppress interpolation during drag |
| P4-08 | Navigation model between surfaces | ⬜ | Gesture + tap, no chrome |
| P4-09 | Shuffle / repeat toggles wired to real state | ⬜ | |
| P4-10 | Component + interaction tests for all control surfaces | ⬜ | |

---

## Phase 5 — Search & library

> **Exit criterion:** find and play an arbitrary track from the touchscreen alone, scrolling smoothly.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P5-01 | Search endpoint proxy with debouncing + cancellation | ⬜ | |
| P5-02 | On-screen keyboard component | ⬜ | Touch-sized, no physical keyboard assumed |
| P5-03 | Search results UI (tracks / albums / artists / playlists) | ⬜ | |
| P5-04 | **Virtualised list component** | ⬜ | Biggest memory risk on the Zero 2 W |
| P5-05 | Saved albums browse | ⬜ | |
| P5-06 | Playlists browse + playlist detail | ⬜ | |
| P5-07 | Play-in-context from any result | ⬜ | Album/playlist context, not just single track |
| P5-08 | Thumbnail loading strategy for long lists | ⬜ | Lazy + evict; must not grow unbounded |
| P5-09 | Performance test: long-list scroll on hardware | ⬜ | Explicit budget, fails CI-on-hardware if exceeded |

---

## Phase 6 — Appliance & hardening

> **Exit criterion:** all seven PRODUCT.md §9 success criteria measured and met.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P6-01 | 64-bit Raspberry Pi OS Lite base image documented | ⬜ | Zero 2 W is ARM64-capable; 32-bit default is wrong for us |
| P6-02 | `cog` kiosk on DRM/KMS, no desktop environment | ⬜ | Chromium fallback path documented |
| P6-03 | systemd unit for `joshify-server` | ⬜ | Restart-on-failure, journald logging |
| P6-04 | systemd unit for the kiosk UI | ⬜ | Ordered after server readiness |
| P6-05 | Boot splash → app handoff with no flicker or console text | ⬜ | |
| P6-06 | Display config: resolution, rotation, blanking policy | ⬜ | |
| P6-07 | Network-loss resilience + offline state | ⬜ | Shows last known truth, recovers silently |
| P6-08 | Spotify outage / 5xx resilience | ⬜ | Backoff, no error spam |
| P6-09 | Unattended token refresh over multi-day runtime | ⬜ | Success criterion #5 |
| P6-10 | Memory budget enforcement: RSS < 400MB combined | ⬜ | Success criterion #6 |
| P6-11 | 7-day soak test with leak detection | ⬜ | Success criterion #5 |
| P6-12 | Cold-boot-to-Now-Playing < 60s measurement | ⬜ | Success criterion #1 |

---

## Phase 7 — Packaging, CI/CD & optional audio

> **Exit criterion:** blank SD card → working Joshify in under 30 minutes via the README.

| ID | Task | Status | Notes |
|---|---|:---:|---|
| P7-01 | Multi-arch container build (`linux/arm64`) via buildx + QEMU | ⬜ | |
| P7-02 | Container image published from CI on tag | ⬜ | |
| P7-03 | `docker-compose.yml` for the container path | ⬜ | |
| P7-04 | One-line install script (non-container path) | ⬜ | Installs systemd units + first-run auth |
| P7-05 | Release pipeline: versioning, changelog, tagged artefacts | ⬜ | |
| P7-06 | E2E smoke test in CI against the fake Spotify server | ⬜ | Playwright |
| P7-07 | Installation documentation | ⬜ | Written for a stranger, not for us |
| P7-08 | Hardware guide: screen, case, wiring, OS flashing | ⬜ | |
| P7-09 | Optional `librespot` module: install + systemd unit | ⬜ | Opt-in; must not break core install |
| P7-10 | librespot device appears in Devices screen | ⬜ | |
| P7-11 | Audio output guide (Zero 2 W has no analogue out — DAC/HAT options) | ⬜ | |

---

## Open questions

Things we don't yet know. Resolve and move to DECISIONS.md.

| # | Question | Blocks | Owner |
|---|---|---|---|
| Q1 | Exact touchscreen model, resolution and driver? | P6-06, P7-08 | Josh |
| Q2 | Does the headless PKCE loopback flow actually work on-device? | P1-01 | Claude (spike) |
| Q3 | Can `cog`/WPE hit our frame budget on a Zero 2 W? If not, fallback? | P3-01 | Claude (spike) |
| Q4 | Container or native install as the *recommended* path on 512MB? | P7-01, P7-04 | Both, after P6 |
| Q5 | Audio hardware for the optional librespot module? | P7-11 | Josh, if we do it |
