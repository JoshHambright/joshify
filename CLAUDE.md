# CLAUDE.md — Joshify

Guidance for Claude Code working in this repository.

---

## ⚠️ The VM is ephemeral. Commit and push often.

**This project is developed in Claude Code cloud sessions. The container is
temporary and gets reclaimed after inactivity or when the session ends.**

When that happens, the conversation history is restored — **the container's
filesystem is not.** Uncommitted work is gone permanently, with no recovery path.

**GitHub is the only durable storage. Nothing else counts as saved.**

### Rules

1. **Push at every meaningful checkpoint** — a completed task, a passing test
   suite, a working spike, the end of a work session. Do not batch pushes.
2. **Never leave the tree dirty across a long-running operation.** Commit before
   anything that could stall or time out.
3. **Push, don't just commit.** A local commit dies with the container.
4. **When in doubt, push.** There is no cost to an extra push. There is a total
   cost to a lost one.
5. **Work in progress is still worth pushing.** A WIP commit that survives beats
   perfect work that doesn't. Mark it clearly:
   `git commit -m "WIP P3-05: blur pre-render, not yet wired up"`
6. **Verify the push landed.** Check the command succeeded — don't assume.

```bash
git add -A
git commit -m "P2-04: interpolate progress between polls"
git push -u origin claude/spotify-touch-screen-interface-7hv8vm
```

If a push fails on a network error, retry with backoff (2s, 4s, 8s, 16s).

### Sanity check before ending any turn

```bash
git status -sb          # tree clean? branch in sync with origin?
```

If that shows uncommitted changes or unpushed commits, **you are not done.**

### Recovering after a purge

A fresh session starts with a clean clone and no container state. To resume:

1. `git log --oneline -10` on the branch — the last push is where we actually are.
2. Read `docs/TRACKING.md` — task statuses are the source of truth for progress.
3. Read `docs/DECISIONS.md` — do not re-litigate settled decisions.

This is why the tracker is updated **in the same commit as the work it
describes.** It is not documentation; it is the handoff mechanism.

---

## Project

A touchscreen control surface for Spotify running on a **Raspberry Pi 5**. It
displays and controls playback on the user's account; it is not the audio source
(except via the optional `librespot` module).

**Branch:** `claude/spotify-touch-screen-interface-7hv8vm` — develop and push here.
Never push elsewhere without explicit permission.

**Reference repo:** `../Nowify` is a read-only Vue 2 now-playing app, useful for
its Spotify auth flow and colour extraction. Never write to it.

## Visual work: prototype in a page first

**Anything visual gets a published Artifact page for review before it becomes a
task.** Joshify's target is a browser, so a published page runs the same GLSL and
CSS the Pi will — a prototype isn't a mockup of the thing, it's the thing on
different hardware.

1. Build the prototype, publish it, share the link.
2. Iterate on feedback. Only the approved version becomes tracker tasks.
3. **Commit the source under `spikes/<name>/`** with a README covering what it
   proved and which techniques are worth keeping. The published page is not
   storage — the container dies, and so does anything not in git.

Applies to effect presets, theme extraction, the on-screen keyboard, list-scroll
feel, UI chrome. Rationale in `DECISIONS.md` D-016.

Note: this session cannot receive comments left on artifact pages, so feedback
comes back through chat.

## Documentation map

| File | Contents |
|---|---|
| `docs/PRODUCT.md` | What we're building, design principles, platform constraints |
| `docs/ROADMAP.md` | 9 phases, each with an exit criterion |
| `docs/TRACKING.md` | **Live tracker — 121 tasks.** Update with the work |
| `docs/DECISIONS.md` | ADR log. Read before changing an approach |
| `docs/VISUALIZER.md` | Visualizer engine design (Phase 5) |
| `docs/SCREENS.md` | **The interface, specified.** Read before building any UI |
| `docs/PS1_MODE.md` | PS1 / N2O visual mode + the homage-not-reproduction rule |
| `docs/THEMES.md` | Theme roster — the 90s references, as separate named themes |
| `spikes/` | Working prototypes. Each has a README on what it proved |
| `docs/HARDWARE.md` | Board decision + buy list |
| `docs/SPOTIFY_SETUP.md` | App registration, scopes, secrets |

## Scope discipline

**Phases 1–4 are the product.** Joshify is a touchscreen Spotify remote; the
visualiser is one phase of nine. New visual ideas go to the theme backlog in
`docs/THEMES.md`, **not** into the tracker, unless they close a gap in the
*product* rather than in the reference list (D-019).

## Conventions

- **Optional inputs on public functions take `?: T | undefined`**, not bare
  `?: T`. `exactOptionalPropertyTypes` makes a bare optional reject an explicit
  `undefined`, and callers legitimately hold values that are absent — a device
  id before any device is chosen, for example. Forcing a conditional spread at
  every call site buys no safety. Bare `?:` is still right for internal config
  objects a caller builds literally.

- **Task IDs in commit messages**: `P2-04: <what changed>`. IDs come from
  `docs/TRACKING.md`.
- **A task is ✅ only when its tests pass in CI**, not when the code works.
- **Non-obvious choices get a `DECISIONS.md` entry.**
- **Cut scope is recorded, not deleted** — mark ❌ with a reason.

## Constraints that are already settled

Do not rediscover or re-argue these. Full reasoning is in `DECISIONS.md`.

- **Spotify Premium is required.** Every `/me/player` write needs it.
- **Canvas / music videos: cut.** No public API; only ToS-violating endpoints (D-005).
- **`audio-analysis` / `audio-features` are deprecated for new apps** (2024-11-27,
  `403`). Reactivity comes from the three-tier provider instead (D-010), not from
  Spotify. Also gone: `recommendations`, `related-artists` — so no discovery features.
- **The queue has no reorder or remove endpoint.** View + add + skip only. Do not
  build an affordance that cannot work (D-007).
- **Redirect URIs must be HTTPS or literal `127.0.0.1`.** `localhost` is rejected.
- **Pi 5 has no 3.5mm jack** (USB DAC needed) and uses a **22-pin DSI** connector
  (adapter cable needed). Needs 5V/5A and active cooling (D-008).
- **All period aesthetics are homage, never reproduction.** Never reproduce
  Sony's boot animation or logos, Windows logos/bitmaps, the Surge wordmark,
  Pizza Hut or BOOK IT! branding, Ms. Frizzle, Carmen Sandiego, or any
  MECC/Broderbund/Maxis/Sega asset, or the Magic Eye name (use "autostereogram")
  — all trademarked. No theme named after a
  trademark. Original work in the era's idiom only (D-015).

## Secrets

**Never commit credentials.** Spotify keys live in GitHub Secrets and a gitignored
local `.env`. Only an encrypted refresh token is stored on the device.

CI must never need real Spotify credentials — tests run against the fake Spotify
server (P1-10).
