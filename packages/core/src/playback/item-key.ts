import type { PlayingItem } from './state.js';

/**
 * A stable identity for whatever is playing, used to answer "is this still the
 * same thing?" across polls.
 *
 * Shared deliberately rather than duplicated. Two modules depend on this
 * answer for different reasons — the progress tracker resets its anchor on a
 * track change, and the optimistic layer invalidates a pending seek — and they
 * must agree. Divergent copies would produce a bar that resets while a seek
 * survives, or the reverse, which is a miserable thing to debug.
 *
 * The fallback exists because **local files have neither an id nor a uri**.
 * Without it, every poll of one would look like a different track.
 */
export const playingItemKey = (item: PlayingItem | null): string | null => {
  if (item === null) return null;
  return item.id ?? item.uri ?? `local:${item.title}:${String(item.durationMs)}`;
};
