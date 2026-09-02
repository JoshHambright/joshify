# Spike P1-01 — Authorization Code + PKCE on a keyboard-less appliance

**Verdict: ✅ Solved.** PKCE over a loopback redirect works, and the first-run
experience is better than expected — because the Pi is not actually headless.

```bash
pnpm build && node spikes/pkce-loopback/run.mjs
```

Runs the whole flow against a fake Spotify on loopback. No credentials, no
network. The fake verifies the PKCE binding for real — it stores the challenge
at `/authorize` and recomputes SHA-256 of the verifier at `/api/token` — so
step 7 proves a mismatched verifier is genuinely rejected, rather than
asserting it.

## The two findings that decided the design

### 1. Spotify's device flow exists, but not for us

Spotify implements the **OAuth 2.0 Device Authorization Grant** (RFC 8628) at
`accounts.spotify.com/oauth2/device/authorize`, paired with `spotify.com/pair`.
That is the textbook answer for an appliance: show a short code, let the user
approve on their phone.

**It is allowlisted to Spotify's own TV applications and does not work for a
`client_id` registered through the Developer Dashboard.**

So the appliance-shaped flow is closed to us. Worth knowing early — it would
have been an easy thing to design around and then discover late.

### 2. Redirect URIs: loopback literals only

Since **27 November 2025**, Spotify requires HTTPS for redirect URIs, with one
exception: HTTP is still permitted for **loopback literals**.

| URI | |
|---|---|
| `https://anything/callback` | ✅ |
| `http://127.0.0.1:8080/callback` | ✅ |
| `http://[::1]:8080/callback` | ✅ |
| `http://localhost:8080/callback` | ❌ rejected — the hostname is banned |
| `http://192.168.1.50:8080/callback` | ❌ http, not loopback |

`checkRedirectUri` in `packages/core/src/auth/pkce.ts` encodes this so a bad
value fails locally with a useful message instead of at Spotify.

## Why this is fine: the Pi has a touchscreen

The spike was framed around "a device with no keyboard", which quietly assumed
the auth had to happen somewhere else and be transferred back. It doesn't.

**Joshify runs a kiosk browser on a touchscreen.** The redirect target
(`127.0.0.1`) and the browser are the *same machine*, so loopback resolves
correctly with nothing to transfer. First run is:

1. Device shows a "Connect your Spotify account" screen.
2. Tapping it opens Spotify's login in the kiosk browser.
3. User types their credentials on the on-screen keyboard — which Phase 6 is
   building anyway (P6-02).
4. Spotify redirects to `http://127.0.0.1:8080/callback`; the server captures
   the code and exchanges it.
5. Never again — the refresh token is stored encrypted (P1-06).

Once. On a device you set up once. The on-screen keyboard is mildly annoying
for one password entry and then irrelevant forever.

### The fallback, if that proves unpleasant

Serve the same login page over the LAN and let the user drive it from a phone.
The redirect still has to land on `127.0.0.1` *on the Pi*, so the phone would
need to hand the code back — a QR code or a short pairing code shown on the
touchscreen. It works, but it is strictly more machinery than tapping through
on the device itself.

**Not building it.** Revisit only if on-device entry actually annoys us.

## What the spike leaves behind

`packages/core/src/auth/pkce.ts` is real, tested code, not throwaway:

- `createVerifier` — RFC 7636 §4.1, injectable randomness. The 64-character
  alphabet divides 256 exactly, so there is no modulo bias to correct.
- `challengeFor` — S256, validated against the RFC 7636 Appendix B example.
- `createState` — CSRF defence, checked on the callback.
- `checkRedirectUri` — Spotify's rules, enforced locally.
- `buildAuthorizeUrl` — refuses to build a URL with an invalid redirect.

No client secret appears anywhere in the flow. That is the point of PKCE on a
device: there is no secret on the Pi to steal.
