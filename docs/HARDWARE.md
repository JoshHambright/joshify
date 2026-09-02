# Joshify — Hardware Analysis

Resolves open decision **D-008** and tracker question **Q1**.

Last updated: 2026-09-02

---

## The question

> "Would a beefier Pi make for a better experience?"

**Yes — materially. And the strongest reason isn't performance.**

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
| Approx. cost | ~$15 | ~$45–60 | ~$60–80 |

## What each buys us

### Zero 2 W — buildable, but we pay in the least fun places

It *can* run Joshify. The architecture in PRODUCT.md §8 was designed specifically
to make it work. But the cost is spread across exactly the tasks nobody enjoys:

- **512MB is genuinely tight.** Node (~70MB) + browser engine (~150MB+) + decoded
  album thumbnails. The Phase 5 search and library screens — the ones you asked
  for — are the most memory-hungry in the product. Every long list becomes a
  budgeting exercise (P5-04, P5-08, P6-10).
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

## Recommendation

> ### 🎯 Raspberry Pi 4, 2GB or 4GB, with the official Raspberry Pi Touch Display.
>
> 4GB if you want zero thought about memory ever; 2GB is genuinely sufficient
> for Joshify. Passively cooled, single ribbon cable, silent, and it lets us
> build the *nicer* version of the UI rather than the cleverly-constrained one.

Pick the Pi 5 only if you want the board to have a second life as something else
later, and you're happy to put a fan on your desk.

## What changes in the plan if we move to a Pi 4

Nothing is wasted — the architecture stays. It just gets easier, and gets better.

| Item | Change |
|---|---|
| **D-004** (pre-rendered blur) | **Relaxed.** Real `backdrop-filter` becomes viable. Keep pre-rendering as a fallback and a nice optimisation, but the UI can be richer. |
| **D-003** (server does the work) | **Keep regardless.** Still correct — it keeps tokens out of the browser and the render thread free. |
| **Kiosk runtime** (`cog`/WPE) | **Chromium becomes viable.** Better dev/prod parity and easier debugging. We'd re-evaluate at P3-01 rather than committing to WPE now. |
| **P5-04 / P5-08** (list virtualisation, thumbnail eviction) | Still good practice, but no longer make-or-break. |
| **P6-10** (RSS < 400MB) | Budget can be relaxed substantially. |
| **P7-08** (hardware guide) | Much simpler — official display, official case. |
| **P7-11** (audio out for librespot) | Pi 4 has a **3.5mm analogue jack**; the Zero 2 W has **none** and would have required a DAC/HAT. The optional audio module gets much easier. |
| **Phase 3 UI ambition** | **Increases.** We can afford motion and effects the Zero 2 W would have forced us to cut. |

## Status

**Decision D-008: pending Josh's call.** The docs currently assume the Zero 2 W;
if we switch, the affected sections above get updated in the same commit as the
decision.
