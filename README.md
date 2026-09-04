# Joshify

A touchscreen control surface for Spotify, built for a **Raspberry Pi 5**.

It shows what's playing — album art, big — and controls your account by touch.
It is not the audio source; it drives playback on your real speakers, phone or
desktop over Spotify Connect. Optionally, it can also *be* a Connect target.

The visualiser renders your album art as a 1998 PlayStation tunnel.

> **Status: Phase 1 code complete, Phase 2 underway.** Authentication, the
> Spotify client and the playback model are built and tested. Progress lives in
> [`docs/TRACKING.md`](docs/TRACKING.md).
> Progress lives in [`docs/TRACKING.md`](docs/TRACKING.md).

## Requirements

- **Spotify Premium.** Every playback-control endpoint requires it.
- **Node 22+** and **pnpm 10+** for development.
- A Raspberry Pi 5 and a touchscreen, eventually — see
  [`docs/HARDWARE.md`](docs/HARDWARE.md) for the buy list, including two Pi 5
  gotchas that cost a second order if missed.

## Connecting a Spotify account

```bash
cp .env.example .env          # then set SPOTIFY_CLIENT_ID
pnpm build
node apps/server/dist/cli/bin.js auth
```

Authorisation happens in a browser **on the device itself** — the redirect
target is `127.0.0.1`, so the browser and the listener are the same machine and
nothing has to be carried back by hand. It is a one-time step; the refresh token
is stored encrypted and survives reboots.

There is no client secret to configure. Joshify uses Authorization Code with
PKCE, which completes without one, so there is no secret on the device to leak.

| Command | Does |
|---|---|
| `joshify auth` | Connect an account. Run once |
| `joshify status` | Whether an account is connected, and token freshness |
| `joshify logout` | Forget the stored account |

`joshify auth` also checks the account has Premium and says so plainly if not —
better than every playback control failing with a 403 later.

## Getting started

```bash
pnpm install
pnpm verify     # lint, format, typecheck, test with coverage, build
```

`pnpm verify` is exactly what CI runs. If it passes locally, it passes there.

| Command | Does |
|---|---|
| `pnpm verify` | Everything below, in order. The one command that matters |
| `pnpm lint` | ESLint, type-aware |
| `pnpm format` | Prettier, writing changes |
| `pnpm typecheck` | `tsc --build` across the project graph |
| `pnpm test` | Vitest once |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm coverage` | Vitest with coverage thresholds |
| `pnpm build` | Each package's own build |

No Spotify credentials are needed to run the test suite, and CI never has them —
tests run against a fake Spotify server (P1-10).

## Layout

```
packages/core   Domain logic. Pure, no I/O, fully testable
apps/server     Owns Spotify I/O, tokens, polling, theme extraction
apps/ui         Kiosk renderer. No secrets, no Spotify calls
site/           The public build log
spikes/         Working prototypes, each with a README on what it proved
docs/           Product, roadmap, tracker, decisions
```

The split is deliberate: the server does everything expensive **once per track**
so the UI's per-frame job stays trivial, which leaves the Pi's GPU free for the
visualiser. Reasoning in [`docs/DECISIONS.md`](docs/DECISIONS.md) D-003.

## Documentation

| Document | Contents |
|---|---|
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What this is, design principles, hard platform constraints |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Nine phases, each with an exit criterion |
| [`docs/TRACKING.md`](docs/TRACKING.md) | **Live tracker.** Task-level progress |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decision log, including the ones we reversed |
| [`docs/VISUALIZER.md`](docs/VISUALIZER.md) | Visualiser engine design |
| [`docs/PS1_MODE.md`](docs/PS1_MODE.md) | The PS1 / N2O visual mode |
| [`docs/THEMES.md`](docs/THEMES.md) | Theme roster and backlog |
| [`docs/HARDWARE.md`](docs/HARDWARE.md) | Board decision and buy list |
| [`docs/SPOTIFY_SETUP.md`](docs/SPOTIFY_SETUP.md) | App registration, scopes, secrets |

## A note on the visuals

Every period aesthetic here is **homage, never reproduction**. No trademarked
logos, wordmarks, boot animations, characters or game assets are reproduced —
only original work in the era's idiom. See `DECISIONS.md` D-015.

## Licence

MIT — see [LICENSE](LICENSE).
