# `reactivity/` — the signal the visualiser dances to

Tasks: **P5-03** (the `ReactivityProvider` contract + Tier 0), **P5-11**
(tap-tempo / nudge-phase), and the **client half of P5-04** (the phase-locked
pulse driven by a known BPM). The server half of P5-04 — ISRC lookup and the
permanent disk cache — is not here.

| File | What it is |
| --- | --- |
| `provider.ts` | The contract. `Reactivity`, `ReactivityProvider`, and the beat envelope every tier shares. |
| `procedural.ts` | **Tier 0.** A musical-feeling signal from a clock and nothing else. |
| `tempo.ts` | **Tier 1, client half.** A known BPM + a track position → a phase-locked pulse. |
| `tap-tempo.ts` | The touch control that supplies the phase a BPM lookup cannot. |

Nothing here imports from `gl/`, touches the DOM, or owns a timer.

---

## The contract

```ts
interface Reactivity {
  readonly beat: number; // 0..1  envelope, 1 at the beat, decaying
  readonly energy: number; // 0..1  overall intensity, moving over seconds
  readonly phase: number; // 0..1  sawtooth position within the current beat
  readonly bands: Float32Array; // 16 × 0..1, bass → treble
}

interface ReactivityProvider {
  readonly tier: 0 | 1 | 2;
  sample(atMs: number): Reactivity;
}
```

**`beat`** is an envelope, not a trigger. It is `1` at the instant of a beat and
falls to `0` before the next one, so it is meant to be multiplied into something
— a scale, a flash, a particle emission rate. On Tier 0 the beats are invented
and do not claim to be the track's; on Tier 1 they are the track's tempo, at an
arbitrary offset within the bar until someone taps.

**`energy`** is the "how loud is this record" dial, moving on the order of
seconds. It has a floor (`ENERGY_FLOOR`, 0.18) and never reaches `0`, so an
effect scaled by energy gets quiet but never disappears. A visualiser that goes
completely black reads as a crash, not as a quiet passage.

**`phase`** is a sawtooth: `0` at the beat, rising to just under `1`, wrapping.
Use it for anything that should travel *between* beats — a tunnel's advance, a
sweep, a rotation. It is discontinuous at the beat by construction; that
discontinuity **is** the beat.

**`bands`** is a `Float32Array` rather than a `number[]` so it goes straight into
`uniform1fv` with no copy. Only Tier 2 can know the real spectrum; Tiers 0 and 1
synthesise something spectrum-*shaped* (bass-tilted, bass tied to the beat,
neighbours correlated) and are honest about it in the comments. The bars have to
move or the classic Winamp preset has nothing to draw.

### Two things a consumer must know

1. **Every value is in `0..1`, finite, never `NaN`.** This is load-bearing, not
   tidy: a `NaN` uniform makes a fragment shader's output undefined, so one bad
   sample blanks the screen of a device meant to run unattended for hours.
   `clamp01` maps `NaN` to `0` deliberately, because `Math.min(1, Math.max(0, x))`
   propagates it.
2. **The returned frame is owned by the provider and is only valid until the
   next `sample()`.** The render loop calls this sixty times a second for hours;
   a fresh object and a fresh `Float32Array` per frame is garbage a Pi does not
   need to make while it is also running a multi-pass shader chain. Read the
   numbers out and upload them. If you need to keep a frame — a scripted
   sequence in a test — copy it.

### No clock, no timer

`sample(atMs)` takes the instant as an argument, per D-042/D-043. `atMs` is a
**monotonic** reading (D-023) — the Pi has no RTC, and a beat grid that jumped a
year sideways on first NTP contact would be a memorable bug.

Tiers 0 and 1 are *pure functions of `atMs`*: nothing accumulates, so the same
instant always yields the same frame, a dropped frame cannot shift the
animation, and an eight-hour run cannot drift. That is also what makes P5-17
possible — a headless test can drive a whole track in a millisecond, in any
order.

---

## The four design questions

### 1. What makes a procedural signal feel musical rather than like a sine wave?

Two failure modes, both easy to hit. A pulse at a fixed rate with a fixed shape
reads as a **screensaver**: the eye finds the period in a couple of seconds and
then stops looking, because there is no more information coming. A signal driven
by noise reads as **broken**: it moves constantly and lands on nothing. Music is
neither — it is periodic at several timescales at once, and it varies *within*
those periods rather than between random values.

Four things get Tier 0 there:

- **A hierarchy of periods, not one period.** Beat (~0.54s), bar (4 beats),
  phrase (8 bars). Every real arrangement has this nesting and it is what lets a
  listener anticipate. One period has nothing to anticipate. `energy` is built
  from a phrase-length swell, a ~23s noise drift and the current beat, weighted
  0.45 / 0.35 / 0.20.
- **An accented bar.** `BAR_ACCENTS = [1, 0.62, 0.82, 0.62]` — downbeat
  strongest, backbeat next, offbeats lightest. Four identical beats are a
  metronome; four beats with a shape are a bar. It is the cheapest musicality
  available: one array lookup.
- **Tempo that drifts.** ±6% over ~37s. Below the threshold where you would call
  it a tempo change, above the one where the pulse feels quantised. Nothing
  played by a human is metronomic and the micro-variation is a large part of why
  a groove feels alive.
- **An asymmetric envelope.** A sine at beat rate is the canonical wrong answer:
  it spends as long rising as falling, so there is no instant you can point at as
  *the* beat.

The **drift is expressed in closed form, not integrated**, and this is the part
worth flagging to a reviewer. The naive way to vary tempo is to recompute
`phase = t · bpm(t) / 60` each frame — which is wrong in an interesting way:
changing the frequency retroactively moves every *past* beat, so the pulse
jitters forwards and backwards instead of speeding up. The correct phase is the
integral of frequency, and for `f(t) = f₀(1 + d·sin ωt)` that integral has a
closed form:

```
beats(t) = f₀ · ( t + (d/ω)·(1 − cos ωt) )
```

Differentiating gives the frequency back exactly. So the tempo genuinely
breathes, no past beat ever moves, and the whole thing stays a pure function of
`t` — no accumulator, therefore no drift. `procedural.test.ts` asserts the
instantaneous rate really does swing ±6% and that the beat *spacing* is not
metronomic.

The spectrum gets the same treatment: value noise (smooth, seeded, continuous —
not a random number per frame), tilted towards the bass because real music loses
energy with frequency, with the bass bands driven by the beat envelope because a
kick lives below 120Hz and bars that ignore the pulse look like a different song
playing. Neighbouring bands sample the same noise field a `BAND_STRIDE` of 0.42
apart, so they are correlated but not identical — which is what produces the
wave travelling across a bar display. Sixteen independent noise fields read as
static; one shared field reads as a single wide bar.

### 2. What is the attack/decay envelope of a beat, and why is decay slower than attack?

`beatEnvelope`: **instant attack, one-frame hold, quartic decay over 260ms.**

Physically, a struck body takes its whole excitation in one impulse and then
radiates it away over the body's resonance — energy in fast, energy out slow.
Perceptually, the ear locates a musical event by its *onset*: sharpen the attack
and a sound reads as a hit, soften it and the same sound reads as a swell. A
symmetric envelope reads as breathing — the pumping of an over-compressed mix —
and never as percussion.

For a *visualiser* the asymmetry matters more than it does for audio. At 60fps
the attack is at most one frame, so it is barely seen at all; the decay is the
entire visible gesture. The rise is what the eye interprets as impact, the fall
is what it actually watches. Make them equal and you get a throb.

Two details that are not obvious:

- **The one-frame hold is a sampling fix, not an envelope shape.** With a truly
  instantaneous attack, a 60Hz sampler sees whatever the decay had reached by the
  next frame boundary — between 100% and about 78% depending on where the frame
  happened to land. That is a beat-to-beat brightness flicker with no musical
  cause, and it is visible. Holding for 17ms (one 16.67ms frame, rounded up)
  guarantees at least one sample at the full peak whatever the frame phase.
  `provider.test.ts` sweeps the frame phase and asserts exactly this.
- **Decay is an absolute duration, capped against the tempo.** A snare does not
  ring longer because the song is slow, so 260ms is 260ms — but at fast tempos an
  absolute decay would run into the next beat, and an envelope that never
  reaches zero is a glow rather than a pulse. The darkness *between* beats is
  what makes the eye read them as separate events, so `effectiveDecayMs` caps the
  decay at 60% of the beat period.

The quartic fall `(1 − x)⁴` matches VISUALIZER.md's `pow(1 − phase, 4)`: it
spends most of its time near zero and lands on it with zero slope, so the frame
goes dark smoothly instead of switching off.

### 3. Tap-tempo: how many taps, what about an outlier, and phase vs tempo?

**They are two gestures — three, counting nudge — and conflating them makes all
of them worse.**

- **Phase: one tap.** "The beat is *now*" is unambiguous, and the payoff is
  immediate — you tap, the pulse jumps to where you tapped. When the ISRC lookup
  has already succeeded this is the *only* missing piece, and demanding four taps
  for information given in the first one would be rude.
- **Tempo: four taps** (`MIN_TAPS_FOR_BPM`), i.e. three intervals. Two taps give
  one interval, and one interval cannot be checked against anything — a single
  late tap moves the estimate by tens of BPM and nothing can notice. Three
  intervals is the smallest sample with a middle worth trusting, and that middle
  is the only reason a mistimed tap is survivable at all.
- **Nudge: a separate control.** Two buttons that shift the grid by
  `NUDGE_FRACTION` (1/16 of a beat) and never touch the tempo. When the tempo is
  right and the pulse is merely early, re-tapping is the wrong tool — it discards
  a good tempo to fix a 30ms offset. A *fraction* rather than a fixed number of
  milliseconds because a nudge is a musical amount: a sixteenth is a sixteenth at
  any tempo, whereas 30ms is meaningful at 180 BPM and a rounding error at 60.
  A sixteenth also sits above the ~20ms at which a timing change becomes visible,
  so one press does something you can see.

**Estimator: a least-squares line through `(beat number, tap instant)`, not the
average of the intervals.** This is not academic. Averaging intervals telescopes
to `(last − first) / (taps − 1)`, which uses only the two end taps and throws the
middle ones away — eight taps would be no more precise than two. Fitting a line
uses all of them. `tap-tempo.test.ts` asserts the fit beats the endpoints-only
estimate on data where both ends are late and the middle is clean.

**Outliers.** A tap can be wrong in two quite different ways, and they need
different answers:

- A **bounced touch** lands *between* beats. Each tap is placed on a provisional
  grid (the middle interval as the beat length) and any tap sitting more than a
  quarter beat off is dropped before the line is fitted. A quarter beat is the
  natural limit: beyond it, the tap is closer to the neighbouring beat and
  calling it either is a coin toss.
- A **missed beat** is not a fumble at all and is *not* rejected. The tap after
  the gap is a perfectly good observation that simply belongs two beats along,
  and the index assignment puts it there. Discarding it would waste half the
  session; treating the gap as one interval halves the tempo.
- A **restart** — the user stops, thinks, and taps again — is neither. A gap
  longer than `TAP_TIMEOUT_MS` (2s, i.e. slower than 30 BPM) clears the session
  instead of being measured. Left as an outlier it would leave the estimate stuck
  on a tempo nobody is tapping any more. *Reject a bad tap within a gesture;
  start over between gestures.*

Two more numbers with reasons: `TAP_DEBOUNCE_MS` = 60 (1000 BPM — a touchscreen
bounce, or a `pointerdown` beside a synthesised `click`, would otherwise inject a
half-length interval and double the tempo); `MAX_TAPS` = 8, two bars of four —
enough that the average means something, short enough that a shaky start leaves
the window within two bars, and bounded because this runs for hours.

**Convergence** is why the fit averages rather than snapping to the last tap:
every tap is another measurement of the same grid, so each new one moves the
answer less than the one before, and the pulse settles instead of chasing the
jitter in the hand. Tested by perturbing the final tap and asserting the induced
shift shrinks as the session grows.

We deliberately do **not** fold the tapped tempo into a "sensible" octave.
Tapping half-time over a fast track is a legitimate choice and a good look; the
`MIN_TAP_BPM`/`MAX_TAP_BPM` bounds (40–240) exist only to reject nonsense, since
a 20 BPM pulse is indistinguishable from a stuck frame and a 400 BPM one is a
strobe.

### 4. What happens when the track changes?

`trackChanged()` forgets **the tempo, the phase and the taps**, and the provider
drops to Tier 0.

A phase locked to the previous track is worse than no phase at all. It is not
merely useless, it is *confidently wrong* — and a wrong beat is legible in a way
that no beat is not. The eye can tell it is nearly right, keeps trying to lock to
it, and the visualiser spends the whole of the new song insisting on something
false. An unlocked-but-plausible Tier 0 pulse reads as atmosphere and the eye
never tries to lock to it at all. Same reasoning applies to the bar accent: with
a tempo alone, every beat is equally likely to be the downbeat, so **Tier 1 does
not accent anything until a tap has told it where the bar starts.**

Falling back is not a special case in the code — `createTempoProvider` holds a
fallback provider (Tier 0 by default) and `sample()` delegates to it whenever
there is no anchor. So "the BPM lookup missed", "the track just changed" and "the
lookup has not come back yet" are all the same code path, which is the graceful
degradation D-010 exists to provide.

---

## The jitter problem, and why it is solved here rather than upstream

Phase is anchored in **track position**, not wall time: `beats = (position −
offset) / period`. That is what makes a seek behave — the grid belongs to the
recording, so jumping to 2:30 lands on the grid at 2:30 rather than wherever the
clock had got to — and what makes a pause correct, since a paused track has no
beats and the pulse stops rather than carrying on over silence.

But the position arrives jittery. Every poll is stale by a round trip, so
successive anchors describe the same line with ±100ms of noise on it, and at 120
BPM ±100ms is ±20% of a beat. Taken literally the pulse trips once per poll.

`setAnchor` therefore mirrors D-024's rule for the progress bar: a correction
smaller than `ANCHOR_TOLERANCE_MS` (1.5s, the same number for the same reasons)
is poll noise, and the grid moves *with* it so no beat instant moves at all; a
larger one is a real seek and is taken at face value so the grid moves with the
music. Callers should still feed `positionMs` from the interpolated progress
model rather than a raw poll — this is a safety net, not a licence.

## Wiring it up

```ts
const reactivity = createTempoProvider(); // Tier 0 until a BPM arrives
// on each poll, from the smoothed progress model:
reactivity.setAnchor({ bpm, positionMs, atMs: clock.monotonic(), playing });
// on track change:
reactivity.trackChanged();
// from the tap-tempo control:
reactivity.tap(clock.monotonic());
reactivity.nudge(+1); // or -1
// in the render loop:
const frame = reactivity.sample(clock.monotonic());
```

`reactivity.tier`, `reactivity.bpm` and `reactivity.barAligned` are readable for
the UI — "128 BPM" is worth showing, and so is the *absence* of it, since that is
what tells the user a tap would help.

Tapping also works with no lookup at all: four taps with no anchor hang the grid
on the monotonic clock and promote the provider to Tier 1 on their own, so a
track the BPM database has never heard of is still reachable. If a real anchor
arrives afterwards the phase is carried across into track-position coordinates
rather than discarded — the music has not changed, only the coordinate system.

## Notes on VISUALIZER.md

Two things in the document are worth correcting rather than quietly diverging
from:

1. **`uBeat = pow(1 - beatPhase, 4)` ties the decay to the beat period.** As
   written, the envelope is a function of *phase*, so the pulse's decay stretches
   to a one-second sag at 60 BPM and shrinks to 375ms at 160. Percussion decay is
   a property of the instrument, not of the tempo. The envelope here takes
   milliseconds-since-beat and an absolute decay, capped against the period so it
   still goes dark between fast beats. The shape is the document's; the time base
   is not.
2. **The GLSL block has no `uPhase`.** `uTime` and `uBeat` cannot substitute for
   it: `uTime` has no relationship to the beat grid, and `uBeat` is a one-way
   decay, so an effect that wants to sweep *between* beats (the tunnel's advance
   is the obvious one) has to reconstruct the sawtooth from a tempo it does not
   have. It is one float and it is already computed. Worth adding to the uniform
   block when P5-01 lands.

Smaller: the document says Tier 0's `uBeat` "pulses on a slow, honest rhythm".
It does, but not a *constant* one — see the drift argument above. A constant
procedural pulse is the screensaver failure, and the honesty is in not claiming
the rhythm is the track's, not in refusing to make it musical.
