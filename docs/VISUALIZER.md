# Joshify — Visualizer Engine

Winamp-lineage visuals, driven by the album art.

Status: `DRAFT v1` · Last updated: 2026-09-02

---

## The problem, and the way around it

Classic Winamp visualizers (Milkdrop, the spectrum analyzer, the oscilloscope)
are **audio-reactive** — they read the actual PCM waveform. Joshify, as a remote
control, doesn't have the audio. And Spotify's `audio-analysis` / `audio-features`
endpoints — which would at least have given us tempo and beat grids — were
deprecated for new apps on 2024-11-27 and now return `403`.

That was the basis for decision **D-006: no audio-reactive visuals.**

**D-006 was too pessimistic.** There are three separate ways to get a reactivity
signal, and two of them work fine. So instead of one visualizer, we build one
**uniform contract** with three interchangeable providers behind it.

---

## The three tiers of reactivity

Every effect shader reads the same uniform block. What fills it depends on what's
available at runtime — the shaders never know or care.

```glsl
uniform float uTime;        // seconds, monotonic
uniform float uEnergy;      // 0..1  overall intensity
uniform float uBeat;        // 0..1  decaying spike on each beat
uniform float uBands[16];   // 0..1  spectrum buckets, bass -> treble
uniform vec3  uAccent;      // from album art
uniform vec3  uForeground;
uniform float uIntensity;   // user-set effect strength
uniform sampler2D uArt;     // the album cover
uniform sampler2D uPrev;    // previous frame (feedback)
```

### Tier 0 — Procedural · *always available*

`uTime` drives layered LFOs; `uBands` is filled with smooth pseudo-noise; `uBeat`
pulses on a slow, honest rhythm that **does not claim** to be the track's beat.

Works in every mode, on every track, with zero dependencies. This is the floor,
and it still looks good — most Milkdrop presets are far more time-driven than
audio-driven anyway.

### Tier 1 — BPM lookup · *works in remote-control mode* ⭐

Spotify's track object still includes **`external_ids.isrc`** — the industry
standard recording identifier. That is not deprecated.

So: `ISRC → external BPM database → tempo`. Combined with `progress_ms` and a
monotonic clock, we can generate a **phase-locked pulse** that lands on the beat.

```
beatPhase = ((progressMs / 1000) * (bpm / 60)) % 1
uBeat     = pow(1 - beatPhase, 4)      // sharp attack, exponential decay
```

Candidate sources (evaluated in the P5-02 spike):

| Source | Lookup | Cost | Notes |
|---|---|---|---|
| **GetSongBPM** | artist/title | Free | Requires an attribution backlink — must be honoured |
| **AcousticBrainz** | MusicBrainz ID | Free, dumpable | Data frozen at the 2022 dump; stale but **works offline** |
| **Deezer** | ISRC | Free | Exposes `bpm` on the track object |
| **SoundCharts / FreqBlog** | ISRC | Commercial | Fallback only if the free options are too patchy |

Results are cached on disk, keyed by ISRC, permanently. A given track is looked
up **once, ever**. An offline AcousticBrainz dump plus a small cache means most
of a personal library resolves without a network call at all.

**Caveats, stated honestly:** we get tempo but **not downbeat phase**, so the
pulse is on-tempo but may be offset within the bar. Live recordings and rubato
drift. Variable-tempo tracks won't hold. A **tap-tempo / nudge-phase** touch
control fixes all of this in two taps and is genuinely fun to use — it's on the
task list (P5-11).

### Tier 2 — Real FFT · *when the Pi is the playback device* 🔥

**This is the one that makes it actually Winamp.**

If the optional `librespot` module is enabled, the audio is decoded **on the Pi**.
librespot's `--backend pipe` emits raw **16-bit signed LE interleaved PCM at
44.1kHz stereo** — confirmed in the project's own backend documentation. We tap
that stream, run a real FFT, and get genuine spectrum and beat detection.

```
librespot --backend pipe ──► tee ──┬──► ALSA (the actual sound)
                                   └──► joshify-server ──► FFT ──► uBands/uBeat
```

That's a true spectrum analyzer off the real waveform. No estimation, no lookup,
no deprecated API. The thing the original Winamp did.

**This makes the optional audio module much more compelling than it was.** It
stops being "the Pi can also be a speaker" and becomes "the Pi can also be a
*real* visualizer." See §Open questions.

### Tier 2b — Microphone · *the wildcard*

A ~$8 USB mic (or an I2S MEMS mic on the GPIO) listening to the room gives real
FFT **regardless of where the audio is playing**. Same code path as Tier 2, just
a different PCM source.

Upsides: works with your existing speakers, no librespot needed, and it reacts to
the room — the object feels alive.
Downsides: picks up conversation, needs automatic gain control and a noise gate,
and quality depends on mic placement.

---

## The effects catalogue

All GLSL fragment shaders, composed as a **post-processing chain** with the album
art as the source texture. Each is small, independent, and individually toggleable.

### A · Feedback (the Milkdrop lineage)

The core Milkdrop technique: render the previous frame back into itself with a
small transform. Ping-pong framebuffers. Cheap, and the source of almost all the
"infinite" looks.

| Effect | What it does |
|---|---|
| **Zoom tunnel** | Previous frame scaled slightly up, forever — art recedes into infinity |
| **Rotational feedback** | Feedback plus a small rotation — spirals |
| **Warp feedback** | Feedback through a noise-displaced UV field — liquid smoke |
| **Echo trails** | Decaying feedback — motion leaves ghosts |

### B · Glitch & datamosh

| Effect | What it does |
|---|---|
| **RGB channel split** | Chromatic aberration; offset R/G/B. The definitive glitch look |
| **Block displacement** | Shift 8/16px blocks by a hash — corrupted-JPEG datamosh |
| **Pixel sort** | Sort rows by luminance above a threshold — the classic glitch-art smear |
| **Scanline tear** | Random horizontal rows offset — broken signal |
| **Dropout frames** | Occasionally punch through to noise or a stale frame |
| **Bit crush** | Quantize colour channels hard — banding as an aesthetic |

### C · Analog / lofi degradation

| Effect | What it does |
|---|---|
| **VHS tracking wobble** | Noise-driven horizontal warp + tape warble |
| **CRT** | Scanlines, barrel curvature, phosphor mask, vignette |
| **Film grain & dust** | Animated grain, occasional specks and hairs |
| **Bayer dither** | Ordered dithering to a reduced palette — pairs beautifully with album art |
| **Posterize** | Colour quantization to the extracted theme palette |
| **Bloom** | Soft light bleed on highlights |
| **Halftone** | Dot-matrix / newsprint |

### D · Winamp classics

| Effect | What it does |
|---|---|
| **Spectrum bars** | The bars. Non-negotiable. |
| **Oscilloscope** | Raw waveform trace |
| **Kaleidoscope** | Mirror the art into N-fold symmetry |
| **Particle bloom** | Beat-spawned particles tinted from the palette |

### E · Art-derived

The thing that makes this Joshify's and not a generic viz pack: **the album cover
is the source texture for everything above.** Not a backdrop — the actual input.

| Effect | What it does |
|---|---|
| **Art shatter** | Cover fragments and reassembles on the beat |
| **Palette cycling** | Remap art luminance through the extracted palette, animated |
| **Slit-scan** | Each row sampled from a different point in a frame-history buffer |
| **Displacement** | Art's own luminance drives UV distortion of itself |

**Presets** combine these into named looks — `VHS`, `Tunnel`, `Datamosh`,
`Ghost`, `Newsprint`, `Vapor` — selectable by touch, with a shuffle mode that
changes preset on track change. Very Winamp.

---

## Architecture

```
album art (640px, cached)
        │
        ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ source  │──►│ pass 1  │──►│ pass 2  │──►│ pass N  │──► screen
   └─────────┘   └────┬────┘   └─────────┘   └─────────┘
                      │ ▲
                      ▼ │  ping-pong FBO (feedback)
                   ┌───────┐
                   │ uPrev │
                   └───────┘
                      ▲
   uTime / uBeat / uBands / uAccent ──┘
        ▲
   ┌────┴──────────────────────────────┐
   │ ReactivityProvider  (one of:)     │
   │   Tier 0  procedural              │
   │   Tier 1  BPM (ISRC lookup)       │
   │   Tier 2  FFT (librespot / mic)   │
   └───────────────────────────────────┘
```

- **WebGL2 / GLSL ES 3.0** in the kiosk browser.
- Effects are **data**, not code paths: a preset is a JSON list of passes with
  parameters. Adding an effect is adding a shader file, not editing a pipeline.
- The reactivity provider is injected — so the whole engine is testable headlessly
  by feeding it a scripted `uBeat`/`uBands` sequence.

### The performance trick that is also the aesthetic

**Render the visualizer at half resolution and upscale it.**

This cuts fragment work by **4x** — the single biggest performance lever we have.
And because the look we want is *lofi, chunky, degraded*, the resulting soft,
pixelated upscale isn't a compromise — **it's the aesthetic.** VHS was never
sharp.

Resolution scale becomes a user-facing "grain" slider that happens to also be the
performance dial. Effects that need sharpness (spectrum bars, text) render in a
final full-resolution pass on top.

### Budget

| | Target |
|---|---|
| Frame rate | 60fps, degrading gracefully to 30fps |
| Passes per frame | <= 6 |
| Render scale | 0.5x default, 0.25x-1.0x selectable |
| Extra RSS | < 80MB over Now Playing |
| Auto-degrade | Drop render scale, then pass count, if frames are missed |

---

## Product integration

Winamp got this right: **the visualizer is a mode, not the whole app.**

1. **Now Playing** (default) — art forward, effects subtle or off.
2. **Ambient** — light effects behind the art. Controls still visible.
3. **Full visualizer** — takes the screen. Tap anywhere to bring controls back.
4. **Auto-enter** — after N seconds untouched, drift into full visualizer. The
   screensaver behaviour, which is exactly what this wants to be.

Effects must never break the PRODUCT.md §5.3 design principles: at any intensity,
the track title stays readable and the transport stays hittable. There is a hard
**"legibility floor"** — a check that the composited frame maintains contrast
behind text — enforced in tests, not by eye.

---

## Hardware consequence

This **significantly strengthens the Pi 4 recommendation in HARDWARE.md.**

A multi-pass fragment shader chain at 60fps is precisely what the **Pi Zero 2 W's
VideoCore IV cannot do** — it has no GLES 3.x, poor driver support, and no memory
headroom for ping-pong framebuffers on top of Node and a browser.

The **Pi 4's VideoCore VI (Mesa V3D, GLES 3.1)** runs WebGL2 properly and handles
this comfortably at half-resolution. If we go deep on stacked effects at full
resolution, the Pi 5's VideoCore VII has real headroom — but the fan tradeoff in
HARDWARE.md still stands.

**With the visualizer in scope, the Zero 2 W moves from "constrained but viable"
to "cannot do the thing you actually want."**

---

## Open questions

| # | Question | Impact |
|---|---|---|
| V1 | Promote `librespot` from Phase 8 to Phase 5 so Tier 2 real-FFT ships with the visualizer? | Tier 2 is the payoff. Without it we ship Tiers 0-1 and add FFT later. |
| V2 | Add a microphone for room-listening FFT? | ~$8 and unlocks real reactivity without librespot. Needs a hardware decision. |
| V3 | Which BPM source wins the P5-02 bake-off? | Coverage vs. offline capability. Resolve with real data from Josh's library. |
