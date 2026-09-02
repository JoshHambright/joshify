# Joshify — Decision Log

Lightweight ADRs. One entry per non-obvious choice, so future-us knows *why*.

Format: **What we chose · Why · What it costs us · Status**

---

### D-001 · TypeScript monorepo (pnpm workspaces)
**Chose:** TypeScript across server, UI and shared core, in one pnpm workspace.
**Why:** Josh's stated preference is Node/C#; TS gives one language end-to-end,
shared types between server and UI (the state payload is the contract), and a
single lint/test/build run.
**Costs:** Node's memory floor (~60–80MB) is worse than a native binary. Accepted:
we buy back far more in development speed and testability.
**Status:** ✅ Accepted

---

### D-002 · Svelte for the UI, not React
**Chose:** Svelte + Vite.
**Why:** Svelte compiles to direct DOM operations with no virtual-DOM runtime.
On a 512MB device sharing RAM with Node and a browser engine, the runtime and
GC-pressure difference is material, not academic.
**Costs:** Smaller ecosystem than React; fewer off-the-shelf components (we'll
hand-build the virtualised list and on-screen keyboard).
**Status:** ✅ Accepted

---

### D-003 · Two processes, server does the expensive work
**Chose:** A Node server owning all Spotify I/O, colour extraction, and blur
pre-rendering; a UI that is a pure renderer of a pushed payload.
**Why:** The render thread on a weak GPU cannot afford to compute. Anything that
can be done once per *track* (200ms is fine) should never be done once per
*frame*. It also keeps OAuth tokens out of the browser entirely.
**Costs:** A local transport (REST + WebSocket) to build and maintain.
**Status:** ✅ Accepted

---

### D-004 · Pre-rendered blur instead of CSS `backdrop-filter`
**Chose:** Server downscales album art aggressively and serves it as a small
image; the UI scales it *up*, letting bilinear filtering produce the blur.
**Why:** `backdrop-filter` is not usefully GPU-accelerated on VideoCore IV and is
the single largest rendering risk on a Zero 2 W. A scaled bitmap is essentially
free on any GPU.
**Costs:** Slightly less "correct" blur; a server round-trip per track.
**Status:** ✅ Accepted — **revisit if hardware changes** (see D-008). On a Pi 4/5
with a proper V3D driver, real `backdrop-filter` becomes viable and nicer.

---

### D-005 · Spotify Canvas cut from scope
**Chose:** Do not implement Canvas or music-video playback.
**Why:** There is no public API. The only access is via undocumented,
reverse-engineered endpoints that violate Spotify's Terms of Service, and which
can break without notice. Josh's call, and the right one.
**Costs:** The headline visual idea from the original brief. Mitigated by making
the album art and derived theming genuinely excellent instead.
**Status:** ✅ Accepted

---

### D-006 · No audio-reactive visuals
**Chose:** All motion is procedural and time-based.
**Why:** Not a choice so much as a fact. `audio-analysis` and `audio-features`
were deprecated for new applications on 2024-11-27 with no replacement; new apps
receive `403`. Beat-synced visuals are simply not buildable on the public API.
**Costs:** No pulsing-to-the-beat. Also rules out `recommendations` and
`related-artists`, so no discovery features.
**Status:** ✅ Accepted (forced)

---

### D-007 · Queue is view-only (plus add and skip)
**Chose:** No reorder, no remove in the queue UI.
**Why:** The Web API has no endpoint for either. `GET /me/player/queue` reads it
and add-to-queue appends; that is the entire surface.
**Costs:** Part of the requested scope. We will *not* build a fake affordance —
the UI won't offer a drag handle that can't work.
**Status:** ✅ Accepted (forced). Playlist reordering is a different endpoint and
remains a possible future.

---

### D-008 · Target hardware
**Chose:** _Open — under active discussion._
**Why:** Initial target was the Pi Zero 2 W (512MB, VideoCore IV). Given the
chosen feature scope now includes search and library browse — the most
memory-hungry screens — a beefier board may be a materially better trade.
**Costs:** TBD.
**Status:** 🔬 **OPEN** — see [HARDWARE.md](./HARDWARE.md). Blocks P3-01, P6-01,
P6-02, P6-06, P7-08. Several decisions above (D-004 in particular) relax if this
changes.

---

### D-009 · No in-browser playback; librespot for optional audio
**Chose:** If the Pi is to play audio, it is via `librespot`, not the Spotify
Web Playback SDK.
**Why:** The Web Playback SDK requires Widevine DRM, which is not available in
ARM Linux Chromium builds. It is a dead end on this hardware regardless of board.
**Costs:** A second, non-Node component to install and supervise. Kept opt-in and
scheduled last so it can be cut freely.
**Status:** ✅ Accepted
