# Spike: Signal Rot — glitch synth + visual generator

A self-contained web instrument: generative glitch music, an audio-reactive
visual field, and a touch control surface. Built to run on a phone.

**Open `index.html` in any browser.** No build step, no dependencies, no assets.
Published for review at the artifact link in the session; the source lives here
so it survives the container.

> Not a Joshify feature. This is an instrument in its own right, kept here
> because the techniques below feed Phase 5 and because `spikes/` is where
> visual prototypes live (D-016). It adds no tracker tasks (D-019).

## What it is

| Half | Approach |
|---|---|
| Audio | One `ScriptProcessorNode`. Every sample — sequencer, voices, effects — computed in JS |
| Visual | WebGL1 ping-pong feedback, driven by an `AnalyserNode` uploaded as a 256×2 texture |
| Control | Multi-touch XY field, six momentary pads, a 16-step grid, four control panes |

Four voices (bass, pulse lead, noise perc, three-saw drone) run off Euclidean
patterns with a per-step chaos probability. Master chain, in order:

```
drive → state-variable filter → ring mod → sample&hold → bitcrush
      → delay (crushed feedback) → stutter/reverse → granular smear → limiter
```

## What it proves

| Claim | Verified how |
|---|---|
| A whole DSP chain fits in one ScriptProcessor at phone budgets | ~2% of the block budget at 2048 frames; the CPU figure is in the header |
| No AudioWorklet needed | Blob-URL worklet modules are a CSP gamble in a published page; ScriptProcessor is universal and needs no module fetch |
| Sample-accurate sequencing without `setTimeout` | The step clock is a sample counter inside the render block, so tempo never drifts against the audio |
| Real glitch DSP wants sample-level access | Bitcrush, S&H, buffer-repeat and reverse are trivial per-sample and awkward-to-impossible as a node graph |
| The analyser can drive a shader cheaply | 256 bins + 256 wave samples as one 2048-byte `texSubImage2D` per frame |
| Feedback buffers are the whole visual | Five modes share one ping-pong pass; the modes differ only in what ink they add on top |
| Low internal resolution reads as *more* glitch | Feedback renders at 30–100% (`RENDER`), presents at full — same finding as D-011 |

## Techniques worth keeping

**The step clock lives in the audio callback.** No scheduler, no lookahead
queue, no drift:

```js
stepAcc++;
if(stepAcc >= stepLen){        // stepLen = sr*60/bpm/4
  stepAcc -= stepLen;
  step = (step+1)%16;
  onStep(step);
}
```

**Padé approximation of `tanh` as the limiter.** Exactly ±1 at ±3, smooth
through zero, no transcendental in the inner loop:

```js
function sat(x){
  if(x<-3)return -1; if(x>3)return 1;
  const x2=x*x; return x*(27+x2)/(27+9*x2);
}
```

**Crushed feedback.** The delay line is re-quantised on every pass, so repeats
lose *resolution* as well as amplitude. This is the single most characteristic
sound in the instrument, and it's four lines.

**The granular engine reads the output history.** A 2-second circular buffer of
post-effect output; grains replay it at ±0.5/1/2× with a Hann window. Because
the recording is post-effect, smear compounds — this is the audio equivalent of
the visual feedback buffer, and the two are worth wiring to one control.

**A procedural bed under the analyser data**, fading out as real signal arrives:

```js
const live = clamp(lvlE*2.4, 0, 1);
const bed  = 0.06 + 0.44*(1-live);
```

Without it the visual field goes black whenever the music is quiet — on a
mute, between hits, in the gaps of a sparse pattern. Any audio-reactive
visualiser needs this floor. **Directly relevant to Phase 5:** Joshify's
visualiser has no audio analysis available at all (D-010), so it is *entirely*
bed — the same idea with `live` pinned to zero.

**Vertex-attribute scope, not a raymarched one.** Drawing the waveform as a
256-vertex `LINE_STRIP` into the feedback buffer costs one `bufferSubData`.
Computing distance-to-curve per fragment would be ~48 texture fetches per pixel
and is what a naive shader-only version does.

**Chromatic aberration as the accent, not a filter.** Red and blue are sampled
at opposing offsets and graded through the same ramp; the magenta/cyan identity
of the piece falls out of the RGB split itself rather than being painted on.

## Mobile notes

- `ScriptProcessorNode` runs on the main thread. At 2048 frames (chosen when
  `pointer: coarse`) there is ~46 ms of latency, which is why **every musical
  event is quantised to the step grid** — latency never reaches the ear.
- iOS silences Web Audio when the hardware ringer switch is on. There is no API
  for this; the start screen says so.
- `RENDER` exists because the feedback pass is the only thing that scales with
  screen area. Drop it before dropping anything else.
- `touch-action: none` plus pointer capture on the XY field and pads; a second
  finger on the XY field sets filter resonance from the spread.
- Tilt uses `DeviceOrientationEvent.requestPermission()` where it exists.

## Known rough edges

- `ScriptProcessorNode` is deprecated. It is the right call for a spike (no
  module fetch, universal support); a production version would use an
  AudioWorklet with the same DSP, given a host whose CSP allows the module.
- The Chamberlin SVF can go non-finite when driven hard into high resonance.
  There is a once-per-block finite check rather than a per-sample guard.
- Patterns and mixer state are not persisted; a reload starts fresh.
- Untested on real iOS/Android hardware — the container has no audio device, so
  the audio path has only been verified for CPU cost and clock stability, not
  by listening.
