/**
 * joshify-server — the process that owns all Spotify I/O.
 *
 * It holds the OAuth tokens, polls playback state, extracts themes and
 * pre-renders blurred artwork, then pushes finished payloads to the UI over
 * localhost. Keeping the expensive work here is what leaves the Pi's GPU free
 * for the visualiser (DECISIONS.md D-003).
 *
 * Nothing is wired up yet; Phase 1 brings the Spotify client.
 */
export const name = 'joshify-server';
