/**
 * joshify-ui — the kiosk renderer.
 *
 * A pure renderer of state pushed from the server: it holds no secrets, makes
 * no Spotify calls, and computes nothing expensive. Its per-frame job is to
 * composite cached bitmaps and run the visualiser's shader chain.
 *
 * Nothing is wired up yet; Phase 3 brings the Now Playing screen.
 */
export const name = 'joshify-ui';
