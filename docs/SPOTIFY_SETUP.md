# Spotify Application Setup

What Josh needs to do, and when. **Nothing here is ever committed to the repo.**

Needed at: **P1-02 / P1-03** — not before.

---

## 0. ⚠️ Check first: app creation may be paused

Spotify has periodically **disabled the "Create app" button** while it reworks
new integrations. If the button is greyed out, that is Spotify's doing, not a
mistake on your end — wait and retry rather than hunting for a workaround.

## 1. Account requirement

Joshify requires **Spotify Premium**, for two separate reasons now:

1. Every `/me/player` write endpoint (play, pause, next, previous, seek, volume,
   shuffle, repeat, transfer) returns `403 Player command failed: Premium
   required` on a free account.
2. Since early 2026, Spotify requires the **app owner** to hold Premium in order
   to use Development Mode at all.

### Quota, and why we will never leave Development Mode

A new app starts in **Development Mode**, which now allows **5 authenticated
users** (reduced from 25 in early 2026). For a personal appliance that is one
user, so it is not a constraint.

It is also permanent: **Extended Quota Mode has only accepted applications from
organisations, not individuals, since 15 May 2025.**

That closes a door worth naming. The deprecated `audio-features` /
`audio-analysis` endpoints remained available to apps with prior extended
access — so "just get extended access" was a theoretical route back to Spotify's
own beat data. It is not available to an individual, which confirms the
three-tier reactivity design (D-010) as the only path, not merely the preferred
one.

## 2. Create the application

At the Spotify Developer Dashboard, create an app named `Joshify`.

Record the **Client ID** and **Client Secret**.

> Joshify uses **Authorization Code with PKCE**, which does not require the
> client secret at runtime on the device. We still record it, but the goal is
> for the Pi to never hold it — that's the point of PKCE on an appliance.

## 3. Redirect URI

✅ **Settled by spike P1-01.** Register exactly:

Register **all three**. Extra URIs cost nothing and save a dashboard trip later:

```
http://127.0.0.1:8080/callback     ← the one we actually use
http://[::1]:8080/callback         ← IPv6 loopback, in case of resolution quirks
http://127.0.0.1:8888/callback     ← escape hatch if 8080 is taken during dev
```

The device authorises in its own kiosk browser, so the redirect target and the
browser are the same machine and loopback resolves correctly.

**The port is part of the match.** Spotify compares redirect URIs exactly, so
changing `JOSHIFY_PORT` without registering the new URI breaks authentication.
That is the reason for the 8888 spare.

Spotify tightened redirect URI rules: they must be **HTTPS**, or a **literal
loopback address**. Specifically:

- ✅ `http://127.0.0.1:8080/callback`
- ❌ `http://localhost:8080/callback` — rejected, `localhost` is no longer allowed
- ❌ `http://192.168.1.50:8080/callback` — rejected, not HTTPS, not loopback

Note also that Spotify's **Device Authorization Grant** (`spotify.com/pair`),
which would be the natural fit for an appliance, is allowlisted to Spotify's own
TV applications and does **not** work for Dashboard-registered client IDs.

## 4. Scopes

Requested at authorization time. Joshify asks for the minimum needed:

| Scope | Needed for |
|---|---|
| `user-read-playback-state` | Read what's playing, and the device list |
| `user-modify-playback-state` | All transport, volume, and device transfer |
| `user-read-currently-playing` | Currently playing item |
| `user-read-private` | Detect Premium vs free, for the explanatory screen |
| `user-library-read` | Saved albums browse (Phase 6) |
| `playlist-read-private` | Playlist browse (Phase 6) |
| `playlist-read-collaborative` | Collaborative playlists in browse (Phase 6) |

We deliberately request **no write scopes for library or playlists**. Joshify
never modifies your saved music.

## 5. Secrets storage

| Where | What | Why |
|---|---|---|
| Local `.env` | `SPOTIFY_CLIENT_ID` | Gitignored. Never committed |
| On the Pi | Refresh token only, encrypted at rest | P1-06 |

### Do not store the client secret. Anywhere.

**PKCE does not use it** — spike P1-01 confirmed the whole flow completes with
no secret at any step. A secret we never read is pure liability: something to
leak, rotate and worry about, buying nothing.

So leave it in the Spotify dashboard and copy it nowhere. Not into `.env`, not
into GitHub Secrets. The Client ID is not sensitive; it travels in the authorize
URL in plain sight by design.

Nothing currently needs `SPOTIFY_CLIENT_ID` in GitHub Secrets either, because CI
runs against the fake Spotify server. Add it only if a job genuinely needs it.

**CI does not need real credentials for the test suite.** Every test from Phase 2
onward runs against the fake Spotify server (P1-10). Real credentials are only
for manual verification and optional live smoke tests.
