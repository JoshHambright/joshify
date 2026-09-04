/**
 * Browsing the user's own library: saved albums, playlists, and what is in one.
 *
 * Every one of these is a paging endpoint over a collection that is genuinely
 * long — a decade-old account with four hundred saved albums is unremarkable —
 * so a page is what this module returns and a page is all it fetches. There is
 * deliberately no `fetchAll`: the list is virtualised (P6-04), the device has a
 * finite memory budget, and a helper that quietly issued forty requests to fill
 * an array nobody scrolls to the end of would spend the rate limit the poll
 * loop shares (D-025).
 *
 * The paging window is validated here rather than at Spotify, for the same
 * reason the player commands validate volume and seek (D-026): an out-of-range
 * `limit` comes back as a bare 400, and — worse — a request built with a blank
 * playlist id becomes `/v1/playlists//tracks`, which answers **404**. Our
 * taxonomy reads a 404 from the player as "no active device", so a caller's bad
 * id would put "choose a speaker" on screen. Local checks are the only ones
 * that can name the value that was actually wrong.
 */
import { createError, err, ok, type JoshifyError, type Result } from '@joshify/core';
import type { SpotifyClient } from '../spotify/client.js';
import {
  normalisePage,
  normalisePlaylist,
  readPlaylistTrack,
  readSavedAlbum,
  type AlbumResult,
  type LibraryPage,
  type PageWindow,
  type PlaylistResult,
  type TrackResult,
} from './normalise.js';

/** Spotify's ceiling on every one of these endpoints. */
export const MAX_PAGE_LIMIT = 50;

/**
 * The maximum, on purpose. Paging here is bounded by requests, not by bytes:
 * fifty normalised rows are a few kilobytes, while fifty rows fetched twenty at
 * a time are three round trips instead of one — and a half-empty list waiting
 * on the next page is exactly what makes a scroll feel broken.
 */
export const DEFAULT_PAGE_LIMIT = MAX_PAGE_LIMIT;

export interface PageRequest {
  /** Rows to skip. Comes from `nextOffset` on the previous page. */
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface LibraryBrowserOptions {
  /**
   * ISO country code. Without it Spotify lists tracks that are not licensed
   * where the device is, and tapping one fails at play time instead of simply
   * not being offered.
   */
  readonly market?: string | undefined;
  readonly limit?: number | undefined;
}

export interface LibraryBrowser {
  /** `GET /me/albums` — the heart icon, not the artist's discography. */
  readonly savedAlbums: (
    page?: PageRequest,
  ) => Promise<Result<LibraryPage<AlbumResult>, JoshifyError>>;
  /** `GET /me/playlists` — owned and followed, in Spotify's own order. */
  readonly playlists: (
    page?: PageRequest,
  ) => Promise<Result<LibraryPage<PlaylistResult>, JoshifyError>>;
  /** `GET /playlists/{id}/tracks` — the detail view behind a playlist row. */
  readonly playlistTracks: (
    playlistId: string,
    page?: PageRequest,
  ) => Promise<Result<LibraryPage<TrackResult>, JoshifyError>>;
}

const rangeError = (name: string, value: number, bounds: string): JoshifyError =>
  createError('unexpected', `${name} must be ${bounds}, got ${String(value)}`);

/**
 * Resolve a requested window, or say which half of it was nonsense.
 *
 * Unlike the search `limit` — a config knob, so clamped — these come straight
 * from a scrolling list, and a wrong one means the caller's paging arithmetic
 * is broken. Clamping would hide that behind a list that quietly repeats rows.
 */
const resolveWindow = (
  page: PageRequest,
  defaultLimit: number,
): Result<PageWindow, JoshifyError> => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? defaultLimit;

  if (!Number.isInteger(offset) || offset < 0) {
    return err(rangeError('offset', offset, 'an integer >= 0'));
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return err(
      rangeError('limit', limit, `an integer between 1 and ${String(MAX_PAGE_LIMIT)}`),
    );
  }
  return ok({ offset, limit });
};

export const createLibraryBrowser = (
  client: Pick<SpotifyClient, 'request'>,
  options: LibraryBrowserOptions = {},
): LibraryBrowser => {
  const defaultLimit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const market: Readonly<Record<string, string>> =
    options.market === undefined ? {} : { market: options.market };

  const pathFor = (
    base: string,
    window: PageWindow,
    extra: Readonly<Record<string, string>> = {},
  ): string => {
    const params = new URLSearchParams({
      offset: String(window.offset),
      limit: String(window.limit),
      ...extra,
    });
    return `${base}?${params.toString()}`;
  };

  /** Fetch one window and normalise it, or fail without touching the network. */
  const fetchPage = async <T>(
    page: PageRequest,
    path: (window: PageWindow) => string,
    read: (raw: unknown) => T | null,
  ): Promise<Result<LibraryPage<T>, JoshifyError>> => {
    const window = resolveWindow(page, defaultLimit);
    if (!window.ok) return err(window.error);

    const result = await client.request(path(window.value));
    if (!result.ok) return err(result.error);
    return normalisePage(result.value, read, window.value);
  };

  return {
    savedAlbums: (page = {}) =>
      fetchPage(
        page,
        (window) => pathFor('/v1/me/albums', window, market),
        readSavedAlbum,
      ),

    // No `market` here. It is not a parameter this endpoint takes, and Spotify
    // ignores what it does not recognise rather than rejecting it (D-026) — so
    // sending it would look deliberate to the next reader and do nothing.
    playlists: (page = {}) =>
      fetchPage(page, (window) => pathFor('/v1/me/playlists', window), normalisePlaylist),

    playlistTracks: async (playlistId, page = {}) => {
      if (playlistId.trim() === '') {
        return err(createError('unexpected', 'playlistTracks needs a playlist id'));
      }
      return await fetchPage(
        page,
        (window) =>
          pathFor(`/v1/playlists/${encodeURIComponent(playlistId)}/tracks`, window, {
            ...market,
            // Same quirk the player has: without asking for episodes, an
            // episode sitting in a playlist comes back as `track: null` and
            // the row silently vanishes from a list the user can see in the
            // phone app.
            additional_types: 'track,episode',
          }),
        readPlaylistTrack,
      );
    },
  };
};
