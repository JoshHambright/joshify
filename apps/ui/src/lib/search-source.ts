/**
 * The Search screen's data: results for a query, and the library for an empty
 * one.
 *
 * ## Why this is not shaped like `device-source.ts`
 *
 * The other two sources poll a list that changes on its own. This one answers
 * a question the viewer keeps changing, which makes the interesting failure
 * the opposite one: not a stale list, but a stale *answer* — a slow response
 * for "bea" landing after a fast one for "beatles" and overwriting it.
 *
 * The server already fences this: it holds one long-lived search session, and
 * an overtaken request comes back `{ status: 'superseded' }` rather than with
 * results (D-032). But that fence protects the *server's* idea of the newest
 * query, and requests can still be reordered on the way back. So this fences
 * again on the client, against the query it last asked for. Two fences is not
 * belt and braces here — they are guarding different hops.
 */
import type { JoshifyError } from '@joshify/core';
import type {
  AlbumResult,
  LibraryPage,
  LibrarySection,
  LibraryView,
  PlaylistResult,
  SearchResults,
} from './thumbnails.js';

export interface SearchSourceState {
  /** The newest results, or null while the field is empty. */
  readonly results: SearchResults | null;
  /** What an empty field shows instead of a blank screen (D-031). */
  readonly library: LibraryView | null;
  readonly problem: JoshifyError | null;
  /** True while a request the viewer is waiting on is in flight. */
  readonly pending: boolean;
}

export type FetchLike = (
  input: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SearchSourceConfig {
  readonly fetch: FetchLike;
  readonly baseUrl?: string | undefined;
}

export interface SearchSource {
  readonly subscribe: (run: (value: SearchSourceState) => void) => () => void;
  /** Called once the typing has gone quiet. An empty query loads the library. */
  readonly query: (text: string) => Promise<void>;
  /** Fetch the next page of one library section and append it. */
  readonly loadMore: (section: LibrarySection, offset: number) => Promise<void>;
  readonly current: () => SearchSourceState;
}

const problemFrom = (status: number, body: unknown): JoshifyError => {
  const envelope =
    typeof body === 'object' && body !== null
      ? (body as { error?: { kind?: unknown; message?: unknown } }).error
      : undefined;
  return {
    kind:
      typeof envelope?.kind === 'string'
        ? (envelope.kind as JoshifyError['kind'])
        : 'unexpected',
    message:
      typeof envelope?.message === 'string'
        ? envelope.message
        : `the server answered ${String(status)}`,
    retryable: true,
  };
};

const NETWORK: JoshifyError = {
  kind: 'network',
  message: 'the panel could not reach the Joshify server',
  retryable: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read a `LibraryPage`. Only the envelope is checked — the rows were built by
 * the server's normaliser from a payload it already validated, and a second
 * definition of a valid row here is a second thing that can drift.
 */
const readPage = <T>(value: unknown): LibraryPage<T> | null => {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  return value as unknown as LibraryPage<T>;
};

const readLibrary = (body: unknown): LibraryView | null => {
  if (!isRecord(body)) return null;
  const albums = readPage<AlbumResult>(body['albums']);
  const playlists = readPage<PlaylistResult>(body['playlists']);
  return albums === null || playlists === null ? null : { albums, playlists };
};

/**
 * Read a search answer. The four arrays are checked for shape but not row by
 * row: they were built by the server's normaliser from a payload it already
 * validated, and a second definition of a valid row here is a second thing
 * that can drift out of step with the first.
 */
const readResults = (value: unknown): SearchResults | null => {
  if (!isRecord(value) || typeof value['query'] !== 'string') return null;
  const arrays = ['tracks', 'albums', 'artists', 'playlists'] as const;
  if (!arrays.every((key) => Array.isArray(value[key]))) return null;
  return value as unknown as SearchResults;
};

/** Append a page onto one already held, without re-fetching what we have. */
const appendPage = <T>(held: LibraryPage<T>, next: LibraryPage<T>): LibraryPage<T> => ({
  ...next,
  items: [...held.items, ...next.items],
  // Keep the window the caller started from: `items` now spans both pages, and
  // reporting the later offset would make the length and the offset disagree.
  offset: held.offset,
});

export const createSearchSource = (config: SearchSourceConfig): SearchSource => {
  const base = config.baseUrl ?? '';
  const subscribers = new Set<(value: SearchSourceState) => void>();

  let value: SearchSourceState = {
    results: null,
    library: null,
    problem: null,
    pending: false,
  };
  /** The query this source last asked for. The client-side half of the fence. */
  let wanted = '';

  const publish = (next: Partial<SearchSourceState>): void => {
    value = { ...value, ...next };
    for (const run of subscribers) run(value);
  };

  const get = async (
    path: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; problem: JoshifyError }> => {
    try {
      const response = await config.fetch(`${base}${path}`);
      const body: unknown = await response.json().catch(() => undefined);
      return response.ok
        ? { ok: true, body }
        : { ok: false, problem: problemFrom(response.status, body) };
    } catch {
      return { ok: false, problem: NETWORK };
    }
  };

  const loadLibrary = async (): Promise<void> => {
    const answer = await get('/api/library');
    if (wanted !== '') return; // the viewer typed again while this was in flight
    if (!answer.ok) {
      publish({ problem: answer.problem, pending: false });
      return;
    }
    const library = readLibrary(answer.body);
    if (library === null) {
      publish({ problem: problemFrom(200, answer.body), pending: false });
      return;
    }
    publish({ library, results: null, problem: null, pending: false });
  };

  const search = async (text: string): Promise<void> => {
    const answer = await get(`/api/search?q=${encodeURIComponent(text)}`);
    // The fence, on the client's side of the wire. The server fences its own
    // session; this guards the trip back, where responses can still overtake
    // one another.
    if (wanted !== text) return;
    if (!answer.ok) {
      publish({ problem: answer.problem, pending: false });
      return;
    }
    const body = answer.body;
    if (!isRecord(body)) {
      publish({ problem: problemFrom(200, body), pending: false });
      return;
    }
    // `superseded` is a success, not a failure: being overtaken by the next
    // keystroke is the normal outcome of typing, and rendering it as an error
    // would flash a fault on every letter.
    if (body['status'] === 'superseded') {
      publish({ pending: false });
      return;
    }
    const results = readResults(body['results']);
    if (results === null) {
      publish({ problem: problemFrom(200, body), pending: false });
      return;
    }
    publish({ results, problem: null, pending: false });
  };

  return {
    subscribe: (run) => {
      subscribers.add(run);
      run(value);
      return () => {
        subscribers.delete(run);
      };
    },
    query: async (text) => {
      const trimmed = text.trim();
      wanted = trimmed;
      publish({ pending: true, problem: null });
      // An empty field is the library, not an empty result set — and the
      // server rejects an empty `q` before spending a round trip on it.
      await (trimmed === '' ? loadLibrary() : search(trimmed));
    },
    loadMore: async (section, offset) => {
      const held = value.library;
      if (held === null) return;
      const answer = await get(`/api/library/${section}?offset=${String(offset)}`);
      if (!answer.ok) {
        // A failed page leaves the rows already on screen alone. The list is
        // shorter than it could be, which is far better than empty.
        publish({ problem: answer.problem });
        return;
      }
      // The two sections are appended separately rather than through a
      // computed key: `LibraryPage<AlbumResult>` and `LibraryPage<PlaylistResult>`
      // are different types, and a computed key would need a cast that turns
      // "I appended playlists to albums" from a compile error into a bug.
      const current = value.library;
      if (current === null) return;
      if (section === 'albums') {
        const page = readPage<AlbumResult>(answer.body);
        if (page === null) return;
        publish({
          library: { ...current, albums: appendPage(current.albums, page) },
          problem: null,
        });
        return;
      }
      const page = readPage<PlaylistResult>(answer.body);
      if (page === null) return;
      publish({
        library: { ...current, playlists: appendPage(current.playlists, page) },
        problem: null,
      });
    },
    current: () => value,
  };
};
