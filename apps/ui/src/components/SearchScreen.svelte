<script lang="ts">
  /**
   * Search — the plate, full (P6-03).
   *
   * The only screen that takes the whole panel, because the keyboard needs it.
   * The query reads back in mono across the top, the results sit in the middle
   * grouped by type, and the board is across the bottom. Nothing scrolls except
   * the list: the panel is fixed at 720×1280 (D-039), so the three bands are
   * arithmetic rather than a layout that might overflow —
   * `1280 = 140 header + 832 list + 308 keyboard`, and the keyboard's 308 is
   * `14 + 4 rows of 64 + 3 gaps of 8 + 14`.
   *
   * **An empty field is not an empty screen.** It shows the library — saved
   * albums, then playlists, paged as they arrive (D-031). A search screen that
   * opens blank is one you have to type at before it does anything, and the
   * library is what most people were reaching for anyway.
   *
   * **The stale fence, on this side of the wire.** The server's search session
   * already refuses to answer with results for a query that has been typed over
   * (D-032), and this screen must not undo that by rendering whatever prop
   * arrives last. So it remembers the query it asked for and renders an answer
   * only if it is the answer to *that* — a late "bea" cannot replace a fast
   * "beatles", however the parent wires the fetch. Anything stale leaves the
   * rows that are already on screen alone, because the last true thing is
   * always better than a blank list.
   *
   * The screen owns no fetching. Results and the library arrive as props;
   * typing goes out through `onQueryChange`, already debounced, and a tapped
   * row goes out through `onPlay`.
   */
  import { onDestroy } from 'svelte';
  import Keyboard from './Keyboard.svelte';
  import ResultRow from './ResultRow.svelte';
  import VirtualList from './VirtualList.svelte';
  import {
    createQueryDebouncer,
    INITIAL_KEYBOARD,
    pressKey,
    type KeyboardState,
    type KeyCap,
    type ScheduleDelay,
  } from '../lib/keyboard.js';
  import {
    createThumbnailCache,
    libraryRows,
    searchRows,
    type LibraryItem,
    type LibrarySection,
    type LibraryView,
    type ListRow,
    type SearchResults,
    type ThumbnailCache,
  } from '../lib/thumbnails.js';
  import {
    DEFAULT_ROW_HEIGHT,
    shouldLoadNextPage,
    type VirtualWindow,
  } from '../lib/virtual.js';

  interface Props {
    /** The newest answer the parent has. Stale ones are ignored, not rendered. */
    results: SearchResults | null;
    /** What an empty field shows. Null until the first page has landed. */
    library: LibraryView | null;
    /** Called once the typing has gone quiet, and immediately on a clear. */
    onQueryChange: (query: string) => void;
    onPlay: (item: LibraryItem) => void;
    /** Asked for the next page as the list nears its end. */
    onLoadMore?: ((section: LibrarySection, offset: number) => void) | undefined;
    debounceMs?: number | undefined;
    /** Injected so tests never wait on a real timer. */
    schedule?: ScheduleDelay | undefined;
    /** 1280 less the header and the keyboard. A prop so it can be measured
     *  nowhere: jsdom reports every element as 0×0. */
    listHeight?: number | undefined;
    cache?: ThumbnailCache | undefined;
  }

  const {
    results,
    library,
    onQueryChange,
    onPlay,
    onLoadMore,
    debounceMs,
    schedule,
    listHeight = 832,
    cache = createThumbnailCache(),
  }: Props = $props();

  let keyboard = $state<KeyboardState>(INITIAL_KEYBOARD);

  /** The query the parent was last asked for. The fence compares against this. */
  let asked = $state('');
  /** The newest results that answered `asked`. Nothing else is ever rendered. */
  let shown = $state<SearchResults | null>(null);

  const debouncer = createQueryDebouncer({
    debounceMs,
    schedule,
    emit: (query) => {
      asked = query;
      // Clearing the field puts the library back, and the old results must go
      // with it — otherwise the stale fence would happily accept them again on
      // the next search that happens to have the same text.
      if (query === '') shown = null;
      onQueryChange(query);
    },
  });

  onDestroy(() => {
    debouncer.cancel();
  });

  const query = $derived(keyboard.text.trim());

  $effect(() => {
    // The fence itself. `results.query` is the query the server answered, so a
    // slow answer for a query we have already typed over simply never lands.
    if (results !== null && results.query === asked) shown = results;
  });

  const rows = $derived<readonly ListRow[]>(
    query === '' ? libraryRows(library) : searchRows(shown),
  );

  // Told apart from "still typing": a screen that says "no results" while the
  // answer is in flight is wrong for a quarter of a second every time.
  const answered = $derived(shown !== null && shown.query === query);

  const press = (key: KeyCap): void => {
    const next = pressKey(keyboard, key);
    if (next.text !== keyboard.text) debouncer.set(next.text);
    keyboard = next;
  };

  /**
   * The last offset handed to `onLoadMore`, so a scroll that sits at the bottom
   * asks once rather than on every frame. `shouldLoadNextPage` is deliberately
   * stateless and will keep saying yes until new rows arrive.
   */
  let lastAsked: string | null = null;

  const pageWanted = (): { section: LibrarySection; offset: number } | null => {
    if (library === null) return null;
    // Playlists sit at the bottom of the flattened list, so reaching the end is
    // a request for more of those. Albums are only asked for once the playlists
    // have run out, which is the only case where the end of the list is the end
    // of the albums too.
    if (library.playlists.nextOffset !== null) {
      return { section: 'playlists', offset: library.playlists.nextOffset };
    }
    if (library.albums.nextOffset !== null) {
      return { section: 'albums', offset: library.albums.nextOffset };
    }
    return null;
  };

  const onWindowChange = (view: VirtualWindow): void => {
    // Search results are a fixed page per type; only the library pages.
    if (query !== '' || onLoadMore === undefined) return;
    const wanted = pageWanted();
    if (wanted === null) return;
    if (
      !shouldLoadNextPage({
        endIndex: view.endIndex,
        rowCount: rows.length,
        nextOffset: wanted.offset,
      })
    ) {
      return;
    }
    const token = `${wanted.section}:${String(wanted.offset)}`;
    if (token === lastAsked) return;
    lastAsked = token;
    onLoadMore(wanted.section, wanted.offset);
  };
</script>

<section class="search" aria-label="Search">
  <header class="head">
    <p class="jf-label eyebrow">Search</p>
    <p class="jf-data readout" data-query={keyboard.text}>
      {#if keyboard.text === ''}
        <span class="hint">Your library</span>
      {:else}
        <span class="typed">{keyboard.text}</span>
      {/if}
      <span class="caret" aria-hidden="true"></span>
    </p>
  </header>

  <div class="results">
    {#if rows.length > 0}
      <VirtualList
        items={rows}
        height={listHeight}
        rowHeight={DEFAULT_ROW_HEIGHT}
        keyOf={(rowItem) => rowItem.id}
        label={query === '' ? 'Library' : 'Search results'}
        {onWindowChange}
      >
        {#snippet row(rowItem: ListRow)}
          {#if rowItem.kind === 'header'}
            <!-- A heading takes a whole row so every row is the same height:
                 uniform rows are what make the window arithmetic a division
                 rather than a running total. The label sits at the bottom of
                 its box, which turns the spare space into section air. -->
            <p class="jf-label group">{rowItem.label}</p>
          {:else}
            <ResultRow item={rowItem.item} {cache} {onPlay} />
          {/if}
        {/snippet}
      </VirtualList>
    {:else if answered}
      <!-- A sentence, not an error and not a spinner: the search worked, and
           the true answer is that Spotify has nothing under that. -->
      <p class="empty">Nothing found for “{query}”.</p>
    {/if}
  </div>

  <Keyboard state={keyboard} onKey={press} />
</section>

<style>
  .search {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    /* The plate, full: the same glass surface as everywhere else, grown to the
       whole panel because the keyboard needs the room (SCREENS.md). */
    background: var(--jf-plate-solid);
    color: var(--jf-ink);
  }

  @supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
    .search {
      background: var(--jf-plate);
      -webkit-backdrop-filter: blur(var(--jf-plate-blur)) saturate(1.4);
      backdrop-filter: blur(var(--jf-plate-blur)) saturate(1.4);
    }
  }

  .head {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--jf-gap-tight);
    box-sizing: border-box;
    height: 140px;
    flex: none;
    padding: 0 var(--jf-pad-plate);
    border-bottom: 1px solid var(--jf-plate-edge);
  }

  .eyebrow {
    margin: 0;
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .readout {
    display: flex;
    align-items: baseline;
    margin: 0;
    /* Larger than `.jf-data`'s 15px: this is the primary readout, and a query
       you cannot read back is one you cannot correct. At 23px mono roughly 48
       characters fit the panel, which is where MAX_QUERY_LENGTH comes from. */
    font-size: var(--jf-size-body);
    white-space: nowrap;
    overflow: hidden;
  }

  .typed {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hint {
    color: var(--jf-ink-faint);
  }

  .caret {
    width: 2px;
    height: 26px;
    margin-left: 4px;
    flex: none;
    background: var(--joshify-accent);
    animation: blink 1.1s steps(1, end) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }

  .results {
    flex: 1;
    min-height: 0;
  }

  .group {
    display: flex;
    align-items: flex-end;
    height: 100%;
    margin: 0;
    padding: 0 var(--jf-gap) var(--jf-gap-tight);
    box-sizing: border-box;
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .empty {
    margin: 0;
    padding: var(--jf-gap-wide) var(--jf-pad-plate);
    color: var(--jf-ink-dim);
    font-size: var(--jf-size-body);
  }
</style>
