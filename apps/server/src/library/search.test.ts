import { describe, expect, it } from 'vitest';
import { createError, isOk, type JoshifyError, type Result } from '@joshify/core';
import {
  createFakeClient,
  createManualScheduler,
  settleMicrotasks,
  type FakeSpotifyClient,
  type ManualScheduler,
} from './testing/fake-client.js';
import type { SearchResults } from './normalise.js';
import {
  createSearchSession,
  DEFAULT_DEBOUNCE_MS,
  type SearchOutcome,
  type SearchSession,
  type SearchSessionOptions,
} from './search.js';

type Outcome = Result<SearchOutcome, JoshifyError>;

interface Harness {
  readonly session: SearchSession;
  readonly client: FakeSpotifyClient;
  readonly timers: ManualScheduler;
}

const harness = (
  options: Omit<SearchSessionOptions, 'client' | 'schedule'> = {},
): Harness => {
  const client = createFakeClient();
  const timers = createManualScheduler();
  return {
    client,
    timers,
    session: createSearchSession({ ...options, client, schedule: timers.schedule }),
  };
};

/** A search body with one track, named so the two racing queries are telling apart. */
const bodyWithTrack = (name: string): unknown => ({
  tracks: {
    items: [
      {
        name,
        uri: `spotify:track:${name}`,
        id: name,
        duration_ms: 1000,
        artists: [{ name: 'The Beatles' }],
        album: { name: 'Abbey Road', images: [{ url: 'a.jpg', width: 64, height: 64 }] },
      },
    ],
  },
});

const expectResults = (outcome: Outcome): SearchResults => {
  if (!isOk(outcome)) throw new Error(`expected results, got: ${outcome.error.message}`);
  if (outcome.value.status !== 'results') {
    throw new Error('expected results, but the search was superseded');
  }
  return outcome.value.results;
};

const expectSuperseded = (outcome: Outcome): void => {
  if (!isOk(outcome))
    throw new Error(`expected superseded, got: ${outcome.error.message}`);
  expect(outcome.value.status).toBe('superseded');
};

const expectFailure = (outcome: Outcome): JoshifyError => {
  if (isOk(outcome)) throw new Error('expected a failure');
  return outcome.error;
};

/** Let the debounce fire and the request that follows it actually be made. */
const flush = async (timers: ManualScheduler): Promise<void> => {
  timers.runAll();
  await settleMicrotasks();
};

describe('debouncing the keyboard', () => {
  // Typing "bea" is three keystrokes. Sending three searches is three requests
  // against the same rolling rate limit the poll loop spends (D-025), for two
  // answers that were obsolete before they arrived.
  it('sends one request for a burst of keystrokes, for the final text', async () => {
    const { session, client, timers } = harness();

    const first = session.search('b');
    const second = session.search('be');
    const third = session.search('bea');
    expect(timers.pendingCount()).toBe(1);

    client.queue(bodyWithTrack('Come Together'));
    await flush(timers);

    expect(client.paths).toHaveLength(1);
    expect(client.paths[0]).toContain('q=bea&');
    expectSuperseded(await first);
    expectSuperseded(await second);
    expect(expectResults(await third).tracks[0]?.title).toBe('Come Together');
  });

  it('waits the configured quiet period', () => {
    const { session, timers } = harness({ debounceMs: 400 });
    void session.search('bea');
    expect(timers.delays).toEqual([400]);
  });

  it('defaults to a quiet period sized for a touch keyboard', () => {
    const { session, timers } = harness();
    void session.search('bea');
    expect(timers.delays).toEqual([DEFAULT_DEBOUNCE_MS]);
  });

  // A caller that awaits every keystroke — the HTTP handler will — must never
  // be left holding a promise that nobody will ever resolve.
  it('resolves an overtaken search instead of leaving it hanging', async () => {
    const { session, client, timers } = harness();
    const abandoned = session.search('bea');
    client.queue(bodyWithTrack('Come Together'));
    const winner = session.search('beatles');
    await flush(timers);

    expectSuperseded(await abandoned);
    expect(expectResults(await winner).query).toBe('beatles');
  });

  it('cancels the pending send when the session is torn down', async () => {
    const { session, client, timers } = harness();
    const abandoned = session.search('bea');
    session.cancel();

    await flush(timers);
    expect(client.paths).toHaveLength(0);
    expectSuperseded(await abandoned);
  });

  it('survives a cancel with nothing pending', () => {
    const { session } = harness();
    expect(() => {
      session.cancel();
    }).not.toThrow();
  });

  // The default scheduler is a real timer; everything else here injects one, so
  // this is the only test that proves the production path is wired up at all.
  it('uses real timers when no scheduler is injected', async () => {
    const client = createFakeClient();
    const session = createSearchSession({ client, debounceMs: 0 });

    const abandoned = session.search('bea');
    client.queue(bodyWithTrack('Come Together'));
    const winner = session.search('beatles');

    expectSuperseded(await abandoned);
    expect(expectResults(await winner).query).toBe('beatles');
    expect(client.paths).toHaveLength(1);
  });
});

describe('a slow answer never overwrites a fast one', () => {
  /*
   * The bug this exists to prevent: the user types "bea", the request goes out
   * and stalls; they finish typing "beatles", which answers quickly and paints
   * the list; then "bea" finally arrives and repaints the screen with results
   * for a query that is no longer on the keyboard. Nothing errors, nothing
   * logs, and the list is simply wrong — reported forever after as "search
   * sometimes shows the wrong thing".
   */
  it('discards a superseded response that arrives last', async () => {
    const { session, client, timers } = harness();

    const slow = session.search('bea');
    await flush(timers);
    const fast = session.search('beatles');
    await flush(timers);
    expect(client.paths).toHaveLength(2);

    // The order that breaks a naive implementation: newest answers first.
    client.settle('q=beatles', bodyWithTrack('Come Together'));
    client.settle('q=bea&', bodyWithTrack('Bea Arthur'));

    expect(expectResults(await fast).tracks[0]?.title).toBe('Come Together');
    expectSuperseded(await slow);
  });

  // A stale *failure* is the same bug wearing a different hat: a 429 for the
  // query the user typed over must not replace a good list with an error.
  it('discards a superseded failure too', async () => {
    const { session, client, timers } = harness();

    const slow = session.search('bea');
    await flush(timers);
    const fast = session.search('beatles');
    await flush(timers);

    client.settle('q=beatles', bodyWithTrack('Come Together'));
    client.settleFailure('q=bea&', createError('rate-limited', 'slow down'));

    expect(expectResults(await fast).tracks).toHaveLength(1);
    expectSuperseded(await slow);
  });

  // A fast typist can land a key in the same tick the debounce timer fires.
  // Checking the generation only before the request would let that one through.
  it('discards a search overtaken between the timer and the request', async () => {
    const { session, client, timers } = harness();

    const overtaken = session.search('bea');
    timers.runAll();
    const winner = session.search('beatles');
    client.queue(bodyWithTrack('Come Together'));
    await flush(timers);

    expectSuperseded(await overtaken);
    expect(client.paths).toEqual([expect.stringContaining('q=beatles')]);
    expect(expectResults(await winner).query).toBe('beatles');
  });
});

describe('the query itself', () => {
  it('asks for every type, a bounded page, and the market', async () => {
    const { session, client, timers } = harness({ limit: 10, market: 'GB' });
    const search = session.search('beatles');
    client.queue({});
    await flush(timers);

    expect(client.paths[0]).toBe(
      '/v1/search?q=beatles&type=track%2Calbum%2Cartist%2Cplaylist&limit=10&market=GB',
    );
    expectResults(await search);
  });

  it('narrows to the types it was given', async () => {
    const { session, client, timers } = harness({ types: ['album'] });
    const search = session.search('abbey');
    client.queue({});
    await flush(timers);

    expect(client.paths[0]).toContain('type=album&');
    expectResults(await search);
  });

  // Spotify's ceiling is 50 per type; a caller asking for more gets a 400 that
  // names nothing. The limit is configuration, not user input, so it is clamped.
  it('clamps the page size to what Spotify accepts', async () => {
    const big = harness({ limit: 500 });
    void big.session.search('a');
    big.client.queue({});
    await flush(big.timers);
    expect(big.client.paths[0]).toContain('limit=50');

    const small = harness({ limit: 0 });
    void small.session.search('a');
    small.client.queue({});
    await flush(small.timers);
    expect(small.client.paths[0]).toContain('limit=1');
  });

  // A query is user text from an on-screen keyboard. Unescaped, "AC/DC & live"
  // would smuggle a `live` parameter into the request.
  it('escapes a query that looks like query-string syntax', async () => {
    const { session, client, timers } = harness();
    const search = session.search('AC/DC & live');
    client.queue({});
    await flush(timers);

    expect(client.paths[0]).toContain('q=AC%2FDC+%26+live&');
    expectResults(await search);
  });

  it('trims the surrounding whitespace a keyboard leaves behind', async () => {
    const { session, client, timers } = harness();
    const search = session.search('  beatles  ');
    client.queue({});
    await flush(timers);

    expect(client.paths[0]).toContain('q=beatles&');
    expect(expectResults(await search).query).toBe('beatles');
  });
});

describe('the states that are not failures', () => {
  // Clearing the field must clear the list immediately, without a round trip —
  // and Spotify answers an empty `q` with a 400 anyway.
  it('answers an empty query with empty results and no request', async () => {
    const { session, client, timers } = harness();
    const outcome = await session.search('');

    expect(expectResults(outcome)).toEqual({
      query: '',
      tracks: [],
      albums: [],
      artists: [],
      playlists: [],
    });
    expect(client.paths).toHaveLength(0);
    expect(timers.pendingCount()).toBe(0);
  });

  it('treats a whitespace-only query as empty', async () => {
    const { session, client } = harness();
    expect(expectResults(await session.search('   ')).tracks).toEqual([]);
    expect(client.paths).toHaveLength(0);
  });

  // Backspacing to nothing while a search is in flight: the cleared field wins,
  // and the in-flight answer for the deleted text can never repaint the list.
  it('supersedes an in-flight search when the field is cleared', async () => {
    const { session, client, timers } = harness();
    const inFlight = session.search('bea');
    await flush(timers);

    const cleared = await session.search('');
    client.settle('q=bea&', bodyWithTrack('Bea Arthur'));

    expect(expectResults(cleared).query).toBe('');
    expectSuperseded(await inFlight);
  });

  it('reports no matches as empty lists, not as an error', async () => {
    const { session, client, timers } = harness();
    const search = session.search('zzzzzzz');
    client.queue({
      tracks: { items: [] },
      albums: { items: [] },
      artists: { items: [] },
      playlists: { items: [] },
    });
    await flush(timers);

    const results = expectResults(await search);
    expect(results).toEqual({
      query: 'zzzzzzz',
      tracks: [],
      albums: [],
      artists: [],
      playlists: [],
    });
  });
});

describe('failures that are real', () => {
  it('passes a client failure through untouched', async () => {
    const { session, client, timers } = harness();
    const search = session.search('beatles');
    client.queueFailure(createError('rate-limited', 'slow down'));
    await flush(timers);

    expect(expectFailure(await search).kind).toBe('rate-limited');
  });

  it('reports a body that is not a search response', async () => {
    const { session, client, timers } = harness();
    const search = session.search('beatles');
    client.queue('not json we understand');
    await flush(timers);

    expect(expectFailure(await search).kind).toBe('unexpected');
  });
});
