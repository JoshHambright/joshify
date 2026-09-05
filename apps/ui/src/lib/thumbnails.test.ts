import { describe, expect, it } from 'vitest';
import type { Artwork } from '@joshify/core';
import {
  createThumbnailCache,
  libraryRows,
  pickThumbnail,
  rowMeta,
  searchRows,
  type AlbumResult,
  type ArtistResult,
  type LibraryItem,
  type LibraryPage,
  type PlaylistResult,
  type SearchResults,
  type TrackResult,
} from './thumbnails.js';

const images: readonly Artwork[] = [
  { url: 'https://i/640', width: 640, height: 640 },
  { url: 'https://i/300', width: 300, height: 300 },
  { url: 'https://i/64', width: 64, height: 64 },
];

const track = (over: Partial<TrackResult> = {}): TrackResult => ({
  kind: 'track',
  id: 't1',
  uri: 'spotify:track:t1',
  title: 'Velocity Division',
  subtitle: 'Nitrous Cartel',
  images,
  artists: ['Nitrous Cartel'],
  albumName: 'Redline',
  durationMs: 211_000,
  isLocal: false,
  ...over,
});

const album = (over: Partial<AlbumResult> = {}): AlbumResult => ({
  kind: 'album',
  id: 'a1',
  uri: 'spotify:album:a1',
  title: 'Redline',
  subtitle: 'Nitrous Cartel',
  images,
  artists: ['Nitrous Cartel'],
  totalTracks: 11,
  releaseYear: 1997,
  ...over,
});

const artist: ArtistResult = {
  kind: 'artist',
  id: 'r1',
  uri: 'spotify:artist:r1',
  title: 'Nitrous Cartel',
  subtitle: '',
  images,
};

const playlist = (over: Partial<PlaylistResult> = {}): PlaylistResult => ({
  kind: 'playlist',
  id: 'p1',
  uri: 'spotify:playlist:p1',
  title: 'Late Shift',
  subtitle: 'Josh',
  images,
  ownerName: 'Josh',
  totalTracks: 142,
  ...over,
});

const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  query: 'nitrous',
  tracks: [],
  albums: [],
  artists: [],
  playlists: [],
  ...over,
});

const page = <T>(items: readonly T[]): LibraryPage<T> => ({
  items,
  offset: 0,
  limit: 50,
  total: items.length,
  nextOffset: null,
});

describe('flattening results into rows', () => {
  it('leads with tracks and heads each group', () => {
    const rows = searchRows(
      results({ tracks: [track()], albums: [album()], artists: [artist] }),
    );

    expect(rows.map((row) => (row.kind === 'header' ? row.label : '·'))).toEqual([
      'Tracks',
      '·',
      'Albums',
      '·',
      'Artists',
      '·',
    ]);
  });

  // A heading over nothing reads as a group that failed to load rather than one
  // with no matches.
  it('draws no heading for a group with no matches', () => {
    const rows = searchRows(results({ playlists: [playlist()] }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Playlists' });
  });

  it('is empty before the first search, rather than a list of headings', () => {
    expect(searchRows(null)).toEqual([]);
    expect(searchRows(results())).toEqual([]);
    expect(libraryRows(null)).toEqual([]);
  });

  // Two rows sharing a key would make the list reuse the wrong DOM node as it
  // scrolls — the same album under two different titles.
  it('gives every row a key of its own, even for a repeated uri', () => {
    const rows = searchRows(results({ tracks: [track(), track()], albums: [album()] }));
    const ids = rows.map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows saved albums above playlists when the field is empty', () => {
    const rows = libraryRows({
      albums: page([album()]),
      playlists: page([playlist()]),
    });

    expect(
      rows.map((row) => (row.kind === 'header' ? row.label : row.item.title)),
    ).toEqual(['Saved albums', 'Redline', 'Playlists', 'Late Shift']);
  });
});

describe('what a row says on the right', () => {
  it.each<[string, LibraryItem, string]>([
    ['track', track(), '3:31'],
    ['album', album(), '1997'],
    ['playlist', playlist(), '142 tracks'],
    ['artist', artist, ''],
  ])('reads a %s', (_kind, item, expected) => {
    expect(rowMeta(item)).toBe(expected);
  });

  // A reissue may carry no usable date at all, and an empty cell is honest
  // where a guessed year is not.
  it('says nothing rather than guessing a missing year', () => {
    expect(rowMeta(album({ releaseYear: null }))).toBe('');
  });
});

describe('picking a thumbnail', () => {
  // Picking by position is the assumption that puts a 640px sleeve behind a
  // 56px box the day the payload's order changes.
  it('takes the smallest image that is still big enough', () => {
    expect(pickThumbnail(images)).toBe('https://i/64');
    expect(pickThumbnail(images, 320)).toBe('https://i/640');
  });

  it('falls back to the largest there is rather than upscaling nothing', () => {
    expect(pickThumbnail([{ url: 'https://i/32', width: 32, height: 32 }])).toBe(
      'https://i/32',
    );
  });

  // A real answer, not a failure: a local file has no artwork, and the row
  // draws a plain tint for it rather than a broken-image glyph.
  it('is null when there is no artwork at all', () => {
    expect(pickThumbnail([])).toBeNull();
  });
});

describe('the thumbnail cache', () => {
  it('resolves a url once and remembers it', () => {
    const cache = createThumbnailCache();

    expect(cache.resolve('a', images)).toBe('https://i/64');
    expect(cache.resolve('a', [])).toBe('https://i/64');
    expect(cache.size()).toBe(1);
  });

  it('remembers that a row has already been seen, so it does not flash again', () => {
    const cache = createThumbnailCache();
    cache.resolve('a', images);

    expect(cache.isLoaded('a')).toBe(false);
    cache.markLoaded('a');
    expect(cache.isLoaded('a')).toBe(true);
  });

  it('has nothing to say about a row it has never drawn', () => {
    const cache = createThumbnailCache();
    cache.markLoaded('never-resolved');

    expect(cache.isLoaded('never-resolved')).toBe(false);
    expect(cache.size()).toBe(0);
  });

  // The bound is the whole point: the kiosk runs for weeks, and a thousand-album
  // scroll must not leave a thousand entries behind.
  it('evicts the least recently used entry once it is full', () => {
    const cache = createThumbnailCache({ capacity: 3 });
    for (const key of ['a', 'b', 'c', 'd']) cache.resolve(key, images);

    expect(cache.size()).toBe(3);
    expect(cache.keys()).toEqual(['b', 'c', 'd']);
  });

  // Scrolling back is the case this exists for: a user who overshoots and
  // flicks up must not watch the rows they just passed reload.
  it('spares a row that was used again on the way past', () => {
    const cache = createThumbnailCache({ capacity: 3 });
    cache.resolve('a', images);
    cache.resolve('b', images);
    cache.resolve('c', images);
    cache.resolve('a', images);
    cache.resolve('d', images);

    expect(cache.keys()).toEqual(['c', 'a', 'd']);
  });

  it('forgets that an evicted row was ever loaded', () => {
    const cache = createThumbnailCache({ capacity: 1 });
    cache.resolve('a', images);
    cache.markLoaded('a');
    cache.resolve('b', images);

    expect(cache.isLoaded('a')).toBe(false);
  });

  // Reading a row during a render is not a scroll, so it must not reorder the
  // queue — otherwise the row on screen protects itself and nothing ages out.
  it('does not count a loaded check as a use', () => {
    const cache = createThumbnailCache({ capacity: 2 });
    cache.resolve('a', images);
    cache.resolve('b', images);
    cache.isLoaded('a');
    cache.resolve('c', images);

    expect(cache.keys()).toEqual(['b', 'c']);
  });

  it('holds at least one row however small it is asked to be', () => {
    const cache = createThumbnailCache({ capacity: 0 });
    cache.resolve('a', images);

    expect(cache.size()).toBe(1);
  });
});
