/**
 * The permissions Joshify asks for, and nothing else.
 *
 * Deliberately no write scopes for library or playlists: Joshify never modifies
 * your saved music, and not holding the permission is a stronger guarantee than
 * promising not to use it.
 */
export const REQUIRED_SCOPES = [
  /** Read what's playing, and the Connect device list. */
  'user-read-playback-state',
  /** All transport, volume and device transfer. */
  'user-modify-playback-state',
  'user-read-currently-playing',
  /** Detect Premium, so a free account gets an explanation instead of 403s. */
  'user-read-private',
  /** Saved albums browse (Phase 6). */
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
] as const;
