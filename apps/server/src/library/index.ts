/**
 * Search and library browse — the read side of Phase 6.
 *
 * Everything here takes `Pick<SpotifyClient, 'request'>` rather than a whole
 * client: these modules own shapes and sequencing, and the client owns auth,
 * retries and the error taxonomy.
 */
export {
  createSearchSession,
  ALL_SEARCH_TYPES,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_SEARCH_LIMIT,
  type ScheduleDelay,
  type SearchOutcome,
  type SearchSession,
  type SearchSessionOptions,
  type SearchType,
} from './search.js';
export {
  createLibraryBrowser,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type LibraryBrowser,
  type LibraryBrowserOptions,
  type PageRequest,
} from './browse.js';
export {
  emptySearchResults,
  normaliseAlbum,
  normaliseArtist,
  normalisePage,
  normalisePlaylist,
  normaliseSearchResults,
  normaliseTrack,
  readPlaylistTrack,
  readSavedAlbum,
  type AlbumResult,
  type ArtistResult,
  type LibraryItem,
  type LibraryItemKind,
  type LibraryPage,
  type PageWindow,
  type PlaylistResult,
  type SearchResults,
  type TrackResult,
} from './normalise.js';
