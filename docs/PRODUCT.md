# Joshify — Product Description

**A touchscreen control surface for Spotify, built for a Raspberry Pi Zero 2 W.**

Status: `DRAFT v1` · Last updated: 2026-09-02

---

## 1. The one-liner

Joshify turns a small Raspberry Pi and a touchscreen into a beautiful, always-on
physical control surface for your Spotify account — a dedicated object that shows
what's playing and lets you touch it, without being the thing that makes the sound.

## 2. The problem

Spotify already runs everywhere: phone, laptop, TV, speakers. What it doesn't have
is a *place*. To change a track you unlock a phone, find the app, dismiss a
notification, and hunt for a button designed for a scrolling feed, not a glance.

Meanwhile the album art — the single most beautiful asset in the entire music
experience — is rendered at the size of a postage stamp.

Joshify is the physical answer: a small screen on a desk or shelf that is *always*
showing your music, big and unapologetic, and is *always* one touch away from
controlling it.

## 3. What it is (and is not)

**Joshify is:**
- A **remote control and display** for Spotify Connect. It commands playback that
  is happening on your real speakers, phone, or desktop.
- A **dedicated appliance**. It boots straight into the app. No desktop, no
  browser chrome, no login screen after first setup.
- A **self-contained device**. Everything runs locally on the Pi. There is no
  Joshify cloud service, no account, and no telemetry.

**Joshify is not:**
- A music player. By default it produces no audio. (Optional `librespot` module
  can make the Pi *also* a Connect target — see §7.)
- A Spotify replacement. It is a lens on the account you already have.
- A general-purpose tablet.

## 4. Target user

Primarily: **the author**, and people like him. Someone who already owns a Pi,
already pays for Spotify Premium, and wants a well-made object on their desk.
Secondarily: anyone who can follow a one-line install script.

## 5. The experience

### 5.1 The Now Playing screen (the default, ~95% of screen-time)

The screen is dominated by **album art**, rendered as large as the display allows.

Behind it, the *same* art is blown up, heavily blurred, and slowly drifting — so
the entire device glows in the colour of whatever is playing. A quiet ambient
record makes the whole object dim and warm; a loud one makes it burn.

Controls float on top in a **theme derived from the artwork itself**. Every track
change re-derives an accent colour, a foreground colour, and a contrast-safe
control tint. The interface doesn't have one look — it has the album's look.

- Track title, artist, album.
- A progress bar that moves smoothly and continuously (interpolated locally,
  not stepped by network polls).
- Transport: previous / play-pause / next, sized for thumbs, not cursors.
- Shuffle and repeat state, visible at a glance.
- The name of the device the audio is *actually* coming from.

**Idle behaviour:** when nothing is playing, the screen fades to a calm
last-played or clock state rather than an error. When the display has been
untouched for a while, controls fade away and leave only the art.

### 5.2 Control surfaces (one swipe or tap away)

- **Devices** — every Spotify Connect device on the account, with the active one
  marked. Tap to move playback there. This is the highest-value screen after Now
  Playing: it turns the Pi into a physical "move the music to the kitchen" button.
- **Queue** — what's coming up next, as a scrollable list.
- **Volume** — a large vertical slider for the active device.
- **Search & Library** — an on-screen keyboard, debounced search across tracks,
  albums, artists and playlists, plus browse of saved albums and playlists. Tap
  a result to play it on the active device.

### 5.3 Design principles

1. **The art is the interface.** Chrome recedes; the album is the hero.
2. **Glanceable from across the room.** Readable at 2 metres, operable at 0.3.
3. **Touch targets ≥ 48px.** No hover states. No right-click. No tiny close buttons.
4. **Never show a spinner where you can show the last known truth.** Optimistic
   updates on every command; reconcile quietly when the server answers.
5. **Never show a raw error.** Network hiccups and token refreshes are invisible.
6. **It must feel good on a £15 computer.** Performance is a design constraint,
   not an optimisation phase.

## 6. Hard platform constraints (researched, not assumed)

These are the real boundaries of what Joshify can be. They shaped the plan.

| Constraint | Consequence for Joshify |
|---|---|
| **Spotify Premium is required** for every `/me/player` write endpoint. | Joshify is a Premium-only product. Free accounts get a clear explanatory screen, not a broken UI. |
| **No Canvas API.** The looping videos are served by undocumented, reverse-engineered endpoints that violate Spotify's ToS. | **Cut from scope.** Not built, not shimmed. |
| **`audio-analysis` and `audio-features` were deprecated for new apps on 2024-11-27**, with no replacement. Also gone: `recommendations`, `related-artists`, `featured-playlists`, category playlists. | **No audio-reactive visuals.** No beat-synced pulsing, no tempo-driven motion. All motion is procedural and time-based. Also: no "discover" features. |
| **The playback queue is read-mostly.** `GET /me/player/queue` and add-to-queue exist; there is **no reorder and no remove** endpoint. | Queue is **view + add + jump-by-skip**. Reordering is impossible via the public API and is explicitly out of scope. Playlist reordering (a different endpoint) is a possible future. |
| **No push/websocket for playback state.** State must be polled. | An adaptive polling scheduler plus local progress interpolation — see §8.2. |
| **Redirect URI rules tightened**: Spotify now requires HTTPS, or literal loopback `http://127.0.0.1:{port}` (**not** `localhost`). | Auth is Authorization Code + PKCE against a loopback redirect. Requires a first-run flow that works on a headless-ish appliance — flagged as a Phase 1 spike. |
| **Pi Zero 2 W: 512 MB RAM, 4×Cortex-A53 @1GHz, VideoCore IV.** | Electron is impossible. Chromium is a squeeze. `backdrop-filter` is not usefully accelerated on VC4. Architecture must push expensive work off the render thread — see §8.1. |
| **Web Playback SDK needs Widevine DRM**, unavailable on ARM Linux Chromium builds. | In-browser playback on the Pi is a dead end. `librespot` is the only viable on-device audio path. |

## 7. Optional module: on-device audio

Joshify ships remote-control-first. An **opt-in** setup step installs `librespot`
so the Pi additionally advertises itself as a Spotify Connect target. When
enabled, the Devices screen shows the Pi like any other endpoint and you can move
playback to it.

This is deliberately a *module*, not a core feature: it needs its own audio
hardware decisions (DAC/HAT vs the Zero's limited output), and keeping it optional
keeps the default install small and the core app testable without audio.

## 8. Architecture summary

Two processes on the Pi, talking over localhost.

```
┌─────────────────────────── Raspberry Pi Zero 2 W ───────────────────────────┐
│                                                                              │
│   ┌────────────────────────┐   REST + WebSocket   ┌───────────────────────┐  │
│   │   joshify-server       │◄────────────────────►│   joshify-ui          │  │
│   │   (Node, ~70MB)        │   localhost only     │   (Svelte in a        │  │
│   │                        │                      │    kiosk browser)     │  │
│   │  · OAuth + token store │                      │                       │  │
│   │  · Spotify API client  │                      │  · Pure renderer      │  │
│   │  · Polling scheduler   │                      │  · No secrets         │  │
│   │  · Theme extraction    │                      │  · No Spotify calls   │  │
│   │  · Blur pre-render     │                      │  · Applies CSS vars   │  │
│   │  · Image cache         │                      │                       │  │
│   └───────────┬────────────┘                      └───────────────────────┘  │
│               │                                                              │
└───────────────┼──────────────────────────────────────────────────────────────┘
                │ HTTPS
                ▼
        Spotify Web API  ──────►  your real playback device
```

### 8.1 The core performance idea

**The UI never computes anything expensive.** The server does the work once per
track and hands the UI a finished payload:

- Fetch the **64px** album art variant (not the 640px one) as the source for both
  colour extraction and the blur. It's a tiny download and a trivial amount of
  pixels to process.
- Extract a full **theme token set** server-side (accent, foreground, control
  tint, contrast-checked) and push it as CSS custom properties.
- **Pre-render the blurred backdrop server-side** and serve it as a small image.
  A heavily-downscaled image scaled *up* by the GPU is a free blur — this sidesteps
  `backdrop-filter` entirely, which is the single biggest rendering risk on VC4.
- The 640px art is fetched once, cached on disk, and served locally.

The UI's per-frame job reduces to: composite two cached bitmaps and animate a
progress bar. That is achievable on a Zero 2 W.

### 8.2 Playback state without push

- **Adaptive polling**: slow (~5s) when idle or mid-track, fast (~1s) approaching
  a track boundary, immediate re-poll after any user command.
- **Local interpolation**: between polls, `progress_ms` advances from a monotonic
  clock, so the progress bar is smooth at display refresh rate with zero extra
  API calls.
- **Optimistic updates**: a tap on play/pause updates the UI instantly and
  reconciles against the next poll, so the device feels instant even on wifi.
- This keeps request volume far below Spotify's rate limits while feeling live.

### 8.3 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | Your Node preference; one language across server, UI and tests. |
| Repo | pnpm workspaces monorepo | Shared types between server and UI, single test/lint run. |
| Server | Node + Fastify | Small, fast, good TS story. |
| UI framework | **Svelte** | Compiles away — no runtime VDOM, materially less RAM and GC pressure than React. This matters at 512MB. |
| Bundler | Vite | Fast dev loop, tiny production output. |
| Kiosk runtime | **WPE WebKit (`cog`)**, Chromium fallback | WPE is purpose-built for embedded, renders straight to DRM/KMS with no desktop, and has a much smaller footprint than Chromium. |
| Unit tests | Vitest | |
| E2E | Playwright against a **fake Spotify server** | CI never needs real credentials. |
| CI/CD | GitHub Actions | Lint, typecheck, test, multi-arch build. |
| Delivery | ARM64 container + one-line install script | |

**Note:** the Pi Zero 2 W's CPU is ARM64-capable, but 32-bit Raspberry Pi OS is
still a common default. Joshify targets **64-bit Raspberry Pi OS Lite**.

## 9. Success criteria

Joshify v1.0 is done when, on real Pi Zero 2 W hardware:

1. It boots from cold to the Now Playing screen with **no keyboard, mouse or
   desktop**, in under 60 seconds.
2. Track changes are reflected on screen within **2 seconds**.
3. A transport tap produces **visible feedback in under 100ms**.
4. The progress bar animates smoothly with **no visible stutter**.
5. It runs for **7 days unattended** without a crash, memory leak, or a
   re-authentication prompt.
6. Total RSS across both processes stays **under 400MB**.
7. A stranger can install it from the README in **under 30 minutes**.

## 10. Explicitly out of scope for v1

- Spotify Canvas / music videos (§6).
- Audio-reactive or beat-synced visuals (§6 — API no longer exists).
- Queue reordering or removal (§6 — API does not exist).
- Lyrics (no public API).
- Multi-user / account switching.
- Any non-Spotify music source.
- A companion mobile app.
- A hosted/cloud version.
