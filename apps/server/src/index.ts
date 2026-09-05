/**
 * joshify-server — the process that owns all Spotify I/O.
 *
 * It holds the OAuth tokens, polls playback state, extracts themes and
 * pre-renders blurred artwork, then pushes finished payloads to the UI over
 * localhost. Keeping the expensive work here is what leaves the Pi's GPU free
 * for the visualiser (DECISIONS.md D-003).
 *
 * The playback engine (`engine/playback-engine.ts`) is the composition that
 * makes those parts a running loop; it is what a host process starts.
 */
export const name = 'joshify-server';

export {
  createPlaybackEngine,
  realScheduler,
  type CancelScheduled,
  type EngineCommand,
  type PlaybackEngine,
  type PlaybackEngineConfig,
  type Scheduler,
} from './engine/playback-engine.js';
