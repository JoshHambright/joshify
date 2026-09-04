# Joshify — Hardware Analysis

Resolves open decision **D-008** and tracker question **Q1**.

Last updated: 2026-09-02

---

## The question

> "Would a beefier Pi make for a better experience?"

**Yes — materially. And the strongest reason isn't performance.**

> ## ✅ DECIDED: Raspberry Pi 5 (decision D-008)
>
> Jump to the [buy list](#buy-list) for the parts, including two gotchas that
> will cost you a second order if you miss them.

## The finding that changes everything

**The Raspberry Pi Zero and Zero 2 W have no DSI display connector.** They are the
only current models that don't.

That means the Zero 2 W **cannot use the official Raspberry Pi Touch Display**, or
any DSI panel. Your only options are HDMI touchscreens, which need:

- a mini-HDMI cable (a right-angle adapter, in practice, to fit a case),
- a separate USB cable for the touch layer, or GPIO jumper wiring for it,
- and often a separate power feed for the panel.

So the "clean nano object" is actually **three cables and an adapter** stuffed into
a small case. A Pi 4 or 5 with the official Touch Display is **one ribbon cable**
and a single power lead, in an off-the-shelf case designed for exactly that.

The board that seemed like the right choice for a tidy physical object is the one
that makes the object least tidy.

## Comparison

| | **Zero 2 W** | **Pi 4 (2–4GB)** | **Pi 5 (4GB)** |
|---|---|---|---|
| CPU | 4×A53 @1GHz | 4×A72 @1.5–1.8GHz | 4×A76 @2.4GHz |
| RAM | **512MB** | 2GB / 4GB | 4GB+ |
| GPU | VideoCore IV | VideoCore VI (V3D, GLES 3.1) | VideoCore VII |
| **DSI display** | ❌ **None** | ✅ Yes | ✅ Yes |
| Wi-Fi | 2.4GHz only | 2.4 + 5GHz | 2.4 + 5GHz |
| Idle power | ~0.7W | **~1.0W** | ~2.7W |
| Active cooling | Not needed | **Not needed** | **Recommended** |
| Analogue audio out | ❌ none | ✅ 3.5mm | ❌ none (removed) |
| DSI connector | ❌ none | 15-pin/1mm | 22-pin/0.5mm (needs adapter) |
| Approx. cost | ~$15 | ~$45–60 | ~$60–80 |

## What each buys us

### Zero 2 W — buildable, but we pay in the least fun places

It *can* run Joshify. The architecture in PRODUCT.md §8 was designed specifically
to make it work. But the cost is spread across exactly the tasks nobody enjoys:

- **512MB is genuinely tight.** Node (~70MB) + browser engine (~150MB+) + decoded
  album thumbnails. The Phase 6 search and library screens — the ones you asked
  for — are the most memory-hungry in the product. Every long list becomes a
  budgeting exercise (P6-04, P6-08, P7-10).
- **VideoCore IV can't do real blur.** Hence D-004's pre-rendered-blur workaround.
  It works, but it's a compromise we designed *around* the hardware.
- **2.4GHz-only Wi-Fi** adds latency and contention to a polling app.
- **The cabling problem above.**

### Pi 4 — the sweet spot ⭐

Roughly $40 more, and it deletes whole categories of work:

- **DSI → one ribbon cable.** Official Touch Display, purpose-built cases. The
  physical object becomes genuinely nice.
- **VideoCore VI has a proper Mesa V3D driver with GLES 3.1.** Real
  `backdrop-filter` works. We can use actual blur, real compositing, and richer
  motion instead of engineering around their absence.
- **2–4GB RAM.** The memory budget stops being a design constraint. Search,
  library browse and long lists just work.
- **5GHz Wi-Fi.** Lower, steadier poll latency.
- **No fan.** Silent, ~1W idle — correct for an always-on desk object.

### Pi 5 — more power, worse for *this*

Faster in every benchmark, but for a music appliance the tradeoffs point the
wrong way: Raspberry Pi **recommends active cooling** for the Pi 5, and it idles
at ~2.7W versus the Pi 4's ~1.0W. Joshify is a low-load, always-on, sits-on-your-
desk object. **A fan whirring next to your music is a real cost**, and we have no
workload that needs the extra speed.

## ⚠️ Update: the visualizer changes this from a preference to a requirement

Adding the Winamp-style visualizer engine ([VISUALIZER.md](./VISUALIZER.md)) makes
this decision much less close.

A multi-pass WebGL2 fragment shader chain at 60fps is exactly what the **Zero 2 W's
VideoCore IV cannot do**: no GLES 3.x, poor driver support, and no memory headroom
for ping-pong framebuffers on top of Node and a browser engine.

The **Pi 4's VideoCore VI (Mesa V3D, GLES 3.1)** runs WebGL2 properly and handles
the chain comfortably at half-resolution (D-011).

**The Zero 2 W moves from "constrained but viable" to "cannot do the thing you
actually want."** It is no longer a recommendation — it's a requirement.

There is also a second-order effect: the Pi 4 has a **3.5mm analogue output** and
the Zero 2 W has **none**. Since the librespot PCM tap is what unlocks real-FFT
visuals (Tier 2), the Zero 2 W would need a DAC/HAT to get there — more cost, more
cables, and worse than the "beefier board" it was supposed to undercut.

---

## Recommendation → decided

> ### 🎯 Raspberry Pi 5 (4GB or 8GB) with the official Raspberry Pi Touch Display 2.

Between the Pi 4 and Pi 5, the Pi 5 wins on headroom: VideoCore VII means the
visualizer can run deep effect stacks at **full** resolution rather than being
pinned to half-res. The half-res default (D-011) stays as an art-direction choice
we can dial up, instead of a limit we're stuck behind.

**The accepted costs, stated plainly:**

| Cost | Mitigation |
|---|---|
| **Active cooling required** — a fan near the music | Joshify's steady-state load is low, so the fan should rarely spin up hard. Pick a case with a good cooler. |
| **~2.7W idle** vs the Pi 4's ~1.0W | Negligible in absolute terms for an always-on desk device. |
| **No 3.5mm jack** — removed on the Pi 5 | USB DAC for librespot. See below. |
| **5V/5A (27W) USB-C supply** | Use the official one. Under-powering a Pi 5 causes weird, hard-to-debug faults. |
| **Bookworm 64-bit or later required** | Bullseye does not support the Pi 5 at all. |

---

## Buy list

### Required

| Part | Notes |
|---|---|
| **Raspberry Pi 5**, 4GB or 8GB | 4GB is plenty for Joshify. 8GB only if the board will do other things later. |
| **Official 27W USB-C PSU (5V/5A)** | Not optional. Under-volting a Pi 5 produces confusing instability. |
| **Active cooling** | Official Active Cooler, or a case with one integrated. |
| **Raspberry Pi Touch Display 2** | DSI, so one ribbon cable. Touch works with no extra wiring. |
| **microSD (32GB+, A2)** | Or an NVMe drive via the PCIe connector, if the case supports it. |

### ⚠️ Two gotchas that will cost you a second order

**1. The DSI cable is a different size on the Pi 5.**
The Pi 5 uses a **22-pin, 0.5mm-pitch** MIPI connector. Every previous full-size
Pi used **15-pin, 1mm-pitch**. You need a **22-way → 15-way display adapter cable**.

> Touch Display 2 ships with the correct cables. The **original** Touch Display
> does not — you'd need to buy the adapter separately. And note these are
> **display** cables: camera adapter cables look identical and do not work.

**2. The Pi 5 has no headphone jack.**
It was removed. For the librespot module (Phase 5) you need one of:

| Option | Verdict |
|---|---|
| **USB DAC / USB sound card** | ✅ **Recommended.** ~$10, C-Media class devices just work, and it leaves the GPIO header free. |
| **I2S DAC HAT** | Better audio quality, but it **sits on the GPIO header and can physically foul a touchscreen case or stand**. Only if you've checked clearance. |
| **HDMI audio** | Free, but only useful if something on the HDMI chain has speakers — and our display is DSI, so probably not. |

Resolving which USB DAC is open question **V4**, and it blocks task P5-20 — but
it's a $10 decision we can defer to just before Phase 5.

### Not needed

- ~~DAC HAT~~ — see above; a USB dongle avoids the case conflict.
- ~~Microphone~~ — declined for now (V2). The same PCM code path serves it, so
  it stays cheap to add later if you want room-reactive visuals.

---

## What the Pi 5 changes in the plan

Nothing designed so far is wasted — the architecture stands. It gets easier, and
the UI gets to be more ambitious.

Nothing is wasted — the architecture stays. It just gets easier, and gets better.

| Item | Change |
|---|---|
| **D-004** (pre-rendered blur) | **Relaxed.** Real `backdrop-filter` is viable. Pre-rendering stays the default — it leaves more GPU for the shader chain — but we can use real blur where it looks better. |
| **D-003** (server does the work) | **Keep regardless.** Still correct — it keeps tokens out of the browser and the render thread free. |
| **Kiosk runtime** | **Chromium is now the likely default** for WebGL2 support and dev/prod parity. Settled with measurements at P3-01, not assumption. |
| **P6-04 / P6-08** (list virtualisation, thumbnail eviction) | Still good practice, no longer make-or-break. |
| **P7-10** (memory budget) | Relaxed from 400MB to **700MB** combined RSS. |
| **P8-08** (hardware guide) | Simpler, but must call out the 22→15-way DSI cable and the 27W supply. |
| **librespot** | **Promoted from Phase 8 to Phase 5** (D-013) — its PCM tap unlocks Tier 2 real-FFT visuals. Needs a **USB DAC**, since the Pi 5 has no 3.5mm jack. |
| **Phase 3 UI ambition** | **Increases.** We can afford motion and effects the Zero 2 W would have forced us to cut. |
| **Phase 5 (visualizer)** | **Becomes possible at all**, and then some — VideoCore VII can run deep effect stacks at full resolution, not just half-res. |

## Status

**Decision D-008: ✅ resolved — Raspberry Pi 5.** All docs updated to match.

Remaining hardware question: **V4 — which USB DAC**, blocking P5-20. A ~$10
decision, deferrable until just before Phase 5.
