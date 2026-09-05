import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSearchSource,
  type FetchLike,
  type SearchSourceState,
} from './search-source.js';
import type { AlbumResult, PlaylistResult } from './thumbnails.js';

const album = (id: string): AlbumResult => ({
  kind: 'album',
  id,
  uri: `spotify:album:${id}`,
  title: `Album ${id}`,
  subtitle: 'Nitrous Cartel',
  images: [],
  artists: ['Nitrous Cartel'],
  totalTracks: 11,
  releaseYear: 1997,
});

const playlist = (id: string): PlaylistResult => ({
  kind: 'playlist',
  id,
  uri: `spotify:playlist:${id}`,
  title: `Playlist ${id}`,
  subtitle: 'Josh',
  images: [],
  ownerName: 'Josh',
  totalTracks: 12,
});

const page = <T>(items: readonly T[], over: Record<string, unknown> = {}) => ({
  items,
  offset: 0,
  limit: 50,
  total: items.length,
  nextOffset: null,
  ...over,
});

const results = (query: string) => ({
  status: 'results',
  results: { query, tracks: [], albums: [album('a')], artists: [], playlists: [] },
});

type Answer = { ok: boolean; status: number; body?: unknown } | 'throws';

/**
 * A fetch whose answers are keyed by path fragment and can be held open, so a
 * test can make a slow request land after a fast one — which is the whole
 * reason this module has a fence.
 */
const fakeFetch = () => {
  const urls: string[] = [];
  const routes = new Map<string, Answer>();
  const held: { url: string; settle: () => void }[] = [];
  let holding = false;

  // Longest fragment wins: `/api/library/albums` must not be caught by the
  // `/api/library` route just because it was registered first.
  const answerFor = (url: string): Answer => {
    const matches = [...routes.entries()]
      .filter(([fragment]) => url.includes(fragment))
      .sort(([a], [b]) => b.length - a.length);
    return matches[0]?.[1] ?? { ok: true, status: 200, body: {} };
  };

  const fetch: FetchLike = (url) => {
    urls.push(url);
    const answer = answerFor(url);
    const respond = () => {
      if (answer === 'throws') return Promise.reject(new Error('refused'));
      return Promise.resolve({
        ok: answer.ok,
        status: answer.status,
        json: () =>
          answer.body === undefined
            ? Promise.reject(new Error('no body'))
            : Promise.resolve(answer.body),
      });
    };
    if (!holding) return respond();
    return new Promise((resolve, reject) => {
      held.push({
        url,
        settle: () => {
          respond().then(resolve, reject);
        },
      });
    });
  };

  return {
    fetch,
    urls,
    route: (fragment: string, answer: Answer) => routes.set(fragment, answer),
    hold: () => {
      holding = true;
    },
    release: (index: number) => {
      held[index]?.settle();
      return Promise.resolve();
    },
  };
};

let net: ReturnType<typeof fakeFetch>;
const build = () => createSearchSource({ fetch: net.fetch });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeEach(() => {
  net = fakeFetch();
});

describe('an empty query', () => {
  // Empty shows the library, not an empty result set (D-031).
  it('loads both halves of the library in one request', async () => {
    net.route('/api/library', {
      ok: true,
      status: 200,
      body: { albums: page([album('a')]), playlists: page([playlist('p')]) },
    });
    const source = build();

    await source.query('');

    expect(net.urls).toEqual(['/api/library']);
    expect(source.current().library?.albums.items).toHaveLength(1);
    expect(source.current().library?.playlists.items).toHaveLength(1);
    expect(source.current().pending).toBe(false);
  });

  it('treats whitespace as empty rather than searching for it', async () => {
    const source = build();
    await source.query('   ');

    expect(net.urls).toEqual(['/api/library']);
  });

  it('clears stale results when the field is emptied', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('aphex') });
    net.route('/api/library', {
      ok: true,
      status: 200,
      body: { albums: page([]), playlists: page([]) },
    });
    const source = build();
    await source.query('aphex');
    expect(source.current().results).not.toBeNull();

    await source.query('');

    expect(source.current().results).toBeNull();
  });

  it('reports a library body it cannot read rather than rendering nothing', async () => {
    net.route('/api/library', { ok: true, status: 200, body: { albums: 'lots' } });
    const source = build();

    await source.query('');

    expect(source.current().library).toBeNull();
    expect(source.current().problem).not.toBeNull();
  });
});

describe('searching', () => {
  it('sends the query and holds the results', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('aphex') });
    const source = build();

    await source.query('aphex');

    expect(net.urls[0]).toBe('/api/search?q=aphex');
    expect(source.current().results?.query).toBe('aphex');
  });

  it('escapes a query that would otherwise break the URL', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('a&b c') });
    const source = build();

    await source.query('a&b c');

    expect(net.urls[0]).toBe('/api/search?q=a%26b%20c');
  });

  // The whole reason this module exists. The server fences its own session;
  // this guards the trip back, where responses can still overtake each other.
  it('ignores an answer for a query the viewer has moved on from', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('bea') });
    net.hold();
    const source = build();

    const slow = source.query('bea');
    net.route('/api/search', { ok: true, status: 200, body: results('beatles') });
    const fast = source.query('beatles');

    // The fast query lands first, then the slow one for the older query.
    await net.release(1);
    await fast;
    await net.release(0);
    await slow;
    await settle();

    expect(source.current().results?.query).toBe('beatles');
  });

  // Being overtaken is the normal outcome of typing, not a failure — rendering
  // it as one would flash a fault on every letter.
  it('treats superseded as a non-event, not an error', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('aphex') });
    const source = build();
    await source.query('aphex');

    net.route('/api/search', { ok: true, status: 200, body: { status: 'superseded' } });
    await source.query('aphex twin');

    expect(source.current().problem).toBeNull();
    expect(source.current().results?.query).toBe('aphex'); // last real answer stands
    expect(source.current().pending).toBe(false);
  });

  it('reports a failed search without discarding what is on screen', async () => {
    net.route('/api/search', { ok: true, status: 200, body: results('aphex') });
    const source = build();
    await source.query('aphex');

    net.route('/api/search', {
      ok: false,
      status: 429,
      body: { error: { kind: 'rate-limited', message: 'slow down' } },
    });
    await source.query('aphex twin');

    expect(source.current().problem?.kind).toBe('rate-limited');
    expect(source.current().results?.query).toBe('aphex');
  });

  it('reports a network failure when the request never lands', async () => {
    net.route('/api/search', 'throws');
    const source = build();

    await source.query('aphex');

    expect(source.current().problem?.kind).toBe('network');
  });

  it('reports a malformed answer rather than rendering half of it', async () => {
    net.route('/api/search', {
      ok: true,
      status: 200,
      body: { status: 'results', results: { query: 'aphex', tracks: 'lots' } },
    });
    const source = build();

    await source.query('aphex');

    expect(source.current().results).toBeNull();
    expect(source.current().problem).not.toBeNull();
  });
});

describe('paging the library', () => {
  const loaded = async () => {
    net.route('/api/library', {
      ok: true,
      status: 200,
      body: {
        albums: page([album('a')], { total: 2, nextOffset: 1 }),
        playlists: page([playlist('p')], { total: 2, nextOffset: 1 }),
      },
    });
    const source = build();
    await source.query('');
    return source;
  };

  it('appends the next page rather than replacing what is shown', async () => {
    const source = await loaded();
    net.route('/api/library/albums', {
      ok: true,
      status: 200,
      body: page([album('b')], { offset: 1, total: 2 }),
    });

    await source.loadMore('albums', 1);

    expect(source.current().library?.albums.items.map((a) => a.id)).toEqual(['a', 'b']);
    // The window still starts where the caller's does, so length and offset agree.
    expect(source.current().library?.albums.offset).toBe(0);
  });

  it('appends to the section it was asked for and no other', async () => {
    const source = await loaded();
    net.route('/api/library/playlists', {
      ok: true,
      status: 200,
      body: page([playlist('q')], { offset: 1, total: 2 }),
    });

    await source.loadMore('playlists', 1);

    expect(source.current().library?.playlists.items).toHaveLength(2);
    expect(source.current().library?.albums.items).toHaveLength(1);
  });

  // A shorter list is far better than an empty one.
  it('leaves the rows on screen alone when a page fails', async () => {
    const source = await loaded();
    net.route('/api/library/albums', { ok: false, status: 500 });

    await source.loadMore('albums', 1);

    expect(source.current().library?.albums.items).toHaveLength(1);
    expect(source.current().problem).not.toBeNull();
  });

  it('does nothing when there is no library to append to', async () => {
    const source = build();
    await source.loadMore('albums', 1);

    expect(net.urls).toEqual([]);
  });
});

describe('subscribers', () => {
  it('gets the current value immediately and on every change', async () => {
    net.route('/api/library', {
      ok: true,
      status: 200,
      body: { albums: page([]), playlists: page([]) },
    });
    const source = build();
    const seen: SearchSourceState[] = [];
    const off = source.subscribe((v) => seen.push(v));

    expect(seen).toHaveLength(1);
    await source.query('');
    expect(seen.length).toBeGreaterThan(1);

    off();
    const after = seen.length;
    await source.query('');
    expect(seen).toHaveLength(after);
  });
});
