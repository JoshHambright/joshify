/**
 * A row in a long list: what it is, what it says, and how it gets its picture
 * without the pictures growing without bound.
 *
 * **Why the row shapes are declared here rather than imported.** They are the
 * server's normalised library shapes (`apps/server/src/library/normalise.ts`)
 * and they are mirrored, not redefined: the panel is a dumb renderer (D-003)
 * and has no dependency on the server package, so the contract has to be
 * written down on this side of the wire. They are kept field-for-field
 * identical on purpose — a divergence here is a row that renders blank, which
 * is the sort of thing that looks like an empty library.
 *
 * **The eviction policy, and why there is one.** Scrolling a thousand albums
 * asks the browser for a thousand images. Virtualisation already unmounts the
 * rows that scrolled away, so the decoded bitmaps go with them; what is left to
 * leak is the bookkeeping — the chosen URL and whether it has been seen before,
 * which is what stops a row that scrolls back into view from flashing empty
 * again. That bookkeeping is an LRU bounded at `DEFAULT_CACHE_CAPACITY`
 * entries, evicting least-recently-used.
 *
 * LRU rather than "clear when the list changes" because the direction people
 * scroll is *back*: a user who overshoots and flicks up must not watch the
 * rows they just passed reload. And bounded rather than unbounded because the
 * kiosk runs for weeks without a reload — an unbounded map is not a leak that
 * shows up in a test, it is one that shows up in month three.
 */
import { selectArtwork, type Artwork } from '@joshify/core';
import { formatTime } from './format.js';

export type LibraryItemKind = 'track' | 'album' | 'artist' | 'playlist';

interface LibraryItemBase {
  readonly kind: LibraryItemKind;
  /** Null for local files, which exist only on the machine that holds them. */
  readonly id: string | null;
  /** The play handle. A row without one is never rendered. */
  readonly uri: string;
  readonly title: string;
  readonly subtitle: string;
  /** Every size Spotify offered, widest first. */
  readonly images: readonly Artwork[];
}

export interface TrackResult extends LibraryItemBase {
  readonly kind: 'track';
  readonly artists: readonly string[];
  readonly albumName: string | null;
  readonly durationMs: number;
  readonly isLocal: boolean;
}

export interface AlbumResult extends LibraryItemBase {
  readonly kind: 'album';
  readonly artists: readonly string[];
  readonly totalTracks: number;
  /** Only the year is dependable; `release_date` is precision-tagged. */
  readonly releaseYear: number | null;
}

export interface ArtistResult extends LibraryItemBase {
  readonly kind: 'artist';
}

export interface PlaylistResult extends LibraryItemBase {
  readonly kind: 'playlist';
  readonly ownerName: string | null;
  readonly totalTracks: number;
}

export type LibraryItem = TrackResult | AlbumResult | ArtistResult | PlaylistResult;

export interface SearchResults {
  /** The query these answer. The screen's stale fence reads this (D-032). */
  readonly query: string;
  readonly tracks: readonly TrackResult[];
  readonly albums: readonly AlbumResult[];
  readonly artists: readonly ArtistResult[];
  readonly playlists: readonly PlaylistResult[];
}

export interface LibraryPage<T> {
  readonly items: readonly T[];
  readonly offset: number;
  readonly limit: number;
  /** Rows in the whole collection, including the ones not fetched. */
  readonly total: number;
  /** Offset to request next, or null when this was the last page. */
  readonly nextOffset: number | null;
}

/** What an empty query shows instead of a blank screen (D-031). */
export interface LibraryView {
  readonly albums: LibraryPage<AlbumResult>;
  readonly playlists: LibraryPage<PlaylistResult>;
}

/** Which half of the library a paging request is for. */
export type LibrarySection = 'albums' | 'playlists';

/**
 * A flattened list row.
 *
 * Groups are flattened into one array rather than drawn as separate scrolling
 * sections because nested scroll areas on a touch panel steal each other's
 * flicks, and because one array is one virtual window instead of four. Headers
 * take a full row so that every row is the same height — uniform rows are what
 * make the window arithmetic a division rather than a running total.
 */
export type ListRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly id: string; readonly item: LibraryItem };

const header = (id: string, label: string): ListRow => ({ kind: 'header', id, label });

const section = (id: string, label: string, items: readonly LibraryItem[]): ListRow[] =>
  items.length === 0
    ? // An empty group is not drawn at all. A heading over nothing reads as a
      // list that failed to load rather than one with no matches.
      []
    : [
        header(id, label),
        ...items.map(
          (item, index): ListRow => ({
            kind: 'item',
            // Unique by construction: a track can appear in two groups, and the
            // same uri can legitimately appear twice within one.
            id: `${id}#${String(index)}`,
            item,
          }),
        ),
      ];

/**
 * Tracks first, then albums, artists, playlists.
 *
 * Tracks lead because "play that song" is what someone standing at a wall panel
 * is doing; the order after that matches the server's own field order, so the
 * screen and the payload cannot drift apart.
 */
export const searchRows = (results: SearchResults | null): readonly ListRow[] => {
  if (results === null) return [];
  return [
    ...section('tracks', 'Tracks', results.tracks),
    ...section('albums', 'Albums', results.albums),
    ...section('artists', 'Artists', results.artists),
    ...section('playlists', 'Playlists', results.playlists),
  ];
};

export const libraryRows = (library: LibraryView | null): readonly ListRow[] => {
  if (library === null) return [];
  return [
    ...section('albums', 'Saved albums', library.albums.items),
    ...section('playlists', 'Playlists', library.playlists.items),
  ];
};

/** The right-hand column: one fact per kind, and nothing where there is none. */
export const rowMeta = (item: LibraryItem): string => {
  switch (item.kind) {
    case 'track':
      return formatTime(item.durationMs);
    case 'album':
      return item.releaseYear === null ? '' : String(item.releaseYear);
    case 'playlist':
      return `${String(item.totalTracks)} tracks`;
    case 'artist':
      // Genres are usually empty and follower counts are noise on a list row.
      return '';
  }
};

/**
 * Row artwork is 56px on a 1:1 panel, so 64px is the smallest that is not
 * upscaled. Asking for the 640px sleeve to draw it at 56 costs a hundred times
 * the bytes and decodes to a bitmap the size of the screen.
 */
export const THUMBNAIL_PX = 64;

/**
 * Reuses core's picker rather than reading `images[0]`: picking artwork by
 * position is exactly the assumption that puts a 640px image behind a 56px box
 * the day the payload's order changes.
 */
export const pickThumbnail = (
  images: readonly Artwork[],
  minWidth = THUMBNAIL_PX,
): string | null => selectArtwork(images, minWidth)?.url ?? null;

/**
 * Twelve screenfuls at 76px rows on a 1280px panel — far enough that ordinary
 * back-and-forth scrolling never evicts anything the user is still looking at,
 * small enough that it is a bounded number rather than "the whole library".
 */
export const DEFAULT_CACHE_CAPACITY = 128;

interface ThumbnailEntry {
  readonly url: string | null;
  loaded: boolean;
}

export interface ThumbnailCache {
  /**
   * The URL for this row, recording that it was used. Null when the item has
   * no artwork at all — a real answer, and the row draws a plain tint for it
   * rather than a broken-image glyph.
   */
  readonly resolve: (key: string, images: readonly Artwork[]) => string | null;
  /** Called once the browser has actually decoded it. */
  readonly markLoaded: (key: string) => void;
  /** Whether this row can appear without fading in — it has been seen before. */
  readonly isLoaded: (key: string) => boolean;
  readonly size: () => number;
  /** Least-recently-used first. Exists for the tests; nothing else reads it. */
  readonly keys: () => readonly string[];
}

export interface ThumbnailCacheOptions {
  readonly capacity?: number | undefined;
}

export const createThumbnailCache = (
  options: ThumbnailCacheOptions = {},
): ThumbnailCache => {
  const capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CACHE_CAPACITY));

  // A Map iterates in insertion order, so delete-then-set is the whole LRU:
  // the oldest key is always the first one out of `keys()`.
  const entries = new Map<string, ThumbnailEntry>();

  const touch = (key: string): ThumbnailEntry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };

  return {
    resolve: (key, images) => {
      const existing = touch(key);
      if (existing !== undefined) return existing.url;

      const entry: ThumbnailEntry = { url: pickThumbnail(images), loaded: false };
      entries.set(key, entry);
      // Evicting after inserting, rather than before, means an entry can never
      // evict itself when the cache is full — which would make every row a
      // miss and the fade fire on every frame of a scroll.
      while (entries.size > capacity) {
        const oldest: string | undefined = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return entry.url;
    },

    markLoaded: (key) => {
      const entry = touch(key);
      if (entry !== undefined) entry.loaded = true;
    },

    // Deliberately does not count as a use: this is asked during render, and a
    // render is not a scroll. Only `resolve` moves a row up the queue.
    isLoaded: (key) => entries.get(key)?.loaded ?? false,

    size: () => entries.size,
    keys: () => [...entries.keys()],
  };
};
