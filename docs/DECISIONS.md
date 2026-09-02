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
The runtime and GC-pressure difference buys headroom that the visualizer's
shader chain can spend instead. Less critical on a Pi 5 than it would have been
on a Zero 2 W, but still the right default.
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

### D-004 · Pre-rendered blur, with real `backdrop-filter` now viable — **RELAXED**
**Originally chose:** server downscales album art aggressively and serves it as a
small image; the UI scales it *up*, letting bilinear filtering produce the blur.
**Why:** `backdrop-filter` is not usefully GPU-accelerated on VideoCore IV, and was
the single largest rendering risk on a Zero 2 W.
**Now that D-008 has settled on a Pi 5:** VideoCore VII with Mesa V3D supports
GLES 3.1 and real `backdrop-filter`. We are free to use it where it looks better.
**Keeping the pre-rendered path anyway** as the default: it's still cheaper, it
leaves more GPU budget for the Phase 5 shader chain, and it costs nothing now
that it's built.
**Status:** 🔄 Relaxed — pre-render by default, real blur available where it wins.

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

### D-006 · ~~No audio-reactive visuals~~ — **SUPERSEDED by D-010**
**Originally chose:** all motion procedural and time-based, on the grounds that
`audio-analysis`/`audio-features` were deprecated for new apps on 2024-11-27.
**Why it was wrong:** the deprecation removes *Spotify's* analysis, not every
possible reactivity signal. Two other routes exist — tempo lookup by ISRC, and a
real PCM tap when the Pi is the playback device.
**Status:** ❌ Superseded. The API facts stand; the conclusion drawn from them
did not. The *derived* consequence — no `recommendations`/`related-artists`, so
no discovery features — remains true and is unaffected.

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

### D-008 · Target hardware: **Raspberry Pi 5**
**Chose:** Raspberry Pi 5, with the official Raspberry Pi Touch Display 2.
**Why:** The visualizer (D-010) needs multi-pass WebGL2, which needs **GLES 3.1**.
VideoCore IV on the Zero 2 W does not have it, which ruled the Zero 2 W out
entirely. Between the Pi 4 and Pi 5, the Pi 5's VideoCore VII gives real headroom
for full-resolution effect stacks rather than forcing everything to half-res.
**Costs — all real, all accepted:**
- **Active cooling is required.** There will be a fan near the music. Mitigated by
  a good case and the fact that Joshify's steady-state load is low.
- **~2.7W idle** vs the Pi 4's ~1.0W, for an always-on device.
- **No 3.5mm output** — the Pi 5 removed it. The librespot module (now Phase 5)
  needs a USB DAC, an I2S DAC HAT, or HDMI audio. See D-013.
- **22-pin/0.5mm DSI**, so a 22→15-way adapter cable is needed for the official
  display. Touch Display 2 includes it; the original Touch Display does not.
- **5V/5A (27W) USB-C** supply required.
- Needs **Raspberry Pi OS Bookworm 64-bit or later**.
**Status:** ✅ Accepted. Resolves Q1. Relaxes D-004 and the memory budget.

---

### D-009 · No in-browser playback; librespot for optional audio
**Chose:** If the Pi is to play audio, it is via `librespot`, not the Spotify
Web Playback SDK.
**Why:** The Web Playback SDK requires Widevine DRM, which is not available in
ARM Linux Chromium builds. It is a dead end on this hardware regardless of board.
**Costs:** A second, non-Node component to install and supervise. Kept opt-in and
scheduled last so it can be cut freely.
**Status:** ✅ Accepted

---

### D-010 · Three-tier reactivity behind one uniform contract
**Chose:** A single `ReactivityProvider` interface filling one GLSL uniform block,
with three implementations: **Tier 0** procedural (always), **Tier 1** BPM by ISRC
lookup (remote-control mode), **Tier 2** real FFT off a PCM tap (when the Pi plays
the audio, or from a mic).
**Why:** It makes the visualizer's quality degrade gracefully instead of failing.
Shaders are written once against the contract and never branch on data source.
It also makes the whole engine testable headlessly by scripting the provider.
**Costs:** An abstraction where a simpler build would hardcode. Tier 1 gives
tempo but not downbeat phase (mitigated by tap-tempo, P5-11).
**Status:** ✅ Accepted. Supersedes D-006. See [VISUALIZER.md](./VISUALIZER.md).

---

### D-011 · Half-resolution rendering as both optimisation and art direction
**Chose:** Render the visualizer chain at 0.5× and upscale; expose the scale as a
user-facing "grain" slider. Sharp elements (spectrum bars, text) composite in a
final full-resolution pass.
**Why:** Cuts fragment shader work **4×** — by far the largest performance lever.
And the soft, chunky upscale *is* the lofi/VHS aesthetic being asked for, so the
performance dial and the look are literally the same control. Rare case where the
cheap thing is also the better-looking thing.
**Costs:** Effects needing precision must be explicitly promoted to the sharp pass.
**Status:** ✅ Accepted

---

### D-012 · Effects are data, not code paths
**Chose:** A preset is a JSON list of passes with parameters; each effect is a
standalone fragment shader file.
**Why:** Adding an effect becomes adding a file, not editing a pipeline. Presets
become user-editable and shareable. Keeps the engine small while the catalogue grows.
**Costs:** A small amount of indirection and a uniform-binding layer.
**Status:** ✅ Accepted

---

### D-013 · librespot promoted to Phase 5; USB DAC for audio out
**Chose:** Move the optional `librespot` module from Phase 8 to Phase 5, alongside
the visualizer. Recommend a **USB DAC** for analogue output rather than a HAT.
**Why:** librespot's PCM tap is what unlocks Tier 2 real-FFT visuals (D-010) — the
actual Winamp payoff. Shipping the visualizer without it means shipping an
estimated spectrum when a real one was one phase away.
On output: the Pi 5 has no 3.5mm jack. An I2S DAC HAT sits on the GPIO header and
can physically foul a touchscreen case or stand; a USB DAC dongle avoids the
conflict entirely and "just works" with most C-Media class devices.
**Costs:** librespot is a non-Node component to install and supervise, arriving
earlier than planned. It stays **opt-in** — the core install must never depend on
it, and Tiers 0–1 must remain fully functional without it.
**Status:** ✅ Accepted. Resolves V1. (V2, a room-listening microphone, is
declined for now — it reuses the same PCM code path, so it stays cheap to add later.)
