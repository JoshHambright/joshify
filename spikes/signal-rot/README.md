# Spike: Signal Rot — tape-damaged synth + visual generator

A self-contained web instrument: generative lofi music, an audio-reactive
visual field graded as aged analogue media, and a touch control surface. Built
to run on a phone.

**Open `index.html` in any browser.** No build step, no dependencies, no assets.
Published for review at the artifact link in the session; the source lives here
so it survives the container.

> Not a Joshify feature. This is an instrument in its own right, kept here
> because the techniques below feed Phase 5 and because `spikes/` is where
> visual prototypes live (D-016). It adds no tracker tasks (D-019).

## What it is

| Half | Approach |
|---|---|
| Audio | One `ScriptProcessorNode`. Every sample — sequencer, voices, effects, media decay — computed in JS |
| Visual | WebGL1 ping-pong feedback, driven by an `AnalyserNode` uploaded as a 256×2 texture, graded through a four-colour stock |
| Motion | The previous frame is advected along a vortex flow field; the long-form structure comes from random walks with no period |
| Control | Multi-touch XY field, eight momentary pads, a 16-step × 5-track grid, five whole-instrument scenes |

Five voices — bass, pulse lead, noise perc, 2-op FM bell, three-saw drone — run
off swung Euclidean patterns with a per-step chaos probability. Master chain:

```
drive → state-variable filter → ring mod → sample&hold → bitcrush
      → delay (crushed feedback) → stutter/reverse
      → TAPE: wow/flutter → hiss → azimuth rolloff → dropouts → vinyl dust
      → granular smear → limiter
```

Everything from `TAPE` on is scaled by one **AGE** macro.

## What it proves

| Claim | Verified how |
|---|---|
| A whole DSP chain plus a media-decay stage fits in one ScriptProcessor at phone budgets | ~2–3% of the block budget at 2048 frames; the CPU figure is in the header |
| No AudioWorklet needed | Blob-URL worklet modules are a CSP gamble in a published page; ScriptProcessor is universal and needs no module fetch |
| Sample-accurate sequencing without `setTimeout` | The step clock is a sample counter inside the render block, so tempo never drifts against the audio |
| Real glitch DSP wants sample-level access | Bitcrush, S&H, buffer-repeat, reverse and tape-stop are trivial per-sample and awkward-to-impossible as a node graph |
| Wow and flutter need a delay line, not an LFO on pitch | A modulated fractional read pointer detunes the *delay repeats* against the dry signal, which an oscillator-detune cannot do |
| "Old" is a grade, not an effect | Lifting the blacks and washing the colour (`FADE`) moves the image from "broken digital" to "aged" more than any artefact does |
| The analyser can drive a shader cheaply | 256 bins + 256 wave samples as one 2048-byte `texSubImage2D` per frame |
| Feedback buffers are the whole visual | Six modes share one ping-pong pass; the modes differ only in what ink they add on top |
| Advection, not scaling, is what reads as organic | A vortex field moves material along curved paths; an affine zoom moves every pixel toward one point, which is why it looked static |
| A random walk is the only real cure for "it loops" | Sine-driven motion has a period the eye finds in seconds; the drifts have no period at all |
| Low internal resolution reads as *more* glitch | Feedback renders at 30–100% (`RENDER`), presents at full — same finding as D-011 |

## Techniques worth keeping

**The step clock lives in the audio callback.** No scheduler, no lookahead
queue, no drift — and swing is one expression:

```js
stepAcc += pitch;                                  // pitch < 1 during tape-stop
const dur = stepLen * ((step & 1) ? (1-swing) : (1+swing));
if(stepAcc >= dur){ stepAcc -= dur; step = (step+1)%16; onStep(step); }
```

**Wow and flutter as a modulated fractional delay.** This is the one that
matters. Amplitude vibrato is not tape; tape is the read head sitting at a
*varying distance* from the write head:

```js
tp[tpPos] = sig;
const mod = (sin(TAU*wowPh) + sin(TAU*flutPh)*0.22 + sin(TAU*flut2Ph)*0.11) * wowDep;
let rpos = tpPos - tpBase - mod;                   // three rates: wow, flutter, scrape
const i0 = rpos|0, fr = rpos-i0;
sig = tp[i0]*(1-fr) + tp[(i0+1)%tp.length]*fr;     // linear interp = the pitch shift
```

**Tape stop is a global rate scalar.** Every phase increment and the step clock
are multiplied by one `pitch` value that ramps to zero over ~0.6s. Because the
sequencer is a sample counter in the same loop, the rhythm slows with the
pitch for free — nothing has to be told about it separately.

**Padé approximation of `tanh` as the limiter.** Exactly ±1 at ±3, smooth
through zero, no transcendental in the inner loop:

```js
function sat(x){
  if(x<-3)return -1; if(x>3)return 1;
  const x2=x*x; return x*(27+x2)/(27+9*x2);
}
```

**Taylor `2·sin(πx)` for filter coefficients.** Four state-variable filters
each need a coefficient per sample; the series is accurate well past the range
a cutoff ever reaches and removes three `Math.sin` calls from the inner loop:

```js
function svfF(x){ const u=Math.PI*x; return clamp(2*u - u*u*u/3, 0, 1.45); }
```

**Crushed feedback.** The delay line is re-quantised on every pass, so repeats
lose *resolution* as well as amplitude. Four lines, and it is the single most
characteristic sound in the instrument.

**The granular engine reads the output history.** A 2-second circular buffer of
post-effect output; grains replay it at ±0.5/1/2× with a Hann window. Because
the recording is post-effect, smear compounds — the audio equivalent of the
visual feedback buffer.

**A vortex flow field instead of an affine warp.** The first two versions
advected the previous frame with `R*(uv-0.5)*zoom + 0.5` — a rotation and a
scale about the centre. Every pixel moves the same way, so however much you
modulate it, it reads as a pulsing zoom. Three drifting vortices give
differential motion:

```glsl
vec2 vort(vec2 p, vec2 c, float s){
  vec2 d = p - c;
  return vec2(-d.y, d.x) * (s / (dot(d,d) + 0.045));   // perpendicular = swirl
}
vec2 flowField(vec2 p){
  vec2 v = vort(p,uV0,uSpin.x) + vort(p,uV1,uSpin.y) + vort(p,uV2,uSpin.z);
  v += 0.55*vec2(sin(p.y*7.3 - uVt*0.21), cos(p.x*6.1 + uVt*0.17));
  return v / (1.0 + length(v)*0.55);                   // soft-clamp
}
```

A vortex is divergence-free — it swirls material without pushing it in or out —
which is the property that makes it look like fluid rather than a transform.
Curl noise would be more correct and costs 12–16 noise evaluations per pixel;
three analytic vortices cost a divide each. **Centres and spins are computed on
the CPU and passed as uniforms**, so the whole field is two sines per pixel.

**Long-form structure from random walks, not LFOs.** A sine has a period, and
the eye finds it in about ten seconds. A smoothstep-interpolated walk between
random targets has no period at all:

```js
function drifter(period,min,max){
  return { t:rnd(), a:..., b:..., tick(dt){
    this.t += dt/period;
    while(this.t>=1){ this.t-=1; this.a=this.b; this.b=min+(max-min)*rnd(); }
    const s=this.t*this.t*(3-2*this.t);
    return this.a+(this.b-this.a)*s;
  }};
}
```

Six of them run at 29–61 second periods on independent phases — flow strength,
breath, ink density, ink-axis rotation, and one spin per vortex. Nothing
re-aligns, so the scene never returns to a state you have seen. `EVOLVE` scales
every drift's rate at once; at zero the structure holds still while the fast
artefacts (tear, grain, head-switch) keep running off real time.

**Normalise the ink deposit by `(1-decay)`.** A feedback buffer settles at
`ink/(1-decay)`, so a fixed deposit rate means raising TRAIL raises *brightness*
as well as smear length — long trails blow out to white, short ones vanish.
Scaling the deposit by `(1-decay)` holds the equilibrium fixed and lets TRAIL
mean only what it says:

```glsl
float decay = mix(0.78,0.990,uTrail) - uGlitch*0.010;
vec3 col = texture2D(uPrev, puv).rgb * decay;
col += ink*(0.70+uLevel*0.45)*uInk*(1.0-decay)*2.6;
```

This was a real bug, not a tuning preference: it only became visible once a mode
laid down broad soft ink instead of thin lines.

**Four-colour stocks as uniforms, not shader branches.** `c0` ground, `c1`
shadow, `c2` accent, `c3` highlight, passed as four `vec3`s and applied as one
luminance ramp. Adding a stock is a JS literal; the shader never changes. The
two monochrome stocks set a `uPoster` flag that quantises luminance to four
levels *before* the ramp — that one line is the entire Game Boy look.

**Colour-under, done properly.** VHS chroma carries far less bandwidth than
luma and lags to the right. Four rightward taps for red and blue against a
clean luma sample reproduces it, and costs less than a symmetric blur:

```glsl
for(int i=0;i<4;i++){
  float o = float(i)*uBleed*0.006;
  lr += lum(uv + vec2(o + ca, 0.0));
  lb += lum(uv + vec2(o*1.7 - ca, 0.0));
}
```

**A procedural bed under the analyser data**, fading out as real signal
arrives:

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
Computing distance-to-curve per fragment would be ~48 texture fetches per pixel.

## Scenes

| Scene | What it is |
|---|---|
| SUNDAY | 72 BPM, heavy swing, bells over a warm drone, Super 8 grade |
| BASEMENT | 88 BPM Phrygian, VHS, moderate damage |
| TRACKING | Transport failure — dropouts, head-switch tear, chroma smear |
| ARCADE | 132 BPM pentatonic, DMG four-tone green, minimal decay |
| RUINED | AGE at maximum. Barely holds together, which is the point |

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
- Patterns, mixer state and scenes are not persisted; a reload starts fresh.
  Preset *slots* would be the next real feature.
- The CRT barrel warp is applied in the present pass only, so the OSD and rack
  chrome sit flat on top of a curved image. Correct for a HUD, wrong if the
  whole thing is ever meant to read as one piece of glass.
- Untested on real iOS/Android hardware — the container has no audio device, so
  the audio path has only been verified for CPU cost and clock stability, not
  by listening.
