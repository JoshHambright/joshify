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

---

### D-014 · A scene stage before the post chain
**Chose:** Insert a **scene** stage ahead of the post-processing chain. Scenes
render geometry (`flat` = album quad, `tunnel` = PS1 tube); the post chain then
composes over whatever the scene drew.
**Why:** The tunnel needs 3D geometry and a vertex shader, so it cannot be a
preset in a 2D post-process pipeline. Adding the stage is small, and every
existing effect keeps working *and* gains the new scenes for free — the tunnel
can be datamoshed, pixel-sorted or VHS-warped like anything else.
**Costs:** One more stage to manage, and scenes need their own uniform plumbing
(they read the same reactivity block, D-010).
**Status:** ✅ Accepted. See [PS1_MODE.md](./PS1_MODE.md).

---

### D-015 · PS1 / N2O as a first-class visual mode — homage, not reproduction
**Chose:** Treat the late-90s console aesthetic as a real design direction across
both the visualiser and the app chrome, built from **original** assets.
**Why:** Winamp 2 (1998), N2O (1998) and Milkdrop (2001) are one cultural moment,
not two aesthetics being combined. Building the visualiser and the interface from
the same year is what makes the object feel authored rather than themed. The six
PS1 rendering artefacts are real hardware behaviours and all reproducible in GLSL
— verified in [`spikes/n2o-tunnel/`](../spikes/n2o-tunnel/).
**The guardrail:** the *idiom* is fair game; specific assets are not. No
reproduction of Sony's boot animation, diamond logo or wordmark, and no N2O
assets — these are trademarked. Original work in the era's style only.
**Scope extended** by the theme roster ([THEMES.md](./THEMES.md)) to every
reference we draw on: the Windows logo/flag/wordmark and Win95/3.1 UI bitmaps,
the Surge wordmark, Pizza Hut and BOOK IT! branding, Ms. Frizzle, Carmen
Sandiego, and any MECC/Broderbund/Maxis art asset. Also: **no theme may be named
after a trademark** — `PLUS!` and `SURGE` are working titles and must be renamed
before any public release.
**Costs:** None creatively. It needs stating so we don't drift into it.
**Status:** ✅ Accepted.

---

### D-016 · Visual decisions get a published page before they get a commit
**Chose:** Prototype anything visual as a published Artifact page for review
first; only the approved version becomes a task and lands in the repo. Spike
source is committed under `spikes/` so it outlives the container.
**Why:** Joshify's target *is* a browser, so a published page runs the same
GLSL and CSS the Pi will. A prototype is not a mockup of the thing — it is the
thing, on different hardware. It also kills the worst failure mode here: building
a whole visual system that turns out to feel wrong on the real device.
**Costs:** A round trip before building. Cheap, and it has already paid for
itself once (the tunnel spike surfaced D-014 before any engine code existed).
**Status:** ✅ Accepted. Workflow recorded in `CLAUDE.md`.

---

### D-017 · A theme skins the whole interface, not just the visualiser
**Chose:** A theme bundles **palette + scene + effect chain + UI chrome +
transition behaviour**, switched as one unit. Expands D-012 beyond effect chains.
**Why:** **Microsoft Plus! for Windows 95** (1995) shipped 12 desktop themes that
each changed wallpaper, colours, icons, cursors, fonts and sounds *together* — it
skinned the whole machine, not one app. That is a better model for Joshify than
Winamp skins, which only ever skinned the player. It's also the honest way to use
a wide set of 90s references: kept separate and named they're a roster, blended
they're pastiche.
Related: our auto-enter-on-idle visualiser mode *is* a screensaver, which makes
the Plus!-era ambient screensavers a direct functional ancestor rather than a
borrowed reference.
**Costs:** Themes now need to reach UI components, not just the shader chain — so
chrome must be tokenised from the start rather than hard-coded. Cheaper to do at
Phase 3 than to retrofit.
**Status:** ✅ Accepted. Roster in [THEMES.md](./THEMES.md).

---

### D-018 · The visualiser needs a calm mode, and it is a first-class one
**Chose:** `REEF` — an ambient underwater scene (caustics, god rays, drifting
silhouettes) built as a peer of `N2O`, not an afterthought.
**Why:** `N2O` is a strobing tunnel at speed. That's right for loud music in the
evening and *wrong* for an always-on object playing something quiet at 11pm —
which is a large share of what this device actually does. Shipping only an
aggressive mode would make the visualiser something you switch off, and a
visualiser you switch off has failed.
The 90s dolphin reference arrives at the same answer from the other direction, so
the period vocabulary and the product requirement agree.
**Costs:** A second scene to build and tune. Sequenced second, after `VGA`.
**Status:** ✅ Accepted. See [THEMES.md](./THEMES.md).

---

### D-019 · The theme roster is a backlog; Phases 1–4 are the product
**Chose:** Schedule four themes (`N2O`, `VGA`, `REEF`, `PLUS!`) and hold the rest
as a specified backlog outside the tracker. New visual ideas go to the backlog by
default.
**Why:** Phase 5 grew from 17 tasks to 41 across three conversations while zero
production code existed. Each addition was individually defensible and the
aggregate was drift. Joshify is a **touchscreen Spotify remote**; the visualiser
is one phase of nine, and Phases 1–4 are what make the device worth owning at all.
**The test** for promoting anything out of the backlog: does it close a gap in the
*product*, or only in the reference list? `REEF` passed it (there was no calm
mode). Autostereograms failed it and were cut.
**Costs:** Some good ideas sit unbuilt. That's the point.
**Status:** ✅ Accepted.

---

### D-020 · `Result` ships without combinators until P1-09
**Chose:** `packages/core` exports `Result`, `ok`, `err`, `isOk`, `isErr` — and
deliberately no `map` / `mapErr` / `andThen`.
**Why:** A first pass included them and they were **unsound in ordinary use**.
TypeScript narrows a variable by its assignment, so `const r: Result<number,
string> = err('boom')` has the flow type `Err<string>` at every use site despite
its declared type. A combinator inferring both `T` and `E` from that argument
only ever sees one branch; the other parameter silently resolves to `unknown`,
and so does the callback argument. `strictTypeChecked` caught it on its first
run — which is exactly what Phase 0 exists to do.
Fixing it properly means threading both parameters through both branches
(phantom typing). That is real library design and wants real requirements;
P1-09's error taxonomy provides them. The type guards have no such problem:
they take the union and narrow it, inferring nothing from a callback.
**Costs:** Slightly more verbose call sites until P1-09.
**Status:** ✅ Accepted.

---

### D-021 · Token store: local key, atomic writes, and what corruption means
**Chose:** Persist the token set as AES-256-GCM ciphertext with the key in a
`0600` file beside it, written write-temp → `fsync` → `rename` → `fsync` the
directory.
**Why:** The Pi boots unattended, so the key must be fetchable with no human
present — which rules out a passphrase and means the key lives on the device.
The guarantee is therefore narrow and worth stating rather than overselling: it
protects a token that travels *without* the device (a pulled SD card, an rsync
backup, a support bundle, a `cp -r`), because either file alone is worthless.
It does **not** protect against root on the running device. Nothing storable on
an unattended machine can — a device that decrypts with nobody present hands
that ability to whoever becomes the device. A TPM would move the key, not solve
it. The blast radius is bounded by Spotify anyway: playback control on one
account, revocable from the account page.
**Three consequences worth naming:**
1. **Corruption maps to `auth`, filesystem faults map to `unexpected`.** Anything
   that makes the stored token unrecoverable — tampering, GCM tag mismatch, a
   missing key, a well-sealed payload of the wrong shape — leaves the device
   exactly where a revoked token does, with one remedy: re-authorise. Genuine
   I/O faults (`EACCES`, disk full) deliberately do *not*, because presenting
   those as "log in again" sends the kiosk round a loop that cannot fix
   anything. This widens `'auth'` beyond "Spotify said 401", so the kind's
   documentation now says so.
2. **`clear()` deletes the key as well as the ciphertext.** Otherwise signing
   out leaves every historical backup of the token file decryptable by a key
   still sitting on the device. Dropping it costs nothing — the next save mints
   another — and retires the whole history at once.
3. **The key file is created with `O_EXCL`, not via the rename path.** Two
   processes starting together must not install *different* keys: the loser of
   a rename race would already have sealed a token file the winner cannot open.
   Exclusive creation makes creation itself the race, and the loser adopts the
   winner's key. A malformed-but-present key is reported, never replaced, for
   the same reason.
**Status:** ✅ Accepted.

---

### D-022 · Playback normalisation models absence rather than defaulting it
**Chose:** In `PlaybackState`, `volumePercent` and `PlayingItem.id` are nullable
rather than falling back to `0` / `''`. An `Err` is reserved for a payload that
is not recognisably a player response at all; null item, null device, null
volume and null progress are ordinary states with something sensible to draw.
**Why:** Defaulting volume to `0` would draw a muted slider for a device playing
at full volume — a confident lie is worse than an absent control. And an `Err`
puts a fault on screen, so it must mean "something is wrong", not "nothing is
playing". A boolean `is_playing` is the discriminator for a genuine player
payload, so `{}`, an array or an error body is rejected rather than becoming a
plausible-looking idle state.
**The one exception, recorded because it is an exception:** `progressMs`
collapses `null` to `0`. A device that is starting up, or between items, reports
null progress, and `0` is both the only honest render and the natural starting
point for the P2-04 interpolator.
**Status:** ✅ Accepted.

---

### D-023 · Elapsed time is measured only with a monotonic clock
**Chose:** `Clock` exposes wall-clock and monotonic readings separately. Anything
measuring *elapsed* time — progress interpolation, poll scheduling, refresh
timing — uses `monotonic()`; wall-clock is for display only, and the two origins
are never mixed.
**Why:** The **Pi 5 has no real-time clock**. It boots believing an arbitrary
time and steps by potentially years on first network contact. A progress bar
driven by wall-clock would jump wildly at that moment, and an NTP correction
would do the same more subtly forever after. A monotonic source cannot go
backwards, which is exactly the property elapsed-time measurement needs.
**Status:** ✅ Accepted.

---

### D-024 · A stale poll does not rewind the progress bar
**Chose:** When a poll reports a position *behind* the interpolated one for the
same item, keep the interpolated position and re-anchor from it. Only a gap
wider than `rewindToleranceMs` (1500 ms) is taken at face value.
**Why:** Every poll is stale by a network round trip, so a small backwards
discrepancy is the normal case, not an anomaly. Snapping to it makes the bar
twitch backwards on *every* poll — which reads as a bug even though the data is
technically correct. Holding the interpolated value keeps a bounded,
self-correcting error: real time catches up to it within a second, whereas a
visible rewind is something the eye cannot un-see.
The tolerance is chosen to sit above a slow round trip plus Spotify's coarse
position reporting, and below any seek a human would actually perform — beyond
it, the change is a real seek or a repeat-one restart, and refusing it would
leave the bar lying instead.
**Also:** item identity is `id ?? uri ?? local:<title>:<durationMs>`. Local files
have neither id nor uri, so without the fallback every poll of one would look
like a new track and reset the bar.
**Status:** ✅ Accepted.

---

### D-025 · Poll cadence is sized against the rate limit, not against feel
**Chose:** ~3s playing mid-track, ~1s inside the last 10s of a track, ~5s idle,
a 400ms burst for ~1.5s after a user command, and a hard 250ms floor.
**Why:** Picking intervals by what feels responsive in isolation produces a
device that is quietly hostile to the rate limit over a day of use. Sized as a
budget instead: mid-track is 20 req/min, the boundary window adds ~10 per track,
and idle — the cadence that runs unattended for hours — is the slowest.
The track boundary gets the fast cadence because it is the one moment state
changes *on its own*, so lag there is the most visible failure. The
after-command burst exists because a Connect device does not apply a command the
instant the write returns 204; a single poll is not reliably enough to confirm
an optimistic update (P2-05).
The floor is a safety rail: a bug upstream must not be able to turn this into a
request flood.
**Status:** ✅ Accepted.

---

### D-026 · Spotify's player write API, and where it silently misbehaves
**Recorded because these are the kind of details that cost an afternoon twice.**
- **`next` and `previous` are `POST`; every other transport command is `PUT`.**
  There is no pattern to it. The fake now returns `405` on the wrong verb rather
  than accepting anything, so a mistake fails in a test instead of on a device.
- **Transfer is the only write that does not take `device_id` in the query.** The
  target goes in the body as `device_ids`, a plural array that only ever accepts
  one id. Omitting `play` means "keep the current playing/paused state"; sending
  `false` would pause a device the user just moved music *onto*, so it is sent
  only when explicitly given.
- **Spotify ignores unrecognised query parameters rather than rejecting them.**
  A typo'd `device_id` therefore runs the command on whatever device happens to
  be active — silently, and correctly as far as the API is concerned. Tests
  assert exact query strings for this reason; it is the one bug class here that
  no amount of type-checking catches.
- **Out-of-range values return a generic "Player command failed" with no field
  name**, which is why volume and seek bounds are validated locally: we can say
  which value was wrong and Spotify cannot.
**Status:** ✅ Recorded.

---

### D-027 · Pure-JS image decoding (`jimp`), not `sharp`
**Chose:** `jimp` for decoding artwork, extracting colours, and pre-rendering the
blurred backdrop. Resolves open question Q6.
**Why:** The instinct is `sharp`, which is much faster. But the speed is
irrelevant here — **we only ever decode the 64px album art variant** (PRODUCT.md
§8.1), which is 4,096 pixels. Both libraries are instant at that size.
What differs is the install. `sharp` is a native libvips binding, so the Pi needs
a working ARM64 prebuild or a toolchain to compile one, and that is exactly the
kind of failure that turns a one-line install into an afternoon (Phase 8's whole
point is that a stranger can install this in under 30 minutes). A pure-JS
decoder has no build step and cannot fail that way.
This is a case where the slower library is the right one because the
performance difference is below the threshold where anyone could notice, and the
install difference is not.
**Costs:** If we ever process full-size artwork, this decision needs revisiting.
Nothing currently does, and doing so would contradict §8.1's reason for fetching
the small variant in the first place.
**Verified:** decode → pixel read → resize → blur → re-encode all confirmed
working on Node 22 ESM before adopting.
**Status:** ✅ Accepted.

---

### D-028 · Optimistic updates reconcile on two axes, not one
**Chose:** A pending optimistic change survives a poll only if it is **inside a
settle window** *and* **the poll reports exactly the value it replaced**.
Anything else clears it.
**Why:** Time alone is not enough. A Connect device does not obey the instant a
write returns `204`, so a poll arriving milliseconds later legitimately still
shows the old value — reverting there makes the button visibly bounce back. But
waiting out a fixed window would also ignore a *genuine* change made from
another device for that whole window.
The second axis resolves it. A poll returning the value we were replacing is
consistent with a write still in flight. A poll returning a **third value** —
one we never set and were not replacing — cannot be, whatever the clock says,
so it is adopted immediately. That catches another phone pausing us in one poll
instead of one whole window.
**Two refinements that are easy to get wrong:**
- **The baseline is the on-screen value at apply time, not the last polled
  truth.** With a pause in flight and play tapped after it, a poll saying
  "paused" is the pause *landing*, not the play failing. Using polled truth as
  the baseline would silently drop the play.
- **Seek compares moving targets.** Both the requested and replaced positions
  drift while playback runs, so each is compared against where it *would* have
  reached by now. A pending seek is also invalidated outright by an item change,
  which is stronger evidence than either value comparison.
**next / previous:** the *item* is never guessed — the queue is a separate
request, shuffle makes it non-deterministic, and repeat-one makes it the current
track, so drawing a guessed title that a poll then replaces is worse than
drawing the truth a moment late. The *position* is knowable, though: whatever
arrives starts at zero, so the bar snaps instantly while only the item lags.
**Status:** ✅ Accepted.

---

### D-029 · Item identity is shared code because it is a contract
**Chose:** `playingItemKey` lives in one module, imported by both the progress
tracker and the optimistic layer.
**Why:** It arrived as a byte-identical copy in each. Normally two small copies
are cheaper than an abstraction, but these two must **agree**: the tracker resets
its anchor on a track change and the optimistic layer invalidates a pending seek
on the same signal. If someone later adds a podcast case to one copy, the two
modules would disagree about whether the same poll represents a track change,
producing a bar that resets while a seek survives — a miserable bug to chase
from the symptom.
Shared because correctness depends on it, not because duplication is untidy.
**Status:** ✅ Accepted.

---

### D-030 · Spotify overloads 404, so the caller says what it means
**Chose:** `classifyHttpFailure` defaults a 404 to a new `not-found` kind. The
Spotify client passes `notFoundMeans: 'no-active-device'` only for paths under
`/v1/me/player`.
**Why:** The taxonomy originally mapped *every* 404 to `no-active-device`, which
was correct while player endpoints were the only ones that existed. Adding
search and library made it wrong in a way that would have been visible to the
user rather than to us: **a deleted playlist would have put "choose a speaker"
on screen.**
Surfaced by the library work, which had to guard its own call sites against it.
That guard was the right local move but the wrong place for the fix — every
future endpoint would have needed the same workaround.
The default is deliberately the honest one. A new endpoint added later fails as
"not found" without anyone remembering to opt in, which is the failure mode that
degrades gracefully.
**Status:** ✅ Accepted.

---

### D-031 · A malformed row is dropped; a malformed envelope is an error
**Chose:** In library and search results, an unreadable *row* is skipped and the
rest of the page renders. An unreadable *page envelope* is an `Err`.
**Why:** Spotify genuinely ships `null` entries inside `search.playlists.items`,
and a track removed from a playlist arrives as `{ track: null }`. Failing the
whole page because one row is junk would mean a single deleted track blanks an
entire playlist. But an envelope we cannot parse means we do not know what we
received at all, and rendering an empty list would claim the library is empty.
This is a deliberate departure from D-022, where a malformed playback payload is
always an error — there, there is no "rest of the page" to salvage.
**The consequence that is easy to miss:** paging must advance by the number of
rows **Spotify sent**, not the number we kept. Paging by the filtered count
silently skips a real album on every page that contained a dud row.
**Status:** ✅ Accepted.

---

### D-032 · Stale search results are fenced, not aborted
**Chose:** Every search bumps a generation counter; a response is discarded if
its generation is no longer current. Checked **after** the await, not before.
Being superseded is reported in the *success* channel, not as an error.
**Why:** An on-screen keyboard fires a request per keystroke, and a slow answer
for "bea" must never replace a fast answer for "beatles". A pre-flight check
proves nothing — a response that lost the race is by definition one that has
already come back — so the fence has to be on the return path.
Stale *failures* are swallowed the same way: a 429 for "bea" must not replace a
good "beatles" list with an error screen.
Not `AbortSignal`, because our client treats an aborted fetch as a retryable
network failure — aborting would free a socket and pay for two pointless retries
with real sleeps. And superseded is a success because being typed over is the
normal outcome of a keystroke, not a fault worth flashing at anyone.
**Status:** ✅ Accepted.

---

### D-033 · Versioned diffs, snapshot-only recovery, no replay buffer
**Chose:** The socket sends `snapshot` / `diff` / `heartbeat`. Each diff carries
both its own `version` and the `from` version it was computed against. A single
`applyServerMessage` is the only merge path and returns a `Result`, so a
mismatch surfaces as an error rather than a silently-wrong state. Recovery is
always a fresh snapshot; no diff history is kept.
**Why:** Most ticks change only `progressMs`, so re-sending artwork URLs, track
metadata and the device list several times a second is waste on a device we are
trying to keep responsive.
The correctness risk is a client merging a diff into a state it no longer
matches. Carrying `from` explicitly — rather than assuming `version - 1` — means
the client checks something it was *given*. Making the merge the only path means
it cannot forget to check. And a snapshot is sent **synchronously inside
`subscribe()`**, before it returns, so no publish can race a diff onto a socket
that has not yet seen a snapshot.
No replay buffer, deliberately: the state is small, so buffering saves one
snapshot per reconnect and costs a second correctness path that would need its
own tests and could itself go stale.
**Two details worth keeping:** an unchanged tick sends **nothing** and does not
advance the version — the poll cadence is the server's private business, and
silence tells the client exactly what an empty frame would. Liveness is answered
separately by a heartbeat carrying the current version, so a client that missed
a diff learns within one interval rather than at the next state change, which on
a paused player may be never.
**Also:** command routes answer `202`, not `200`. Spotify accepted the command;
the truth arrives on the socket, and the UI should already be showing its
optimistic update (D-028) rather than waiting on this response.
**Status:** ✅ Accepted.

---

### D-034 · Defence in depth for a device sitting on a home LAN
**Chose:** Bind `127.0.0.1` by default, **and** validate the `Host` header,
**and** accept only JSON bodies.
**Why:** This is an appliance holding a Spotify token on a network with whatever
else is on it. Each layer stops something the others do not:
- **Loopback binding** stops anything on the LAN connecting directly.
- **The `Host` check** stops **DNS rebinding**, which loopback binding does not:
  a hostile page can resolve its own domain to `127.0.0.1` and reach a
  loopback-bound server from the victim's own browser. Checking that the request
  asked for a host we actually serve breaks that.
- **JSON-only bodies** stop a plain cross-origin form POST. A hostile page can
  submit a form to any origin without a CORS preflight, but it cannot send
  `application/json` without one — so requiring JSON forces a preflight the
  browser will refuse.
Each is cheap; the combination is what makes the surface uninteresting.
**Status:** ✅ Accepted.

---

### D-035 · Contrast floors: 4.5:1 for anything that can carry text, 3:1 for chrome
**Chose:** `foreground`, `accent` and `onAccent` are corrected to **4.5:1**
(WCAG 1.4.3 AA). `controlTint`, which is non-text chrome, is held to **3:1**
(WCAG 1.4.11). Correction preserves hue and saturation and moves only lightness,
binary-searching over **quantised 8-bit steps** in both directions.
**Why 4.5 for the accent specifically:** it lands on the artist line and the
progress readout, so a token safe as a *fill* but not as *text* is a trap laid
for whoever writes the next component. Holding it to text level costs nothing
and removes the trap.
**Why not AAA (7:1):** it is **not reachable against every background** — a
mid-grey around 0.18 luminance caps out near 4.58:1 against pure white or black.
Promising AAA would be a guarantee the code cannot always keep. 4.5 is always
reachable, which is exactly what makes "text stays readable on every album, no
exceptions" a true statement rather than an aspiration.
**Why quantised steps:** searching over floats can settle on a ratio that rounds
*under* the threshold once written as an 8-bit colour. Measuring the colour that
actually ships means the guarantee survives the last step.
**Status:** ✅ Accepted.

---

### D-036 · Accent is the most salient colour, not the most common
**Chose:** Accent scores `sqrt(population) × saturation × a mid-lightness curve`
over coarse colour buckets. Population enters as a **square root**, so a colour
must be about four times as common to beat one twice as vivid.
**Why:** Dominance picks the background. A small hot-pink logo on a 90% grey
card is what a person would call the album's colour, and dominance would return
the grey. The saturation floor makes a genuinely greyscale cover degrade to "the
most common grey" rather than a hallucinated hue, and the lightness curve
suppresses near-black and near-white — which survive contrast correction, but
only by discarding the album entirely.
**The surface is always dark**, whatever the cover: the artwork's mean colour
with saturation capped and lightness forced low. Two reasons. Every token would
otherwise flip polarity between a white sleeve and a black one, and — more
practically — a white cover would turn a shelf appliance into a lamp at 2am.
Reasonable people would tune this differently; it is written down so it is
settled rather than re-argued per album.
**Status:** ✅ Accepted.

---

### D-037 · The artwork pipeline never fails, and never lies about images
**Chose:** `prepareArtwork` always returns a usable theme. A dead CDN or an
undecodable JPEG degrades to the default theme, with causes collected for the
log and never for the screen.
**Why:** Artwork is decoration. A device that shows an error where the album art
should be, because a CDN hiccuped, is worse than one that shows a plain
background and keeps playing.
**Three things it refuses, which are not degradation but safety:** a non-`image/*`
200 response (a captive portal answering everything with HTML), an oversized
body, and a non-`http(s)` URL — a `file:` URL would otherwise turn the artwork
cache into an arbitrary-file reader.
**Image CDN failures get their own error mapping**, not `classifyHttpFailure`:
a 404 from `i.scdn.co` means the artwork URL expired, and routing it through the
player taxonomy would have said "no active device" (see D-030 — the same
overload, caught twice).
**Cache:** writes are buffered fully then temp-file → `fsync` → `rename`, the
token-store pattern, so a dropped connection cannot leave a truncated image.
Eviction is true LRU (400 entries / 32MB, pruned on write), because this runs
for months on a device with a finite SD card.
**Status:** ✅ Accepted.

---

### D-038 · The device is an instrument, not a picture frame
**Chose:** Visible, characterful, always-present chrome. The album art sits
*inside* the instrument rather than behind floating controls.
**Why:** We had written down two opposed philosophies and never noticed.
PRODUCT.md §5.3 said *"The art is the interface. Chrome recedes."* while
THEMES.md and PS1_MODE.md described bevelled chrome, persistent readouts, and
the PS1 BIOS CD player as a reference. Every styling decision downstream depends
on which we meant.
The instrument reading is the one consistent with everything else already
decided — the 1997–2001 idiom, the Plus!-style whole-interface theming (D-017),
the visualiser as a *mode* rather than the resting state. A picture frame that
hides its controls would make all of that decoration on something that wants to
be plain.
It also suits the object. This is a dedicated appliance on a shelf, not a phone
app: it has one job, it is always on, and equipment that shows its state is more
useful at a glance than equipment that hides it until touched.
**Consequence:** §5.3's first principle has been rewritten rather than quietly
ignored. Anything that assumed receding chrome needs re-reading.
**Status:** ✅ Accepted.

---

### D-039 · Design to a fixed fullscreen panel, with no scrolling on Now Playing
**Chose:** Treat the display as a fixed, edge-to-edge viewport. No window chrome,
no scrollbars, nothing that reads as "a web page in a browser". Now Playing must
fit the panel exactly at every state.
**Why:** It is a kiosk. There is no address bar to scroll away from and no
second screenful to reach — a layout that overflows is simply broken, not merely
inconvenient. Designing to a known viewport also removes a whole class of
responsive guesswork, which is worth the loss of flexibility on a device whose
screen never changes.
**The panel:** the Raspberry Pi Touch Display 2 is **720 × 1280 — natively
portrait**, 7 inches, five-point capacitive touch. Orientation is therefore a
real decision rather than an assumption: landscape needs a rotation in config,
while portrait gives a full-width square album cover with the controls stacked
beneath it, which is close to a record sleeve standing up. Being settled by
prototype rather than argument.
**Orientation: portrait.** Settled by prototype (D-040). The panel's native
720×1280 needs no rotation, and a portrait screen gives the album far more of
the device than a landscape one can.
**Status:** ✅ Accepted.

---

### D-040 · A glass plate over full-bleed art, in portrait
**Chose:** The album fills the entire panel. One translucent, blurred plate
floats over the lower portion carrying the controls. Portrait 720×1280.
**Why the first attempt failed:** it was art-left, text-right, five identical
buttons in a row — the stock media player layout. The bevels were finish applied
to a generic skeleton, which is exactly why they did not rescue it. The
structure was the problem.
**Why this fixes legibility, not just looks:** text over unpredictable album art
**cannot** be made reliably readable by choosing colours — some cover always
defeats you. The plate is a *known* surface, so the 4.5:1 guarantee (D-035) is
computed against something we control and actually holds. The two complaints —
"hard to read" and "looks generic" — had one shared cause and one shared fix.
**Hierarchy over uniformity:** play is a large accent disc, skip is a bare glyph
with no box, shuffle and repeat stay quiet until active. Five equal-weight keys
give the eye nothing to land on, which was doing more damage than the palette.
**Portrait** because the panel is natively 720×1280 — no rotation to configure —
and because a portrait screen gives the album substantially more of the device.
**Consequence:** the chips (volume, queue, visualiser) are hidden in portrait for
want of width. They need a home; SCREENS.md assigns one.
**Status:** ✅ Accepted.

---

### D-041 · `backdrop-filter` is back on the menu — D-004 relaxed again
**Chose:** Use real `backdrop-filter` for the control plate, with a solid-tint
fallback behind `@supports`.
**Why:** D-004 ruled it out because VideoCore IV on the Zero 2 W could not
accelerate it. D-008 moved us to a Pi 5, whose VideoCore VII runs it properly,
and D-004 was relaxed at the time without anything actually taking advantage.
The plate is where it earns itself: a blurred translucent surface over live
artwork is precisely the effect a pre-rendered blur cannot fake, because what it
blurs changes with what is behind it.
The pre-rendered backdrop (P3-05) is *not* redundant — it remains the right tool
for the full-screen ambient wash, where the source is static per track.
**Worth noting as a pattern:** a hardware decision made for one reason (the
visualiser needed GLES 3.1) quietly unlocked a design option we had written off
for another. Re-reading old constraints after a platform change is worth doing
deliberately rather than by accident.
**Status:** ✅ Accepted.

---

### D-042 · The engine owns no timers
**Chose:** `createPlaybackEngine` takes both its clock and its *scheduler* as
injected dependencies. The default `realScheduler` is a two-line `setTimeout`
wrapper; tests pass a scheduler they drive by hand.
**Why:** P2-01 through P2-09 built the parts — poll cadence, normaliser,
optimistic layer, broadcaster — but nothing composed them into a running loop,
and a loop is where the timing bugs live. Injecting the clock alone is not
enough: the code under test still *waits*, so the after-command burst and the
track-boundary tightening are only observable by sitting through them. With the
scheduler injected too, a test asserts the next delay as a value. The full
24-test suite runs in about 400ms and touches one real timer, in the one test
that exists to cover `realScheduler`.
**Also settled here:** a command publishes optimistically **and re-arms the poll**
before awaiting the network. Re-arming matters as much as publishing — without
it the confirming burst waits out whatever long idle delay was already pending,
and the optimistic value sits unconfirmed for seconds.
**And:** a failed poll — network blip or a payload that will not normalise —
reports the problem and keeps the last known state on screen. Blanking the
display is never the right answer to a dropped packet.
**Status:** ✅ Accepted.

---

### D-043 · The UI's shared state is a hand-written store, not a rune
**Chose:** `connection.ts` and `commands.ts` are plain TypeScript modules with
their dependencies — socket, scheduler, `fetch` — injected. `connection`
implements the Svelte store contract by hand, so `$connection` still works in a
template.
**Why:** the reconnect ladder and the command envelopes are the two places this
UI can be wrong in a way nobody notices until the device is on a wall. A rune
can only be exercised inside a mounted component, which means every assertion
about backoff timing would be made through a DOM and a scheduler we do not
control. As plain modules they are 54 tests in Node with a fake socket and a
fake `fetch`, and the one thing worth asserting — the exact body each command
sends — is asserted directly instead of through a round trip.
**The cost is honest:** we write `subscribe` ourselves rather than getting it
free. It is about twelve lines, and it buys the ability to drive the whole
client state machine from a test.
**Status:** ✅ Accepted.

**Consequence worth keeping:** the default test environment is Node, and a
component test opts into jsdom explicitly. That makes "does this logic touch
the DOM?" a question the test suite answers rather than one we have to
remember.

---

### D-044 · Shared contracts live in core, even when only one side derives them
**Chose:** the wire protocol and the theme *token contract* both moved from
`apps/server` into `packages/core`. The derivation stays where it was — the
server still owns diffing and colour extraction.
**Why:** `protocol.ts` opened by arguing that both halves of a contract must
live together or they drift, and then sat in a package the UI cannot import.
The theme was heading the same way. The alternative in both cases was a second
copy on the browser side, which is exactly the drift the original comment warns
about.
**The line:** a *contract* is shared; a *derivation* is not. `themeCssVariables`
is in core because it names the CSS properties both ends agree on;
`extractTheme` stays on the server because it needs pixels and an image decoder
the browser bundle should never carry.
**Status:** ✅ Accepted.

---

### D-045 · Artwork is keyed on the image, not on the track
**Chose:** the hero's crossfade restarts when the artwork *URL* changes, not
when the playing item changes. The incoming image is held at `opacity: 0` until
both its `load` event and its `decode()` have settled.
**Why (the key):** two tracks from the same album share a cover. Keying on the
track would crossfade an image into an identical copy of itself on every track
change within an album — 420ms in which the panel visibly does nothing, plus a
decode nobody asked for. The URL is the thing that actually changed.
**Why (the decode gate):** `load` promises bytes have arrived; `decode` promises
they have become pixels. On a Pi the gap between the two is a real hitch, and
swapping on `load` alone produces a flash of empty surface on every track
change — the exact artefact a crossfade exists to prevent.
**And a failure rule:** an image that errors, or a `decode()` that rejects,
clears to the flat surface rather than leaving the previous album on screen.
Holding the last cover under a track that has none is the prettier failure and
the dishonest one.
**Status:** ✅ Accepted.

---

### D-046 · Two components run the same progress model, rather than sharing a value
**Chose:** `Transport` and `Scrubber` each construct the same pure progress
model over the same `PlaybackState`. Neither passes an interpolated position to
the other.
**Why:** a podcast's ±15s must step from where the bar *is*, not from the
polled position, which can be three seconds stale (D-025). The obvious fix is
to lift the interpolated value into a parent and pass it down — and that makes
two components capable of disagreeing about the same instant. Running one
deterministic model over one input means they cannot: given identical state and
identical clock readings they compute identical answers.
**The cost:** two model instances instead of one. They hold nothing but a
couple of numbers, and only the scrubber's ever has a finger on it — the
transport runs no frame loop at all, and reads the model at the instant of the
tap.
**Status:** ✅ Accepted.

---

### D-047 · A control that cannot do anything is not drawn
**Chose:** three cases, one rule. A device reporting `volumePercent: null`
gets no slider. The *active* device gets no transfer button. A restricted
device (`id: null`) stays in the list but is dimmed and untappable.
**Why:** this is D-007's queue-reorder principle applied past the queue. An
affordance that cannot work is worse than a missing one — it invites a tap,
does nothing, and teaches the viewer that the panel is broken. Drawing a slider
at 0 for a TV playing at full volume is the same lie in a different costume
(D-022).
**Why a restricted device is still listed:** the alternative is a viewer
hunting for a speaker Spotify can see and Joshify apparently cannot. Showing it
as present-but-unavailable is true; omitting it is not.
**A fourth case, deliberately the other way:** the transport stays enabled when
there is no active device. That is answered by the plate's *Choose a device*
(P4-02), not by dead buttons — the action exists, it just needs a target first.
**Status:** ✅ Accepted.

---

### D-048 · Offline shows no notice while a last known state exists
**Chose:** `noticeFor` returns `null` when the link is down but the panel holds
a state. The amber lamp in the status rail is the entire signal. The offline
notice appears only for a panel that has never held a state at all.
**Why:** SCREENS.md's rule is "never a spinner where last-known truth exists",
and a banner over a working screen is the same mistake wearing different
clothes — it covers a correct album, title and artist to announce something the
lamp already says in ten pixels. On a wall-mounted screen the failure mode that
matters is *not knowing the panel is stale*, and one always-present lamp solves
that without ever obscuring the thing people are looking at.
**Status:** ✅ Accepted.

---

### D-049 · The device list polls only while its screen is open
**Chose:** `device-source.ts` is a separate poll from the playback socket, at a
deliberately slow 5s, running only between `open()` and `close()` — and a
transfer calls `refresh()` rather than waiting out the interval.
**Why not on the socket:** the device list is not playback truth. It changes
when someone else's phone joins the network, not when a track ends. Pushing it
down the same channel would make every poll of one a diff of the other, for a
list nobody is looking at.
**Why only while open:** a wall panel sits on Now Playing for hours. A fresh
device list is worth nothing there, and the requests come out of the same
budget the transport commands need (D-025). The screen is open for seconds at a
time, which is exactly when the list matters.
**Why 5s and not faster:** a speaker that appears five seconds after someone
plugs it in is fine. A request per second for three rows is not.
**And a failure rule, matching the socket's:** a failed refresh keeps the rows
it has. Emptying a list somebody is looking at, to report that we could not
confirm it, is the same mistake as blanking the album on a dropped packet.
**Status:** ✅ Accepted.

---

### D-050 · The theme rides on the state, and is allowed to lag the track
**Chose:** a new `PanelState` in core — `PlaybackState` plus `theme`,
`themeFor` and `isPremium` — is what the socket carries. The engine publishes
the track immediately and publishes again when extraction lands, a few hundred
milliseconds later. The UI holds the *previous* album's colour across that gap.
**Why a separate type:** `PlaybackState` is our model of Spotify's player, and
a field in it should mean "Spotify reported this". The album's colour is
computed here, from an image, after the fact. Folding it in would make the
normaliser's output depend on a disk cache and an image decoder.
**Why flat, not nested:** `{ playback, presentation }` reads better and costs
more. The diff protocol replaces whole keys, so a nested shape would resend the
entire playback object on every one-second progress tick to change one number.
Flat keeps each field its own key. It also means `PanelState` structurally *is*
a `PlaybackState`, so every component that only wants playback keeps its
existing type and never learns presentation exists.
**Why the poll does not await it:** making the title and the progress bar wait
behind a disk read and a decode, in order to deliver a colour, is exactly
backwards. Nothing in the poll path awaits extraction.
**Why `themeFor`:** it records which item the colour belongs to. That is what
lets the UI keep showing the last album's accent for the few hundred
milliseconds before the new one is ready, instead of snapping to neutral grey
and back — a visible flicker on every single track change. Same family of
decision as holding the outgoing artwork until the incoming one has decoded
(D-045).
**And the fence:** an extraction that finishes after the track has moved on is
discarded. Without it, a slow decode repaints whatever is playing *now* in the
colour of whatever prompted the request — D-032's rule, in a different place.
**`isPremium` is three-valued.** `null` means we have not asked. Only a
definite answer moves it off null; a failed profile read leaves the account
unclassified, because accusing an account of being free before we know is the
confident lie D-022 exists to prevent.
**Status:** ✅ Accepted.

---

### D-051 · The queue is view-only, and says so
**Chose:** every queue row is inert — no button, no `:active`, no press
feedback — with one line under the list explaining why.
**Why:** D-007 established that Spotify has no reorder and no remove. Building
the screen turned up the third missing piece: there is no jump-to-position
either. Only `next` exists, and it advances exactly one track.

Two ways to fake it were considered and rejected:

1. **Fire `next` *n* times to reach row *n*.** That is *n* unrelated writes
   with no transaction around them. Any one can be refused or rate-limited
   (D-025), the queue refills from the play context while the burst is in
   flight, and `previous` cannot walk it back. Asking for row seven and landing
   on row four with no way home is worse than a tap that does nothing.
2. **Make only the first upcoming row tappable**, since one `next` genuinely
   reaches it. Honest in isolation, and it teaches a lie: a list whose top row
   responds to touch has promised that the rest do, so every tap after the
   first reads as a broken panel. It also adds nothing the skip glyph on the
   plate does not already do.

**The note is phrased about Spotify, not about Joshify** — "Spotify offers no
way to reorder, remove or jump to a queued track" — because the viewer is not
being told a feature is missing from this app. They are being told it is
impossible from any client, which is both true and the only thing that stops
the screen reading as unfinished.

**This corrected `SCREENS.md`**, which specified tap-to-jump. Writing the
screen is what found it; the spec had assumed an endpoint into existence.
**Status:** ✅ Accepted.

---

### D-052 · Search is fenced twice, on purpose
**Chose:** the server holds one long-lived search session that answers an
overtaken request with `{ status: 'superseded' }` (D-032), *and* the client
checks each answer against the query it last asked for.
**Why both:** they guard different hops. The session's fence protects the
server's own idea of the newest query — it is what stops a slow upstream call
for "bea" from becoming the answer of record after "beatles" has been asked
for. It cannot do anything about the trip back, where two HTTP responses can
still arrive out of order and the later-rendered one wins.

This is not belt and braces. Removing either one leaves a real reordering
window: the server's guards the Spotify call, the client's guards the socket
back to the panel.

**`superseded` is a success, not a failure.** Being overtaken is the normal
outcome of typing. Rendering it as an error would flash a fault on the screen
on every letter, so it publishes nothing and leaves the last real answer
standing.

**A failed search does not clear the screen either** — the rows already there
stay, with the problem recorded alongside. Same rule as a failed device refresh
(D-049) and a dropped socket (D-048): the last true thing on screen is worth
more than an accurate blank.
**Status:** ✅ Accepted.
