# Spotify Application Setup

What Josh needs to do, and when. **Nothing here is ever committed to the repo.**

Needed at: **P1-02 / P1-03** — not before.

---

## 1. Account requirement

Joshify requires **Spotify Premium**. Every `/me/player` write endpoint
(play, pause, next, previous, seek, volume, shuffle, repeat, transfer) returns
`403 Player command failed: Premium required` on a free account.

## 2. Create the application

At the Spotify Developer Dashboard, create an app named `Joshify`.

Record the **Client ID** and **Client Secret**.

> Joshify uses **Authorization Code with PKCE**, which does not require the
> client secret at runtime on the device. We still record it, but the goal is
> for the Pi to never hold it — that's the point of PKCE on an appliance.

## 3. Redirect URI

✅ **Settled by spike P1-01.** Register exactly:

```
http://127.0.0.1:8080/callback
```

The device authorises in its own kiosk browser, so the redirect target and the
browser are the same machine and loopback resolves correctly.

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
| GitHub Secrets | `SPOTIFY_CLIENT_ID` | For any CI job needing it |
| GitHub Secrets | `SPOTIFY_CLIENT_SECRET` | Not used at device runtime |
| Local `.env` | Both, for development | Gitignored. Never committed |
| On the Pi | Refresh token only, encrypted at rest | P1-06 |

**CI does not need real credentials for the test suite.** Every test from Phase 2
onward runs against the fake Spotify server (P1-10). Real credentials are only
for manual verification and optional live smoke tests.
