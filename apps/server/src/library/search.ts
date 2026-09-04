/**
 * Search, driven by a finger on an on-screen keyboard.
 *
 * Two things make this different from an ordinary API call.
 *
 * **Every keystroke is a request unless something stops it.** Typing "beatles"
 * is seven requests against a rolling rate limit shared with the poll loop
 * (D-025), for six answers nobody will ever read. So a query is only sent once
 * the typing has gone quiet; a keystroke during the quiet period cancels the
 * pending send outright, and the request is never made.
 *
 * **A slow answer must never overwrite a fast one.** "bea" and "beatles" are
 * different requests with independent latencies, and Spotify will happily
 * return them out of order. The failure mode is silent: the list shows results
 * for a query the user has already finished typing over, looks perfectly
 * plausible, and only ever gets reported as "search is wrong sometimes". So it
 * is made structurally impossible rather than unlikely — every search takes a
 * generation number, and the *return* path checks it. A response that is no
 * longer the newest cannot be rendered, whatever order it arrived in and
 * whether it succeeded or failed.
 *
 * The in-flight request itself is deliberately not aborted. The client owns
 * retries and reads an aborted fetch as a retryable network failure (see
 * `spotify/retry.ts`), so aborting would buy a freed socket and pay for it with
 * two pointless retries. Cancellation belongs at the seam where it actually
 * saves the request: before it is sent.
 */
import { err, ok, type JoshifyError, type Result } from '@joshify/core';
import type { SpotifyClient } from '../spotify/client.js';
import {
  emptySearchResults,
  normaliseSearchResults,
  type SearchResults,
} from './normalise.js';

export type SearchType = 'track' | 'album' | 'artist' | 'playlist';

export const ALL_SEARCH_TYPES: readonly SearchType[] = [
  'track',
  'album',
  'artist',
  'playlist',
];

/**
 * Long enough that an unhurried typist does not fire a request per letter,
 * short enough that pausing to look at the screen already shows results. Below
 * ~150ms the debounce stops earning its keep on a touch keyboard, where a fast
 * key rate is around 4/second.
 */
export const DEFAULT_DEBOUNCE_MS = 250;

/** Spotify's own ceiling per type. */
const MAX_LIMIT = 50;

/**
 * A screenful and a bit per type. The results view shows a few rows of each
 * type rather than a deep list of one (P6-03), so a bigger page would be
 * fetched, normalised and thrown away.
 */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Run `run` after `delayMs`, returning a function that cancels it.
 *
 * Injected so tests never wait, and shaped as a cancel closure so no timer
 * handle type leaks into this module's API.
 */
export type ScheduleDelay = (run: () => void, delayMs: number) => () => void;

const realSchedule: ScheduleDelay = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * What a search resolved to.
 *
 * `superseded` sits in the success channel on purpose: being overtaken by the
 * next keystroke is the normal outcome of typing, not a failure, and a caller
 * that treated it as one would flash an error on every letter. It carries no
 * results because it has nothing true to say about what is on screen — the
 * search that replaced it does.
 */
export type SearchOutcome =
  | { readonly status: 'results'; readonly results: SearchResults }
  | { readonly status: 'superseded' };

export interface SearchSessionOptions {
  readonly client: Pick<SpotifyClient, 'request'>;
  readonly debounceMs?: number | undefined;
  /** Results per type. Clamped to Spotify's 1–50. */
  readonly limit?: number | undefined;
  readonly types?: readonly SearchType[] | undefined;
  /**
   * ISO country code. Spotify filters out anything unplayable there, so
   * omitting it lists results the device cannot actually play.
   */
  readonly market?: string | undefined;
  readonly schedule?: ScheduleDelay | undefined;
}

export interface SearchSession {
  /**
   * Call on every keystroke. Resolves once this query has either produced
   * results or been overtaken — never left hanging, so an HTTP handler
   * awaiting it always gets an answer.
   */
  readonly search: (text: string) => Promise<Result<SearchOutcome, JoshifyError>>;
  /**
   * Abandon whatever is pending — the search screen closing, or the field
   * being cleared. Anything already awaiting resolves as superseded.
   */
  readonly cancel: () => void;
}

const SUPERSEDED: Result<SearchOutcome, JoshifyError> = ok({ status: 'superseded' });

const clampLimit = (limit: number): number =>
  Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));

export const createSearchSession = (options: SearchSessionOptions): SearchSession => {
  const { client } = options;
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const limit = clampLimit(options.limit ?? DEFAULT_SEARCH_LIMIT);
  const types = options.types ?? ALL_SEARCH_TYPES;
  const schedule = options.schedule ?? realSchedule;

  /**
   * Bumped by every call. A search is current only while this still equals the
   * number it took at the start; nothing else decides what may be rendered.
   */
  let generation = 0;

  /**
   * Cancels the waiting debounce *and* resolves whoever is awaiting it. Both
   * halves matter: clearing the timer alone would leave that caller's promise
   * unresolved forever, which on the HTTP side is a request that never answers.
   */
  let abandonPending: (() => void) | null = null;

  const supersedePending = (): void => {
    const abandon = abandonPending;
    abandonPending = null;
    abandon?.();
  };

  /** Resolves true once the typing has been quiet, false if overtaken first. */
  const waitForQuiet = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const cancelTimer = schedule(() => {
        abandonPending = null;
        resolve(true);
      }, debounceMs);
      abandonPending = () => {
        cancelTimer();
        resolve(false);
      };
    });

  const pathFor = (query: string): string => {
    const params = new URLSearchParams({
      q: query,
      type: types.join(','),
      limit: String(limit),
    });
    if (options.market !== undefined) params.set('market', options.market);
    return `/v1/search?${params.toString()}`;
  };

  const search = async (text: string): Promise<Result<SearchOutcome, JoshifyError>> => {
    generation += 1;
    const mine = generation;
    supersedePending();

    const query = text.trim();
    // An empty field is not a search — Spotify answers a blank `q` with a 400,
    // and the honest local answer is "nothing", immediately. Returning it
    // without waiting for the debounce is what makes clearing the field feel
    // instant, and the generation bump above has already killed whatever was
    // in flight for the text that was just deleted.
    if (query === '') return ok({ status: 'results', results: emptySearchResults('') });

    if (!(await waitForQuiet())) return SUPERSEDED;
    // The timer fired, but a keystroke could have landed in the same tick.
    if (mine !== generation) return SUPERSEDED;

    const result = await client.request(pathFor(query));

    // The check that makes an out-of-order result impossible rather than
    // unlikely. It is here, on the return path, because the response that can
    // lose the race is by definition one that has already come back — checking
    // only before the request would prove nothing at all. Errors are swallowed
    // for the same reason: a stale failure would replace a fresh list with an
    // error screen.
    if (mine !== generation) return SUPERSEDED;
    if (!result.ok) return err(result.error);

    const results = normaliseSearchResults(result.value, query);
    if (!results.ok) return err(results.error);
    return ok({ status: 'results', results: results.value });
  };

  return {
    search,
    cancel: () => {
      generation += 1;
      supersedePending();
    },
  };
};
