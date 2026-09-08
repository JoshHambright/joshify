<script lang="ts">
  /**
   * The panel, composed.
   *
   * Everything below is arrangement — which component gets which slice of
   * state, and which surface the plate is showing. No decision about *what is
   * true* is made here: the notice logic is `noticeFor`, the artwork choice is
   * `artworkSources`, the progress model lives in the transport and scrubber,
   * and the device ordering is `sortDevices`. This file is where they meet, and
   * it should stay boring enough that a change to it is obviously safe.
   *
   * The one idea it does own is the navigation model from SCREENS.md: there is
   * one plate, and it grows. Devices is not a page — it is this plate, taller.
   * Nothing ever navigates away from the album, which is why there is no back
   * button, no tab bar and no transition here to design.
   */
  import { onMount } from 'svelte';
  import Backdrop from './components/Backdrop.svelte';
  import DeviceList from './components/DeviceList.svelte';
  import Hero from './components/Hero.svelte';
  import Panel from './components/Panel.svelte';
  import PlaybackNotice from './components/PlaybackNotice.svelte';
  import Plate from './components/Plate.svelte';
  import QueueList from './components/QueueList.svelte';
  import SearchScreen from './components/SearchScreen.svelte';
  import Scrubber from './components/Scrubber.svelte';
  import StatusRail from './components/StatusRail.svelte';
  import Transport from './components/Transport.svelte';
  import Visualiser from './components/Visualiser.svelte';
  import VisualList from './components/VisualList.svelte';
  import { resolvedArtwork } from './lib/artwork.js';
  import { controlsDisabled, noticeFor } from './lib/notices.js';
  import { dismissible } from './lib/dismissible.js';
  import {
    createThemeApplier,
    type StyleTarget,
    type ThemeApplier,
  } from './lib/theme.js';
  import type { CommandClient } from './lib/commands.js';
  import type { Connection } from './lib/connection.js';
  import type { DeviceSource } from './lib/device-source.js';
  import type { QueueSource } from './lib/queue-source.js';
  import type { SearchSource } from './lib/search-source.js';
  import { createModeMachine, type ModeState } from './gl/modes.js';
  import { buildThemes, paletteFor } from './gl/themes.js';
  import { createChromeApplier, type ChromeApplier } from './lib/chrome.js';
  import { DEFAULT_THEME, playingItemKey } from '@joshify/core';
  import type { LibraryItem, LibrarySection } from './lib/thumbnails.js';

  interface Props {
    connection: Connection;
    client: CommandClient;
    devices: DeviceSource;
    queue: QueueSource;
    search: SearchSource;
    /**
     * Where the album's five tokens are written. The document root by default,
     * because the body background and the plate's `backdrop-filter` both read
     * them and the body sits outside this component's subtree. Injectable so a
     * test can assert the write without a real document.
     */
    themeTarget?: StyleTarget | undefined;
    /** Injected so the clock is testable, and so a device with no RTC can be
     *  handed the server's time later rather than showing 1970 (D-023). */
    now?: () => Date;
    /**
     * The monotonic clock the visualiser mode runs on.
     *
     * Deliberately separate from `now`. The mode machine compares an instant
     * against the last touch, and the render loop ticks it with a frame
     * timestamp — so both have to be on `performance.now()`'s epoch. Mixing in
     * a wall clock makes every tick look like decades since the last touch,
     * and the panel goes idle instantly and permanently.
     */
    monotonic?: () => number;
  }

  const {
    connection,
    client,
    devices,
    queue,
    search,
    themeTarget,
    now = () => new Date(),
    monotonic = () => performance.now(),
  }: Props = $props();

  /** The plate at rest, or the plate grown. That is the whole of navigation. */
  let surface = $state<'now-playing' | 'devices' | 'queue' | 'search' | 'visuals'>(
    'now-playing',
  );
  /*
   * The theme roster (P5-31), built once.
   *
   * A theme that will not resolve is dropped rather than shown — `buildThemes`
   * returns why — so this list is only ever themes that actually work. There
   * is always at least one: `night` names the default look, and a build with
   * no themes at all would have failed its own test long before here.
   */
  const { themes: visualThemes } = buildThemes();
  let themeId = $state(visualThemes[0]?.id ?? 'night');
  let shuffleLooks = $state(false);
  const activeTheme = $derived(
    visualThemes.find((theme) => theme.id === themeId) ?? visualThemes[0] ?? null,
  );

  /** How far a dismiss gesture has dragged the grown surface. */
  let dragOffset = $state(0);
  let clock = $state('--:--');

  const playback = $derived($connection.state);
  const item = $derived(playback?.item ?? null);
  // Prefers the device's own cache, but only for the track actually on screen
  // — a stale colour is invisible, a stale album cover is not (D-053).
  const art = $derived(
    resolvedArtwork(item, {
      heroUrl: playback?.heroUrl ?? null,
      backdropUrl: playback?.backdropUrl ?? null,
      presentationFor: playback?.presentationFor ?? null,
    }),
  );
  const isPremium = $derived(playback?.isPremium ?? null);
  const notice = $derived(
    noticeFor({
      link: $connection.link,
      state: playback,
      ...(isPremium === null ? {} : { isPremium }),
    }),
  );

  /**
   * Write the album's colour whenever it changes.
   *
   * Deliberately *not* gated on `themeFor` matching the current item. The
   * theme legitimately lands a few hundred milliseconds after the track that
   * prompted it, and holding the previous album's colour across that gap is
   * the point — snapping to neutral grey and back would be a visible flicker
   * on every track change (D-050). The applier already skips a write when the
   * tokens are unchanged, so a poll that changes nothing costs nothing.
   */
  let applier: ThemeApplier | null = null;
  $effect(() => {
    // Built on first run rather than at init: writing five custom properties
    // is a side effect, and side effects belong in an effect.
    applier ??= createThemeApplier(themeTarget ?? document.documentElement);
    const album = playback?.theme;
    // Nothing to say yet: no theme has pinned a palette and no album has
    // arrived. Writing the neutral default here would be the flicker D-050
    // exists to avoid, one frame before the real colour lands.
    if ((activeTheme?.palette ?? null) === null && album === undefined) return;
    applier.apply(paletteFor(activeTheme, album ?? DEFAULT_THEME));
  });

  /**
   * The chosen theme's chrome (P5-32).
   *
   * A separate applier from the palette's because the two change on different
   * clocks: the palette moves with the album, several times an hour, and the
   * chrome moves only when somebody picks a different theme. It also *unsets*
   * what the last theme wrote, which is the half that is easy to leave out —
   * an inline custom property outranks the stylesheet, so a theme that says
   * nothing about a token only gets the default if the previous value is
   * removed (D-073).
   */
  let chrome: ChromeApplier | null = null;
  $effect(() => {
    chrome ??= createChromeApplier(themeTarget ?? document.documentElement);
    chrome.apply(activeTheme?.chrome ?? {});
  });
  const controlsOff = $derived(controlsDisabled(notice));

  const showDevices = (): void => {
    surface = 'devices';
    queue.close();
    devices.open();
  };

  const showQueue = (): void => {
    surface = 'queue';
    devices.close();
    queue.open();
  };

  /**
   * Search is the one surface that takes the whole panel, because the keyboard
   * needs it (SCREENS.md). Everything else is the plate, grown.
   */
  const showSearch = (): void => {
    surface = 'search';
    devices.close();
    queue.close();
    void search.query('');
  };

  const showNowPlaying = (): void => {
    surface = 'now-playing';
    dragOffset = 0;
    devices.close();
    queue.close();
  };

  /**
   * Play what was tapped.
   *
   * An album or a playlist plays *in context* so the queue fills with the rest
   * of it; a track plays alone. Sending a track's uri as a context would be
   * rejected, and sending an album's as a single track would drop everything
   * after the first song (P6-07).
   */
  // Named rather than inline: a callback written in the template loses its
  // parameter types to `any`, which `strictTypeChecked` then refuses.
  const setDrag = (offset: number): void => {
    dragOffset = offset;
  };

  const runQuery = (text: string): void => {
    void search.query(text);
  };

  const loadMore = (section: LibrarySection, offset: number): void => {
    void search.loadMore(section, offset);
  };

  const play = (item: LibraryItem): void => {
    if (item.uri !== null) {
      void client.send({ kind: 'play', contextUri: item.uri });
    }
    showNowPlaying();
  };

  const transfer = (deviceId: string): void => {
    void client.send({ kind: 'transfer', deviceId });
    // Refresh rather than wait out the poll: the lamp should move with the tap.
    void devices.refresh();
    showNowPlaying();
  };

  const setVolume = (deviceId: string, volumePercent: number): void => {
    void client.send({ kind: 'volume', volumePercent }, { deviceId });
  };

  /*
   * The visualiser mode (P5-15).
   *
   * The machine is the whole policy — when to go idle, and that the touch
   * which wakes the panel is swallowed rather than delivered (D-067). What is
   * here is the two things it cannot do for itself: be ticked, and be told
   * that a finger landed.
   *
   * It is ticked from two places on purpose. The render loop ticks it while it
   * is running, which is the accurate path; this interval ticks it while the
   * loop is *stopped*, which is exactly the resting state a panel has to be
   * able to go idle from. `tick` is idempotent, so both is fine and neither
   * alone is enough.
   */
  const modes = createModeMachine();
  let modeState = $state<ModeState>(modes.state());
  /** The loop is stopped at rest, where the canvas is transparent anyway. */
  const visualiserActive = $derived(modeState.mode !== 'now-playing');
  let visualiserAvailable = $state(true);

  const tickModes = (): void => {
    modes.tick(monotonic());
    modeState = modes.state();
  };

  /**
   * Capture, and on `pointerdown` rather than `click`.
   *
   * Capture because the whole point is to decide before the control underneath
   * sees the event; `pointerdown` because a tap that wakes the panel should
   * bring the plate back as the finger lands, not when it lifts.
   */
  let swallowClick = false;

  const onPointerDown = (event: PointerEvent): void => {
    const { deliver } = modes.touched(monotonic());
    modeState = modes.state();
    // Set on every pointer down, so a swallow that never produced a click —
    // a drag, a touch that slid off — cannot leak into the next tap.
    swallowClick = !deliver;
    if (deliver) return;
    event.stopPropagation();
    event.preventDefault();
  };

  /**
   * The second half of the swallow.
   *
   * Stopping the `pointerdown` is not enough on its own: controls act on
   * `click`, and whether `preventDefault` on a pointer event suppresses the
   * click that follows it is implementation-defined. So the decision is made
   * once, when the finger lands, and the click it goes on to produce is
   * cancelled explicitly rather than hopefully.
   */
  const onClick = (event: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const takePanel = (): void => {
    modes.setMode('full', monotonic());
    modeState = modes.state();
    // The plate is about to be hidden; leaving a grown surface open behind it
    // means the next touch brings back a screen nobody asked for.
    surface = 'now-playing';
  };

  const showVisuals = (): void => {
    surface = 'visuals';
    // Nothing to open: the theme roster is built at start-up and polls nothing.
    // Closing the other two matters, though — a list left polling behind a
    // surface nobody is looking at is the exact waste D-051 set out to stop.
    devices.close();
    queue.close();
  };

  const tickClock = (): void => {
    const at = now();
    clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  };

  onMount(() => {
    connection.open();
    tickClock();
    // Once a minute is enough for a wall clock, and it costs nothing next to
    // the poll loop.
    const ticking = setInterval(tickClock, 30_000);
    // A second is far finer than a 45-second idle timeout needs, and it is the
    // resolution at which "the panel went quiet" stops feeling like a lag.
    const modeTicking = setInterval(tickModes, 1000);
    return () => {
      clearInterval(ticking);
      clearInterval(modeTicking);
      devices.close();
      queue.close();
      connection.close();
    };
  });
</script>

<svelte:window onpointerdowncapture={onPointerDown} onclickcapture={onClick} />

<Panel chromeVisible={modeState.chromeVisible}>
  {#snippet stage()}
    <Backdrop src={art.backdrop} />
    {#if visualiserAvailable}
      <Visualiser
        art={art.hero}
        theme={playback?.theme ?? DEFAULT_THEME}
        trackKey={playingItemKey(item)}
        {modes}
        active={visualiserActive}
        lookId={activeTheme?.preset.id ?? null}
        shuffle={shuffleLooks}
        onUnavailable={() => {
          // Not an error: a panel with the CSS wash and no visualiser is a
          // complete product, and the controls must not go down with it.
          visualiserAvailable = false;
        }}
      />
    {/if}
    <Hero src={art.hero} dimmed={item === null} />
  {/snippet}

  {#snippet rail()}
    <StatusRail
      deviceName={playback?.device?.name ?? null}
      link={$connection.link}
      {clock}
    />
  {/snippet}

  {#snippet plate()}
    <Plate>
      {#if surface === 'devices'}
        <div class="grown" style="--drag: {dragOffset}px">
          <div
            class="grown-head"
            use:dismissible={{ onDismiss: showNowPlaying, onOffset: setDrag }}
          >
            <span class="grip" aria-hidden="true"></span>
            <h2 class="jf-label heading">Devices</h2>
            <button class="close" type="button" onclick={showNowPlaying}>Done</button>
          </div>
          <DeviceList
            devices={$devices.devices}
            onTransfer={transfer}
            onVolume={setVolume}
            disabled={controlsOff}
          />
        </div>
      {:else if surface === 'queue'}
        <div class="grown" style="--drag: {dragOffset}px">
          <div
            class="grown-head"
            use:dismissible={{ onDismiss: showNowPlaying, onOffset: setDrag }}
          >
            <span class="grip" aria-hidden="true"></span>
            <h2 class="jf-label heading">Queue</h2>
            <button class="close" type="button" onclick={showNowPlaying}>Done</button>
          </div>
          <QueueList
            queue={$queue.queue}
            pending={$queue.pending}
            problem={$queue.problem}
          />
        </div>
      {:else if surface === 'search'}
        <div class="grown" style="--drag: {dragOffset}px">
          <div
            class="grown-head"
            use:dismissible={{ onDismiss: showNowPlaying, onOffset: setDrag }}
          >
            <span class="grip" aria-hidden="true"></span>
            <h2 class="jf-label heading">Search</h2>
            <button class="close" type="button" onclick={showNowPlaying}>Done</button>
          </div>
          <SearchScreen
            results={$search.results}
            library={$search.library}
            onQueryChange={runQuery}
            onPlay={play}
            onLoadMore={loadMore}
          />
        </div>
      {:else if surface === 'visuals'}
        <div class="grown" style="--drag: {dragOffset}px">
          <div
            class="grown-head"
            use:dismissible={{ onDismiss: showNowPlaying, onOffset: setDrag }}
          >
            <span class="grip" aria-hidden="true"></span>
            <h2 class="jf-label heading">Visuals</h2>
            <button class="close" type="button" onclick={showNowPlaying}>Done</button>
          </div>
          <VisualList
            themes={visualThemes}
            currentId={activeTheme?.id ?? ''}
            shuffle={shuffleLooks}
            available={visualiserAvailable}
            onSelect={(id: string) => {
              themeId = id;
            }}
            onShuffle={(on: boolean) => {
              shuffleLooks = on;
            }}
            onFullScreen={takePanel}
          />
        </div>
      {:else if notice !== null}
        <PlaybackNotice {notice} onChooseDevice={showDevices} />
      {:else if item !== null}
        <Scrubber {playback} {client} disabled={controlsOff} />
        <p class="jf-label eyebrow">
          Playing from {item.kind === 'episode' ? 'podcast' : 'album'}
        </p>
        <h1 class="title">{item.title}</h1>
        <p class="subtitle">{item.subtitle}</p>
        <Transport {playback} {client} disabled={controlsOff} />
        <div class="chips">
          <button class="chip jf-label" type="button" onclick={showDevices}>
            {playback?.device?.name ?? 'Devices'}
          </button>
          <button class="chip jf-label" type="button" onclick={showQueue}>Queue</button>
          <button class="chip jf-label" type="button" onclick={showSearch}>Search</button>
          <button class="chip jf-label" type="button" onclick={showVisuals}>Visual</button
          >
        </div>
      {/if}
    </Plate>
  {/snippet}
</Panel>

<style>
  .eyebrow {
    margin: var(--jf-gap) 0 var(--jf-gap-tight);
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .title {
    margin: 0;
    font-size: var(--jf-size-title);
    font-weight: 800;
    line-height: 1.05;
    color: var(--jf-ink);
    /* One line, ellipsised. A wrapping title changes the plate's height, and
       the plate's height is the layout (D-039). */
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .subtitle {
    margin: var(--jf-gap-tight) 0 var(--jf-gap-wide);
    font-size: var(--jf-size-body);
    color: var(--jf-ink-dim);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* The grown surface follows the dismiss gesture. `translate` only — it is a
     compositor property, so a drag costs no layout and no repaint. */
  .grown {
    translate: 0 var(--drag, 0px);
  }

  .grown-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--jf-gap);
    margin-bottom: var(--jf-gap);
    /* The header is the drag handle, so the browser must not claim vertical
       gestures here for its own scrolling. */
    touch-action: none;
  }

  /* The only affordance the gesture gets: a grab bar, because a surface that
     can be dragged has to look like it can. Everything else about the gesture
     is invisible until a finger is on it (SCREENS.md: gesture + tap, no
     chrome). */
  .grip {
    width: 44px;
    height: 4px;
    flex: none;
    border-radius: 2px;
    background: var(--jf-ink-faint);
  }

  .heading {
    margin-right: auto;
  }

  .heading {
    margin: 0;
    font-size: var(--jf-size-heading);
    color: var(--jf-ink);
  }

  .chips {
    display: flex;
    gap: var(--jf-gap-tight);
    margin-top: var(--jf-gap-wide);
  }

  .chip,
  .close {
    min-height: var(--jf-touch-min);
    padding: 0 var(--jf-gap);
    border: 1px solid var(--jf-plate-edge);
    border-radius: calc(var(--jf-touch-min) / 2);
    background: transparent;
    color: var(--jf-ink-dim);
    font: inherit;
    letter-spacing: var(--jf-track-label);
    text-transform: uppercase;
  }

  /* No hover: this is an appliance being touched. `:active` is the only
     feedback that matters, because the round trip is not immediate (D-028). */
  .chip:active,
  .close:active {
    color: var(--jf-ink);
    border-color: var(--joshify-accent);
  }
</style>
