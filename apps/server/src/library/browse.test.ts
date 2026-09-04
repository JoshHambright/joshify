import { describe, expect, it } from 'vitest';
import { createError, isOk, type JoshifyError, type Result } from '@joshify/core';
import { createFakeClient, type FakeSpotifyClient } from './testing/fake-client.js';
import {
  createLibraryBrowser,
  MAX_PAGE_LIMIT,
  type LibraryBrowser,
  type LibraryBrowserOptions,
} from './browse.js';

interface Harness {
  readonly browser: LibraryBrowser;
  readonly client: FakeSpotifyClient;
}

const harness = (options: LibraryBrowserOptions = {}): Harness => {
  const client = createFakeClient();
  return { client, browser: createLibraryBrowser(client, options) };
};

const unwrap = <T>(result: Result<T, JoshifyError>): T => {
  if (!isOk(result)) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
};

const expectFailure = <T>(result: Result<T, JoshifyError>): JoshifyError => {
  if (isOk(result)) throw new Error('expected a failure');
  return result.error;
};

const savedAlbumsBody = (
  offset: number,
  total: number,
  next: string | null,
): unknown => ({
  offset,
  limit: 2,
  total,
  next,
  items: [
    {
      added_at: '2021-04-01T00:00:00Z',
      album: {
        name: 'Abbey Road',
        uri: 'spotify:album:1',
        id: '1',
        total_tracks: 17,
        release_date: '1969-09-26',
        artists: [{ name: 'The Beatles' }],
        images: [{ url: 'a.jpg', width: 640, height: 640 }],
      },
    },
    {
      added_at: '2021-04-02T00:00:00Z',
      album: { name: 'Revolver', uri: 'spotify:album:2', artists: [] },
    },
  ],
});

describe('saved albums', () => {
  it('asks for one window and normalises the save records inside it', async () => {
    const { browser, client } = harness();
    client.queue(savedAlbumsBody(0, 4, 'https://api.spotify.com/next'));

    const page = unwrap(await browser.savedAlbums());
    expect(client.paths).toEqual(['/v1/me/albums?offset=0&limit=50']);
    expect(page.items.map((album) => album.title)).toEqual(['Abbey Road', 'Revolver']);
    expect(page.items[0]?.kind).toBe('album');
    expect(page.total).toBe(4);
    expect(page.nextOffset).toBe(2);
  });

  it('fetches the next window from the cursor the last page gave it', async () => {
    const { browser, client } = harness();
    client.queue(savedAlbumsBody(2, 4, null));

    const page = unwrap(await browser.savedAlbums({ offset: 2, limit: 2 }));
    expect(client.paths).toEqual(['/v1/me/albums?offset=2&limit=2']);
    expect(page.nextOffset).toBeNull();
  });

  // Without a market Spotify lists albums that cannot be played where the
  // device is, so the row is offered and then fails at play time.
  it('passes the configured market through', async () => {
    const { browser, client } = harness({ market: 'GB' });
    client.queue(savedAlbumsBody(0, 2, null));

    unwrap(await browser.savedAlbums());
    expect(client.paths[0]).toBe('/v1/me/albums?offset=0&limit=50&market=GB');
  });

  it('takes a smaller default page size when configured', async () => {
    const { browser, client } = harness({ limit: 10 });
    client.queue(savedAlbumsBody(0, 2, null));

    unwrap(await browser.savedAlbums());
    expect(client.paths[0]).toContain('limit=10');
  });

  it('passes a client failure through untouched', async () => {
    const { browser, client } = harness();
    client.queueFailure(createError('auth', 'token is dead'));

    expect(expectFailure(await browser.savedAlbums()).kind).toBe('auth');
  });

  it('reports a body that is not a page', async () => {
    const { browser, client } = harness();
    client.queue({ albums: [] });

    expect(expectFailure(await browser.savedAlbums()).kind).toBe('unexpected');
  });
});

describe('playlists', () => {
  it('lists them with the same paging shape', async () => {
    const { browser, client } = harness();
    client.queue({
      offset: 0,
      limit: 50,
      total: 1,
      next: null,
      items: [
        {
          name: 'Kitchen',
          uri: 'spotify:playlist:1',
          id: '1',
          owner: { display_name: 'Josh' },
          tracks: { total: 214 },
        },
      ],
    });

    const page = unwrap(await browser.playlists());
    expect(client.paths).toEqual(['/v1/me/playlists?offset=0&limit=50']);
    expect(page.items[0]).toMatchObject({ kind: 'playlist', ownerName: 'Josh' });
  });

  // `market` is not a parameter this endpoint takes, and Spotify ignores what
  // it does not recognise rather than rejecting it (D-026) — so a stray one
  // would sit in the request looking deliberate and doing nothing.
  it('leaves the market off a request that has no use for it', async () => {
    const { browser, client } = harness({ market: 'GB' });
    client.queue({ items: [], total: 0, next: null });

    unwrap(await browser.playlists());
    expect(client.paths[0]).not.toContain('market');
  });
});

describe('playlist detail', () => {
  it('asks for episodes as well as tracks', async () => {
    const { browser, client } = harness({ market: 'GB' });
    client.queue({
      offset: 0,
      limit: 50,
      total: 2,
      next: null,
      items: [
        { added_at: 'x', track: { name: 'Come Together', uri: 'spotify:track:1' } },
        // Pulled from the catalogue, but still holding its slot.
        { added_at: 'x', track: null },
      ],
    });

    const page = unwrap(await browser.playlistTracks('37i9dQ'));
    expect(client.paths).toEqual([
      '/v1/playlists/37i9dQ/tracks?offset=0&limit=50&market=GB&additional_types=track%2Cepisode',
    ]);
    expect(page.items.map((track) => track.title)).toEqual(['Come Together']);
    // The removed row still counts towards the cursor, or the next page skips one.
    expect(page.total).toBe(2);
  });

  it('escapes an id that would otherwise change the path', async () => {
    const { browser, client } = harness();
    client.queue({ items: [], total: 0, next: null });

    unwrap(await browser.playlistTracks('a/b'));
    expect(client.paths[0]).toContain('/v1/playlists/a%2Fb/tracks');
  });

  // A blank id builds `/v1/playlists//tracks`, which answers 404 — and our
  // taxonomy reads a 404 as "no active device", so the screen would tell the
  // user to choose a speaker. Only a local check can name the real fault.
  it('refuses a blank playlist id without asking Spotify', async () => {
    const { browser, client } = harness();

    const error = expectFailure(await browser.playlistTracks('  '));
    expect(error.kind).toBe('unexpected');
    expect(error.message).toContain('playlist id');
    expect(client.paths).toHaveLength(0);
  });
});

describe('the paging window is checked before anything is sent', () => {
  // These come from a scrolling list's own arithmetic, not from configuration.
  // Clamping a wrong one would hide the bug behind a list that repeats rows.
  it('rejects an offset that cannot exist', async () => {
    const { browser, client } = harness();

    expect(expectFailure(await browser.savedAlbums({ offset: -1 })).message).toContain(
      'offset',
    );
    expect(expectFailure(await browser.savedAlbums({ offset: 1.5 })).message).toContain(
      'offset',
    );
    expect(client.paths).toHaveLength(0);
  });

  it('rejects a page size Spotify would refuse', async () => {
    const { browser, client } = harness();

    for (const limit of [0, MAX_PAGE_LIMIT + 1, 2.5]) {
      const error = expectFailure(await browser.playlists({ limit }));
      expect(error.kind).toBe('unexpected');
      expect(error.message).toContain('limit');
    }
    expect(client.paths).toHaveLength(0);
  });
});
