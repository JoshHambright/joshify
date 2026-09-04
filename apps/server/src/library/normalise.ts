/**
 * Flat, ready-to-draw shapes for everything the search and library screens list.
 *
 * Same contract as the playback normaliser in `@joshify/core`: the UI is a dumb
 * renderer (D-003) and never reaches into a Spotify payload itself, so every
 * quirk of these payloads is absorbed here. Artwork is exposed as the full list
 * rather than one chosen URL, for the same reason it is there — the theme
 * extractor wants the 64px variant and the screen wants the largest, and
 * `selectArtwork` from core picks between them per consumer.
 *
 * One rule differs from playback state: **a row we cannot make sense of is
 * dropped, not fatal.** Spotify genuinely ships broken rows — `/v1/search` has
 * returned literal `null` entries inside `playlists.items` for years, and a
 * track that left the catalogue arrives inside a playlist as `{ track: null }`.
 * One bad entry in a page of fifty should cost the user that row, not the whole
 * screen. Only an envelope we cannot recognise at all becomes an `Err`.
 */
import {
  createError,
  err,
  ok,
  type Artwork,
  type JoshifyError,
  type Result,
} from '@joshify/core';

export type LibraryItemKind = 'track' | 'album' | 'artist' | 'playlist';

interface LibraryItemBase {
  /** Which shape this is. The UI switches its row template on this. */
  readonly kind: LibraryItemKind;
  /** Null for local files, which exist only on the machine that holds them. */
  readonly id: string | null;
  /**
   * The play handle. Required, not nullable: a row that cannot be played is a
   * row that does nothing when tapped, so unidentifiable entries are dropped
   * rather than rendered (D-007's rule — no affordance that cannot work).
   */
  readonly uri: string;
  readonly title: string;
  /** One line under the title. May legitimately be empty. */
  readonly subtitle: string;
  /** Every size Spotify offered, widest first. */
  readonly images: readonly Artwork[];
}

export interface TrackResult extends LibraryItemBase {
  readonly kind: 'track';
  readonly artists: readonly string[];
  readonly albumName: string | null;
  readonly durationMs: number;
  /** A file on someone's disk. Has a `spotify:local:` uri the API cannot play. */
  readonly isLocal: boolean;
}

export interface AlbumResult extends LibraryItemBase {
  readonly kind: 'album';
  readonly artists: readonly string[];
  readonly totalTracks: number;
  /**
   * `release_date` is precision-tagged: a 1969 reissue may carry `1969`,
   * `1969-08` or `1969-08-08` depending on what the label filed. Only the year
   * is dependable, and it is the only part a list row shows anyway.
   */
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
  /** The query these results answer, so a stale render can be spotted. */
  readonly query: string;
  readonly tracks: readonly TrackResult[];
  readonly albums: readonly AlbumResult[];
  readonly artists: readonly ArtistResult[];
  readonly playlists: readonly PlaylistResult[];
}

/**
 * One page of a long list.
 *
 * Modelled explicitly rather than hidden behind an auto-fetching iterator: a
 * library of a thousand albums is normal, the device has finite memory, and the
 * list is virtualised anyway (P6-04) — so the screen wants exactly the window it
 * is showing plus `total`, which is what lets it size the scrollbar before it
 * has fetched the rows.
 */
export interface LibraryPage<T> {
  readonly items: readonly T[];
  /** Echoed back from Spotify, so a caller can tell which window this is. */
  readonly offset: number;
  readonly limit: number;
  /** Rows in the whole collection, including the ones not fetched. */
  readonly total: number;
  /** Offset to request next, or null when this was the last page. */
  readonly nextOffset: number | null;
}

/**
 * The raw shapes, every field `unknown`. Naming them keeps the narrowing below
 * readable without asserting a *value* type we have not actually checked.
 */
interface RawSearch {
  tracks?: unknown;
  albums?: unknown;
  artists?: unknown;
  playlists?: unknown;
}

interface RawPage {
  items?: unknown;
  offset?: unknown;
  limit?: unknown;
  total?: unknown;
  next?: unknown;
}

/*
 * Deliberately duplicated from the playback normaliser rather than exported
 * from core: they are three-line predicates, and promoting them would make
 * core's parsing internals part of a package API that other things depend on.
 */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** Read one field of a nested object that may not be there at all. */
const field = (value: unknown, key: string): unknown => asRecord(value)?.[key];

const asArray = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? (value as readonly unknown[]) : null;

/** Empty strings are treated as absent: Spotify sends them for missing text. */
const asText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asFlag = (value: unknown): boolean => typeof value === 'boolean' && value;

const asCount = (value: unknown): number => Math.max(0, asNumber(value) ?? 0);

/**
 * Widest first, matching the playback normaliser, so `selectArtwork` behaves
 * identically whatever endpoint the artwork arrived from. Spotify documents the
 * order only as "the source order", which in practice is whatever the ingest
 * pipeline produced.
 */
const normaliseImages = (value: unknown): readonly Artwork[] => {
  const list = asArray(value);
  if (list === null) return [];

  const images: Artwork[] = [];
  for (const entry of list) {
    const url = asText(field(entry, 'url'));
    if (url === null) continue;
    images.push({
      url,
      // Null for generated art: playlist mosaics arrive sizeless.
      width: asNumber(field(entry, 'width')),
      height: asNumber(field(entry, 'height')),
    });
  }
  return images.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
};

const artistNames = (value: unknown): readonly string[] => {
  const list = asArray(value);
  if (list === null) return [];

  const names: string[] = [];
  for (const entry of list) {
    const name = asText(field(entry, 'name'));
    if (name !== null) names.push(name);
  }
  return names;
};

/**
 * Title and uri are the two fields without which a row cannot exist: one is
 * what the user reads, the other is what tapping it does.
 */
const identity = (value: unknown): { title: string; uri: string } | null => {
  const title = asText(field(value, 'name'));
  const uri = asText(field(value, 'uri'));
  return title === null || uri === null ? null : { title, uri };
};

const releaseYear = (value: unknown): number | null => {
  const date = asText(value);
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
};

/**
 * A search hit or playlist entry.
 *
 * Podcast episodes reach this through playlists, where they carry a `show`
 * instead of `artists` and hold their own images rather than an album's.
 * They are still rendered as a track row — the UI draws the same line and
 * plays the same uri — so the difference is absorbed rather than modelled.
 */
export const normaliseTrack = (value: unknown): TrackResult | null => {
  const named = identity(value);
  if (named === null) return null;

  const show = asRecord(field(value, 'show'));
  const artists = artistNames(field(value, 'artists'));

  return {
    kind: 'track',
    id: asText(field(value, 'id')),
    uri: named.uri,
    title: named.title,
    subtitle:
      artists.length > 0 ? artists.join(', ') : (asText(field(show, 'name')) ?? ''),
    artists,
    albumName: asText(field(field(value, 'album'), 'name')),
    durationMs: asCount(field(value, 'duration_ms')),
    images: normaliseImages(
      field(field(value, 'album'), 'images') ??
        field(value, 'images') ??
        field(show, 'images'),
    ),
    isLocal: asFlag(field(value, 'is_local')),
  };
};

export const normaliseAlbum = (value: unknown): AlbumResult | null => {
  const named = identity(value);
  if (named === null) return null;

  const artists = artistNames(field(value, 'artists'));
  return {
    kind: 'album',
    id: asText(field(value, 'id')),
    uri: named.uri,
    title: named.title,
    subtitle: artists.join(', '),
    artists,
    images: normaliseImages(field(value, 'images')),
    totalTracks: asCount(field(value, 'total_tracks')),
    releaseYear: releaseYear(field(value, 'release_date')),
  };
};

export const normaliseArtist = (value: unknown): ArtistResult | null => {
  const named = identity(value);
  if (named === null) return null;

  return {
    kind: 'artist',
    id: asText(field(value, 'id')),
    uri: named.uri,
    title: named.title,
    // An artist has nothing dependable for a second line — genres are often
    // empty and follower counts are noise on a list row. The UI draws one line.
    subtitle: '',
    images: normaliseImages(field(value, 'images')),
  };
};

export const normalisePlaylist = (value: unknown): PlaylistResult | null => {
  const named = identity(value);
  if (named === null) return null;

  const ownerName = asText(field(field(value, 'owner'), 'display_name'));
  return {
    kind: 'playlist',
    id: asText(field(value, 'id')),
    uri: named.uri,
    title: named.title,
    subtitle: ownerName ?? '',
    ownerName,
    images: normaliseImages(field(value, 'images')),
    totalTracks: asCount(field(field(value, 'tracks'), 'total')),
  };
};

/**
 * `GET /me/albums` wraps each album in a save record — the album itself is one
 * level down, next to `added_at`. `GET /me/playlists` does not wrap. Reading
 * the saved-albums page as if it held albums yields fifty rows of nothing,
 * which is why the unwrapping lives here next to the shapes it belongs to.
 */
export const readSavedAlbum = (value: unknown): AlbumResult | null =>
  normaliseAlbum(field(value, 'album'));

/**
 * A playlist entry, unwrapped from its `{ added_at, added_by, track }` record.
 * `track` is null for an item that has since left the catalogue; that row is
 * dropped rather than drawn as a dead line the user cannot play.
 */
export const readPlaylistTrack = (value: unknown): TrackResult | null =>
  normaliseTrack(field(value, 'track'));

/** Map a Spotify `items` array through a reader, dropping what it rejects. */
const collect = <T>(value: unknown, read: (raw: unknown) => T | null): readonly T[] => {
  const list = asArray(value);
  if (list === null) return [];

  const items: T[] = [];
  for (const entry of list) {
    const item = read(entry);
    if (item !== null) items.push(item);
  }
  return items;
};

/** The window Spotify was asked for, used to fill in anything it omits. */
export interface PageWindow {
  readonly offset: number;
  readonly limit: number;
}

/**
 * Where the next page starts, or null at the end.
 *
 * Advances by the number of rows Spotify *sent*, not the number we kept.
 * Paging by the filtered count would skip a real album every time a page
 * contained an unreadable one — a silent hole in the list, and the kind of bug
 * that only shows up in a library long enough that nobody scrolls to the end.
 */
const nextOffsetFor = (
  offset: number,
  sent: number,
  total: number,
  next: unknown,
): number | null => {
  // No rows came back, so there is no cursor to advance to. This is also the
  // guard that stops a caller looping forever on a page that is always empty.
  if (sent === 0) return null;
  // Spotify's own paging link, when present, is the authority on being done.
  if (next === null) return null;
  const candidate = offset + sent;
  return candidate < total ? candidate : null;
};

export const normalisePage = <T>(
  body: unknown,
  read: (raw: unknown) => T | null,
  requested: PageWindow,
): Result<LibraryPage<T>, JoshifyError> => {
  const record = asRecord(body);
  if (record === null) {
    return err(createError('unexpected', 'library page was not an object'));
  }
  const raw: RawPage = record;

  const items = asArray(raw.items);
  // Distinct from an empty array, which is an ordinary answer for the last page
  // of a list or an empty library. A missing `items` means this is not a paging
  // object at all, and guessing at that would hide a real bug.
  if (items === null) {
    return err(createError('unexpected', 'library page had no items array'));
  }

  const offset = asNumber(raw.offset) ?? requested.offset;
  // Without a total the only defensible claim is that the rows in hand exist;
  // that makes `nextOffset` null, so a caller pages one window and stops rather
  // than walking off the end of a list whose length nobody knows.
  const total = asNumber(raw.total) ?? offset + items.length;

  return ok({
    items: collect(items, read),
    offset,
    limit: asNumber(raw.limit) ?? requested.limit,
    total,
    nextOffset: nextOffsetFor(offset, items.length, total, raw.next),
  });
};

export const emptySearchResults = (query: string): SearchResults => ({
  query,
  tracks: [],
  albums: [],
  artists: [],
  playlists: [],
});

/**
 * Normalise a `/v1/search` body.
 *
 * Every section is optional: Spotify only returns the types that were asked
 * for, and a type with no matches comes back as an empty `items` array. Neither
 * is an error — "no results" is a thing the screen draws, not a fault.
 */
export const normaliseSearchResults = (
  body: unknown,
  query: string,
): Result<SearchResults, JoshifyError> => {
  const record: RawSearch | null = asRecord(body);
  if (record === null) {
    return err(createError('unexpected', 'search response was not an object'));
  }

  return ok({
    query,
    tracks: collect(field(record.tracks, 'items'), normaliseTrack),
    albums: collect(field(record.albums, 'items'), normaliseAlbum),
    artists: collect(field(record.artists, 'items'), normaliseArtist),
    playlists: collect(field(record.playlists, 'items'), normalisePlaylist),
  });
};
