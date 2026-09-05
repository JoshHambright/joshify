/**
 * The engine's `Presenter`, backed by the real artwork pipeline (P3-03/P3-07).
 *
 * A thin adapter on purpose. `prepareArtwork` already owns the interesting
 * parts — picking the 64px source, the on-disk cache, the contrast correction
 * — and the engine already owns the timing. What is left is one decision this
 * file does make: **a track whose extraction fails keeps the neutral default
 * rather than failing the poll.** A colour is the least important thing on the
 * panel, and it must never be the reason the title does not appear.
 *
 * Memoised on the item's artwork, because a paused player is polled for hours
 * and the engine asks on every item change — including the change back from a
 * podcast to the track that was playing before it.
 */
import { playingItemKey, type PlayingItem, type ThemeTokens } from '@joshify/core';
import { prepareArtwork, type PrepareArtworkOptions } from '../artwork/pipeline.js';
import type { Presenter } from './playback-engine.js';

export interface ArtworkPresenterOptions extends PrepareArtworkOptions {
  /**
   * How many extracted themes to remember.
   *
   * An album is a dozen tracks that mostly share one cover, and someone
   * flicking back and forth through a playlist revisits the same handful for
   * an evening. Small, because the device runs for weeks and this is a cache
   * of last resort — the on-disk artwork cache underneath it is the real one.
   */
  readonly memoLimit?: number | undefined;
}

const DEFAULT_MEMO_LIMIT = 32;

export const createArtworkPresenter = (options: ArtworkPresenterOptions): Presenter => {
  const limit = options.memoLimit ?? DEFAULT_MEMO_LIMIT;
  const memo = new Map<string, ThemeTokens>();

  const remember = (key: string, theme: ThemeTokens): void => {
    memo.delete(key);
    memo.set(key, theme);
    // Insertion order is iteration order, so the first key is the oldest.
    while (memo.size > limit) {
      const oldest = memo.keys().next();
      if (oldest.done === true) break;
      memo.delete(oldest.value);
    }
  };

  return {
    themeFor: async (item: PlayingItem): Promise<ThemeTokens> => {
      // Keyed on the item rather than the image URL because a local file has
      // no artwork at all and no id — `playingItemKey` is the one identity
      // that works for every kind of item (D-024).
      const key = playingItemKey(item);
      const known = memo.get(key);
      if (known !== undefined) {
        // Refresh recency without recomputing.
        remember(key, known);
        return known;
      }

      // `prepareArtwork` already answers `DEFAULT_THEME` when there is no
      // usable source and records the reason in `problems`, so there is no
      // failure to translate here — a colour is the least important thing on
      // the panel, and never worth failing a poll over.
      const { theme } = await prepareArtwork(item.images, options);
      remember(key, theme);
      return theme;
    },
  };
};
