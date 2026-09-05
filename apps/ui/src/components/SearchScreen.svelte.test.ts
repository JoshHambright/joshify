/**
 * @vitest-environment jsdom
 */
/**
 * Search is the one screen where being *plausible* is the failure mode: a list
 * of results for a query the user has already typed over looks perfectly fine
 * and only ever gets reported as "search is wrong sometimes" (D-032). So the
 * fence gets the most tests here — the screen must ignore an answer to a query
 * it is no longer asking, however the parent wires the fetch.
 *
 * The rest is the honesty rules from SCREENS.md: an empty field shows the
 * library rather than a blank screen (D-031), and "nothing found" is a sentence
 * that only appears once there is genuinely an answer to show.
 *
 * The debounce timer is injected, so nothing here waits a quarter of a second.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import SearchScreen from './SearchScreen.svelte';
import type { ScheduleDelay } from '../lib/keyboard.js';
import type {
  AlbumResult,
  LibraryPage,
  LibrarySection,
  LibraryView,
  PlaylistResult,
  SearchResults,
  TrackResult,
} from '../lib/thumbnails.js';

const track = (title: string): TrackResult => ({
  kind: 'track',
  id: title,
  uri: `spotify:track:${title}`,
  title,
  subtitle: 'Nitrous Cartel',
  images: [{ url: `https://i/${title}`, width: 64, height: 64 }],
  artists: ['Nitrous Cartel'],
  albumName: 'Redline',
  durationMs: 211_000,
  isLocal: false,
});

const albumRow = (title: string): AlbumResult => ({
  kind: 'album',
  id: title,
  uri: `spotify:album:${title}`,
  title,
  subtitle: 'Nitrous Cartel',
  images: [],
  artists: ['Nitrous Cartel'],
  totalTracks: 11,
  releaseYear: 1997,
});

const playlistRow = (title: string): PlaylistResult => ({
  kind: 'playlist',
  id: title,
  uri: `spotify:playlist:${title}`,
  title,
  subtitle: 'Josh',
  images: [],
  ownerName: 'Josh',
  totalTracks: 42,
});

const page = <T>(
  items: readonly T[],
  nextOffset: number | null = null,
): LibraryPage<T> => ({
  items,
  offset: 0,
  limit: 50,
  total: nextOffset === null ? items.length : 200,
  nextOffset,
});

const results = (query: string, tracks: readonly TrackResult[] = []): SearchResults => ({
  query,
  tracks,
  albums: [],
  artists: [],
  playlists: [],
});

const library = (over: Partial<LibraryView> = {}): LibraryView => ({
  albums: page([albumRow('Redline')]),
  playlists: page([playlistRow('Late Shift')]),
  ...over,
});

/** A timer the test fires by hand, so the quiet period costs nothing. */
const manualSchedule = () => {
  let pending: (() => void) | null = null;
  const schedule: ScheduleDelay = (run) => {
    pending = run;
    return () => {
      pending = null;
    };
  };
  return {
    schedule,
    isPending: () => pending !== null,
    fire: () => {
      const run = pending;
      pending = null;
      run?.();
    },
  };
};

interface MountOptions {
  results?: SearchResults | null;
  library?: LibraryView | null;
}

const mount = (over: MountOptions = {}) => {
  const timer = manualSchedule();
  const queries: string[] = [];
  const played: string[] = [];
  const pages: [LibrarySection, number][] = [];

  const props = {
    results: over.results ?? null,
    library: over.library === undefined ? library() : over.library,
    schedule: timer.schedule,
    onQueryChange: (query: string) => queries.push(query),
    onPlay: (item: { title: string }) => played.push(item.title),
    onLoadMore: (section: LibrarySection, offset: number) =>
      pages.push([section, offset]),
  };

  const view = render(SearchScreen, props);
  return { ...view, props, timer, queries, played, pages };
};

/** Type on the board the way a finger does — one key at a time. */
const typeOut = async (text: string): Promise<void> => {
  for (const char of text) {
    await fireEvent.click(screen.getByRole('button', { name: char }));
  }
};

const queryReadout = (container: HTMLElement): string =>
  container.querySelector('[data-query]')?.getAttribute('data-query') ?? '';

const rowTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.title')].map((node) => node.textContent);

afterEach(cleanup);

describe('the empty field', () => {
  // An empty search screen is one you have to type at before it does anything,
  // and the library is what most people were reaching for anyway (D-031).
  it('shows the library rather than a blank screen', () => {
    const { container } = mount();

    expect(screen.getByText('Saved albums')).toBeDefined();
    expect(screen.getByText('Playlists')).toBeDefined();
    expect(rowTitles(container)).toEqual(['Redline', 'Late Shift']);
  });

  it('says nothing at all while the library is still on its way', () => {
    const { container } = mount({ library: null });

    expect(rowTitles(container)).toEqual([]);
    // Never a spinner, and never an error for a page that simply has not
    // landed yet.
    expect(container.textContent).not.toMatch(/loading|error|nothing found/i);
  });
});

describe('typing', () => {
  it('reads the query back on every keystroke, not on every request', async () => {
    const { container, queries } = mount();
    await typeOut('bea');

    expect(queryReadout(container)).toBe('bea');
    // Nothing has been asked for yet: the typing has not gone quiet.
    expect(queries).toEqual([]);
  });

  it('asks once the typing goes quiet', async () => {
    const { queries, timer } = mount();
    await typeOut('bea');
    timer.fire();

    expect(queries).toEqual(['bea']);
  });

  // Typing "beatles" is one request, not seven, against a rate limit shared
  // with the poll loop (D-025).
  it('cancels the pending request when another key lands', async () => {
    const { queries, timer } = mount();
    await typeOut('bea');
    await typeOut('t');
    timer.fire();

    expect(queries).toEqual(['beat']);
  });

  it('puts the library back the moment the field is cleared', async () => {
    const { container, queries, timer } = mount();
    await typeOut('bea');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(queries).toEqual(['']);
    expect(timer.isPending()).toBe(false);
    expect(queryReadout(container)).toBe('');
    expect(rowTitles(container)).toEqual(['Redline', 'Late Shift']);
  });
});

describe('the stale fence', () => {
  it('renders the answer to the query it asked for', async () => {
    const { container, rerender, props, timer } = mount();
    await typeOut('bea');
    timer.fire();
    await rerender({ ...props, results: results('bea', [track('Velocity Division')]) });

    expect(screen.getByText('Tracks')).toBeDefined();
    expect(rowTitles(container)).toEqual(['Velocity Division']);
  });

  // The failure this exists to prevent: a slow answer for "bea" arriving after
  // a fast one for "beat" and quietly replacing it.
  it('ignores an answer to a query that has been typed over', async () => {
    const { container, rerender, props, timer } = mount();
    await typeOut('beat');
    timer.fire();
    await rerender({ ...props, results: results('beat', [track('Redline')]) });
    expect(rowTitles(container)).toEqual(['Redline']);

    await rerender({ ...props, results: results('bea', [track('Something Else')]) });

    // The last true thing stays on screen. A blank list would be worse than a
    // slightly old one, and a stale list would be worse than both.
    expect(rowTitles(container)).toEqual(['Redline']);
  });

  it('holds the previous results while the next answer is in flight', async () => {
    const { container, rerender, props, timer } = mount();
    await typeOut('bea');
    timer.fire();
    await rerender({ ...props, results: results('bea', [track('Redline')]) });

    await typeOut('t');
    timer.fire();

    expect(rowTitles(container)).toEqual(['Redline']);
    // And no premature verdict on a search that has not answered yet.
    expect(container.textContent).not.toMatch(/nothing found/i);
  });

  it('says nothing was found only once that is the actual answer', async () => {
    const { rerender, props, timer } = mount();
    await typeOut('bea');
    timer.fire();
    await rerender({ ...props, results: results('bea') });

    expect(screen.getByText('Nothing found for “bea”.')).toBeDefined();
  });

  it('forgets the old results when the field is cleared', async () => {
    const { container, rerender, props, timer } = mount();
    await typeOut('bea');
    timer.fire();
    await rerender({ ...props, results: results('bea', [track('Redline')]) });

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(rowTitles(container)).toEqual(['Redline', 'Late Shift']);
  });
});

describe('playing a result', () => {
  it('plays the item the row was drawn from', async () => {
    const { played } = mount();
    await fireEvent.click(screen.getByRole('button', { name: /Redline/ }));

    expect(played).toEqual(['Redline']);
  });
});

describe('paging the library', () => {
  it('asks for the next page as the end of the list comes into view', () => {
    const { pages } = mount({
      library: library({ playlists: page([playlistRow('Late Shift')], 50) }),
    });

    expect(pages).toEqual([['playlists', 50]]);
  });

  // `shouldLoadNextPage` is stateless and will keep saying yes until new rows
  // arrive, so the screen is the thing that must not ask twice.
  it('asks once, not on every scroll frame', async () => {
    const { container, pages } = mount({
      library: library({ playlists: page([playlistRow('Late Shift')], 50) }),
    });
    const viewport = container.querySelector('.viewport');
    if (viewport === null) throw new Error('no viewport');
    await fireEvent.scroll(viewport);

    expect(pages).toEqual([['playlists', 50]]);
  });

  it('only asks for albums once the playlists have run out', () => {
    const { pages } = mount({
      library: library({ albums: page([albumRow('Redline')], 50) }),
    });

    expect(pages).toEqual([['albums', 50]]);
  });

  it('never pages a search, where each type is a fixed page', async () => {
    const { rerender, props, timer, pages } = mount({
      library: library({ playlists: page([playlistRow('Late Shift')], 50) }),
    });
    await typeOut('bea');
    timer.fire();
    await rerender({ ...props, results: results('bea', [track('Redline')]) });

    expect(pages).toEqual([['playlists', 50]]);
  });
});
