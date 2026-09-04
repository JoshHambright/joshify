import { describe, expect, it } from 'vitest';
import { isOk, selectArtwork, type JoshifyError, type Result } from '@joshify/core';
import {
  emptySearchResults,
  normaliseAlbum,
  normaliseArtist,
  normalisePage,
  normalisePlaylist,
  normaliseSearchResults,
  normaliseTrack,
  readPlaylistTrack,
  readSavedAlbum,
  type LibraryPage,
  type SearchResults,
} from './normalise.js';

const unwrap = <T>(result: Result<T, JoshifyError>): T => {
  if (!isOk(result)) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
};

const expectFailure = <T>(result: Result<T, JoshifyError>): JoshifyError => {
  if (isOk(result)) throw new Error('expected a failure');
  return result.error;
};

const IMAGES = [
  { url: 'small.jpg', width: 64, height: 64 },
  { url: 'large.jpg', width: 640, height: 640 },
];

describe('tracks', () => {
  it('flattens a search hit into one row', () => {
    const track = normaliseTrack({
      name: 'Come Together',
      uri: 'spotify:track:1',
      id: '1',
      duration_ms: 259_000,
      is_local: false,
      artists: [{ name: 'The Beatles' }],
      album: { name: 'Abbey Road', images: IMAGES },
    });

    expect(track).toEqual({
      kind: 'track',
      id: '1',
      uri: 'spotify:track:1',
      title: 'Come Together',
      subtitle: 'The Beatles',
      artists: ['The Beatles'],
      albumName: 'Abbey Road',
      durationMs: 259_000,
      isLocal: false,
      images: [
        { url: 'large.jpg', width: 640, height: 640 },
        { url: 'small.jpg', width: 64, height: 64 },
      ],
    });
  });

  it('joins every credited artist for the subtitle', () => {
    const track = normaliseTrack({
      name: 'Under Pressure',
      uri: 'spotify:track:2',
      artists: [{ name: 'Queen' }, { name: 'David Bowie' }, { unnamed: true }],
    });
    expect(track?.subtitle).toBe('Queen, David Bowie');
  });

  // A local file: no id, no album, an artists array that is present and empty,
  // and no artwork anywhere. Every one of those is the shape a naive reader
  // throws on.
  it('survives a local file with no id, album or artwork', () => {
    const track = normaliseTrack({
      name: 'demo-mix-final-2.mp3',
      uri: 'spotify:local:::demo-mix-final-2:214',
      id: null,
      artists: [],
      album: null,
      is_local: true,
    });

    expect(track).toMatchObject({
      id: null,
      subtitle: '',
      albumName: null,
      images: [],
      isLocal: true,
      durationMs: 0,
    });
  });

  // Episodes reach us through playlists, where they carry a show instead of
  // artists and hold artwork on the show. Reading `album.images` — the obvious
  // thing — loses the picture for every podcast in the list.
  it('reads an episode in a playlist through its show', () => {
    const track = normaliseTrack({
      name: 'Episode 12',
      uri: 'spotify:episode:9',
      type: 'episode',
      show: { name: 'A Podcast', images: IMAGES },
    });

    expect(track).toMatchObject({
      subtitle: 'A Podcast',
      images: [{ url: 'large.jpg', width: 640, height: 640 }, { url: 'small.jpg' }],
    });
  });

  it('rejects an entry with no uri to play', () => {
    expect(normaliseTrack({ name: 'Ghost' })).toBeNull();
    expect(normaliseTrack({ uri: 'spotify:track:3' })).toBeNull();
    expect(normaliseTrack(null)).toBeNull();
  });
});

describe('albums, artists and playlists', () => {
  it('flattens an album', () => {
    const album = normaliseAlbum({
      name: 'Abbey Road',
      uri: 'spotify:album:1',
      id: '1',
      total_tracks: 17,
      release_date: '1969-09-26',
      artists: [{ name: 'The Beatles' }],
      images: IMAGES,
    });

    expect(album).toMatchObject({
      kind: 'album',
      title: 'Abbey Road',
      subtitle: 'The Beatles',
      totalTracks: 17,
      releaseYear: 1969,
    });
  });

  // `release_date` is precision-tagged: the same field is a year, a month or a
  // day depending on what the label filed, and reissues are often the vaguest.
  it('reads the year out of any release-date precision', () => {
    const dated = (release_date: unknown): number | null =>
      normaliseAlbum({ name: 'a', uri: 'u', release_date })?.releaseYear ?? null;

    expect(dated('1969-09-26')).toBe(1969);
    expect(dated('1969-09')).toBe(1969);
    expect(dated('1969')).toBe(1969);
    expect(dated(undefined)).toBeNull();
    expect(dated('unknown')).toBeNull();
  });

  it('flattens an artist, which has no second line to show', () => {
    expect(normaliseArtist({ name: 'The Beatles', uri: 'spotify:artist:1' })).toEqual({
      kind: 'artist',
      id: null,
      uri: 'spotify:artist:1',
      title: 'The Beatles',
      subtitle: '',
      images: [],
    });
  });

  it('flattens a playlist and credits its owner', () => {
    expect(
      normalisePlaylist({
        name: 'Kitchen',
        uri: 'spotify:playlist:1',
        id: '1',
        owner: { display_name: 'Josh' },
        tracks: { total: 214 },
        images: IMAGES,
      }),
    ).toMatchObject({ kind: 'playlist', ownerName: 'Josh', subtitle: 'Josh', totalTracks: 214 });
  });

  // A collaborative playlist owned by an account with no display name, and the
  // mosaic artwork Spotify generates, which arrives with null dimensions.
  it('survives a playlist with no owner name and sizeless mosaic art', () => {
    const playlist = normalisePlaylist({
      name: 'Shared',
      uri: 'spotify:playlist:2',
      owner: {},
      images: [{ url: 'mosaic.jpg', width: null, height: null }],
    });

    expect(playlist).toMatchObject({
      ownerName: null,
      subtitle: '',
      totalTracks: 0,
      images: [{ url: 'mosaic.jpg', width: null, height: null }],
    });
  });

  it('drops an image entry with no url', () => {
    const artist = normaliseArtist({
      name: 'a',
      uri: 'u',
      images: [{ width: 64 }, { url: 'ok.jpg', width: 64 }],
    });
    expect(artist?.images).toEqual([{ url: 'ok.jpg', width: 64, height: null }]);
  });

  it('hands the whole image list to whoever needs a specific size', () => {
    const album = normaliseAlbum({ name: 'a', uri: 'u', images: IMAGES });
    expect(selectArtwork(album?.images ?? [], 300)?.url).toBe('large.jpg');
    expect(selectArtwork(album?.images ?? [], 64)?.url).toBe('small.jpg');
  });
});

describe('search responses', () => {
  it('normalises every section it was given', () => {
    const results = unwrap(
      normaliseSearchResults(
        {
          tracks: { items: [{ name: 't', uri: 'spotify:track:1' }] },
          albums: { items: [{ name: 'a', uri: 'spotify:album:1' }] },
          artists: { items: [{ name: 'r', uri: 'spotify:artist:1' }] },
          playlists: { items: [{ name: 'p', uri: 'spotify:playlist:1' }] },
        },
        'beatles',
      ),
    );

    expect(results.query).toBe('beatles');
    expect([
      results.tracks.length,
      results.albums.length,
      results.artists.length,
      results.playlists.length,
    ]).toEqual([1, 1, 1, 1]);
  });

  // Spotify has shipped literal nulls inside `playlists.items` for years. One
  // of them must cost the user that row, not the entire results screen.
  it('drops a null row rather than failing the whole response', () => {
    const results = unwrap(
      normaliseSearchResults(
        {
          playlists: {
            items: [null, { name: 'Kitchen', uri: 'spotify:playlist:1' }, { name: 'x' }],
          },
        },
        'kitchen',
      ),
    );

    expect(results.playlists.map((entry) => entry.title)).toEqual(['Kitchen']);
  });

  it('treats a type Spotify did not return as empty, not missing', () => {
    const results: SearchResults = unwrap(
      normaliseSearchResults({ tracks: { items: [] } }, 'zzz'),
    );
    expect(results).toEqual(emptySearchResults('zzz'));
  });

  it('reports a response that is not an object', () => {
    expect(expectFailure(normaliseSearchResults('nope', 'q')).kind).toBe('unexpected');
  });
});

describe('paging', () => {
  const page = (body: unknown): Result<LibraryPage<string>, JoshifyError> =>
    normalisePage(body, (raw) => (typeof raw === 'string' ? raw : null), {
      offset: 0,
      limit: 2,
    });

  it('carries the window and the total the virtualiser needs', () => {
    expect(
      unwrap(page({ items: ['a', 'b'], offset: 0, limit: 2, total: 5, next: 'url' })),
    ).toEqual({ items: ['a', 'b'], offset: 0, limit: 2, total: 5, nextOffset: 2 });
  });

  it('stops at the last page', () => {
    expect(
      unwrap(page({ items: ['e'], offset: 4, limit: 2, total: 5, next: null })).nextOffset,
    ).toBeNull();
  });

  it('stops when the window reaches the total even without a paging link', () => {
    expect(unwrap(page({ items: ['a', 'b'], offset: 3, total: 5 })).nextOffset).toBeNull();
  });

  // The hole this prevents: a page of 50 that contains one unreadable row
  // yields 49 items. Advancing by 49 re-fetches a row already shown and skips
  // one that was never shown — and only ever in libraries long enough that
  // nobody scrolls far enough to notice.
  it('advances by the rows Spotify sent, not the rows we kept', () => {
    const result = unwrap(page({ items: ['a', null, 'c'], offset: 0, total: 9 }));
    expect(result.items).toEqual(['a', 'c']);
    expect(result.nextOffset).toBe(3);
  });

  it('ends on an empty page rather than asking for the same one forever', () => {
    expect(unwrap(page({ items: [], offset: 8, total: 99 })).nextOffset).toBeNull();
  });

  it('falls back to the requested window when Spotify omits it', () => {
    expect(unwrap(page({ items: ['a'] }))).toEqual({
      items: ['a'],
      offset: 0,
      limit: 2,
      total: 1,
      nextOffset: null,
    });
  });

  it('reports an envelope that is not a page', () => {
    expect(expectFailure(page(null)).kind).toBe('unexpected');
    expect(expectFailure(page({ total: 5 })).kind).toBe('unexpected');
  });
});

describe('the wrappers Spotify puts around library rows', () => {
  // `/me/albums` nests the album next to `added_at`; reading the page as if it
  // held albums yields fifty rows of nothing.
  it('unwraps a saved album from its save record', () => {
    expect(
      readSavedAlbum({
        added_at: '2020-01-01T00:00:00Z',
        album: { name: 'Abbey Road', uri: 'spotify:album:1' },
      })?.title,
    ).toBe('Abbey Road');
    expect(readSavedAlbum({ added_at: '2020-01-01T00:00:00Z' })).toBeNull();
  });

  // A track pulled from the catalogue still occupies its slot in the playlist,
  // as `{ track: null }`. It is dropped rather than drawn as a dead row.
  it('unwraps a playlist entry and drops a removed track', () => {
    expect(
      readPlaylistTrack({ added_at: 'x', track: { name: 'a', uri: 'spotify:track:1' } })
        ?.title,
    ).toBe('a');
    expect(readPlaylistTrack({ added_at: 'x', track: null })).toBeNull();
  });
});
