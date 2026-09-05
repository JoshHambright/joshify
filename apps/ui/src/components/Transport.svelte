<script lang="ts">
  /**
   * The transport row: shuffle, back, play, forward, repeat.
   *
   * **Deliberately unequal** (D-040, SCREENS.md). Play is a 96px accent disc,
   * skip is a bare glyph with no box, and shuffle and repeat stay
   * `--jf-ink-faint` until they are on. Five equal-weight keys were most of why
   * the first attempt read as a generic media player, so the hierarchy is the
   * design rather than a finish applied to one.
   *
   * Two things worth knowing about what it sends:
   *
   * - **Nothing is awaited.** The server answers as soon as Spotify accepts,
   *   and the proof arrives on the socket after the next poll (D-028). A
   *   control that greyed itself out until then would feel slower than the
   *   speaker it is driving.
   * - **A podcast's skip keys are ±15s, not next/previous** (SCREENS.md), and
   *   ±15 seconds from *where the bar actually is*, not from the last polled
   *   position — which is up to three seconds stale (D-025). So this holds its
   *   own progress model and reads it at the instant of the tap. Two models
   *   over the same state cannot disagree: they are the same pure function of
   *   the same inputs, and only the scrubber's ever has a finger on it.
   *
   * The glyphs are drawn rather than typed. The panel's faces are self-hosted
   * and carry no media symbols (SCREENS.md), so `⏮` on the device would be a
   * tofu box or, worse, whatever fallback font the kiosk happens to have.
   */
  import { IDLE_PLAYBACK, type PlaybackState, type RepeatMode } from '@joshify/core';
  import TransportButton from './TransportButton.svelte';
  import { createProgressModel } from '../lib/progress.js';
  import type { Command, CommandClient, CommandTarget } from '../lib/commands.js';

  interface Props {
    /**
     * Last known playback. Null before the first snapshot lands.
     * Not called `state`: a variable of that name makes `$state` parse as a
     * store subscription rather than as a rune, and it fails at mount rather
     * than at build. Avoided in every component, not only the ones that
     * happen to hold local state today.
     */
    playback: PlaybackState | null;
    client: CommandClient;
    /** True when the account is not Premium: Spotify refuses every write. */
    disabled?: boolean | undefined;
    /**
     * Where the commands are aimed. Absent means "whatever is active".
     * Not called `target`: that is one of Svelte's own mount options, and a
     * component prop by that name is silently ambiguous at every call site.
     */
    commandTarget?: CommandTarget | undefined;
    /** Monotonic reading, injected so tests need no real clock (D-023). */
    monotonic?: (() => number) | undefined;
  }

  const {
    playback,
    client,
    disabled = false,
    commandTarget,
    monotonic = () => performance.now(),
  }: Props = $props();

  /** SCREENS.md: a podcast skips by a fixed step rather than by item. */
  const PODCAST_STEP_MS = 15_000;

  /**
   * Off → all → one, which is the order every Spotify client cycles in. A
   * different order would be defensible and would still surprise everybody.
   */
  const NEXT_REPEAT: Readonly<Record<RepeatMode, RepeatMode>> = {
    off: 'context',
    context: 'track',
    track: 'off',
  };

  const current = $derived(playback ?? IDLE_PLAYBACK);
  const item = $derived(current.item);
  const isEpisode = $derived(item?.kind === 'episode');

  // Seeded idle rather than from the prop: the effect below observes the real
  // thing before the first paint, and reading a prop at init would capture its
  // initial value forever.
  const model = createProgressModel(IDLE_PLAYBACK, 0);
  $effect(() => {
    model.observe(current, monotonic());
  });

  const send = (command: Command): void => {
    // Not awaited on purpose: the failure path is the client's `onProblem`,
    // and the optimistic state rolls back on the next poll (D-028).
    void client.send(command, commandTarget);
  };

  const seekBy = (deltaMs: number): void => {
    const now = model.readAt(monotonic());
    const positionMs = Math.min(Math.max(0, now.positionMs + deltaMs), now.durationMs);
    send({ kind: 'seek', positionMs: Math.round(positionMs) });
  };

  const togglePlay = (): void => {
    send(current.isPlaying ? { kind: 'pause' } : { kind: 'play' });
  };

  const back = (): void => {
    if (isEpisode) seekBy(-PODCAST_STEP_MS);
    else send({ kind: 'previous' });
  };

  const forward = (): void => {
    if (isEpisode) seekBy(PODCAST_STEP_MS);
    else send({ kind: 'next' });
  };

  const toggleShuffle = (): void => {
    send({ kind: 'shuffle', enabled: !current.shuffle });
  };

  const cycleRepeat = (): void => {
    send({ kind: 'repeat', mode: NEXT_REPEAT[current.repeat] });
  };
</script>

{#snippet shuffleGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M3 7h3.5l9 10H19" />
      <path d="M3 17h3.5l2.6-2.9" />
      <path d="M13.9 9.9L15.5 7H19" />
    </g>
    <path fill="currentColor" d="M17.4 3.6L21 7l-3.6 3.4z" />
    <path fill="currentColor" d="M17.4 13.6L21 17l-3.6 3.4z" />
  </svg>
{/snippet}

{#snippet repeatGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" data-repeat={current.repeat}>
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M6.5 7.5h10a3 3 0 013 3v1.5" />
      <path d="M17.5 16.5h-10a3 3 0 01-3-3V12" />
    </g>
    <path fill="currentColor" d="M17.4 11.5h4.2l-2.1 3.4z" />
    <path fill="currentColor" d="M2.4 12.5h4.2L4.5 9.1z" />
    {#if current.repeat === 'track'}
      <text class="badge" x="12" y="14.4" text-anchor="middle">1</text>
    {/if}
  </svg>
{/snippet}

{#snippet playGlyph()}
  <!-- Nudged right: an optically centred triangle sits off geometric centre. -->
  <svg class="glyph disc" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M8.5 5.2l10 6.8-10 6.8z" />
  </svg>
{/snippet}

{#snippet pauseGlyph()}
  <svg class="glyph disc" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
  </svg>
{/snippet}

{#snippet skipBackGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M19 5v14l-10-7z" />
    <rect x="5" y="5" width="2.6" height="14" rx="1" />
  </svg>
{/snippet}

{#snippet skipForwardGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M5 5v14l10-7z" />
    <rect x="16.4" y="5" width="2.6" height="14" rx="1" />
  </svg>
{/snippet}

{#snippet stepBackGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 5.5A6.5 6.5 0 106.5 8.7"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    />
    <path fill="currentColor" d="M12 2.2v6.6L8 5.5z" />
    <text class="badge" x="12" y="19.5" text-anchor="middle">15</text>
  </svg>
{/snippet}

{#snippet stepForwardGlyph()}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 5.5a6.5 6.5 0 115.5 3.2"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    />
    <path fill="currentColor" d="M12 2.2v6.6l4-3.3z" />
    <text class="badge" x="12" y="19.5" text-anchor="middle">15</text>
  </svg>
{/snippet}

<div class="transport" class:solo={item === null} role="group" aria-label="Transport">
  {#if item !== null}
    <TransportButton
      label="Shuffle"
      variant="toggle"
      active={current.shuffle}
      {disabled}
      onpress={toggleShuffle}
      children={shuffleGlyph}
    />

    <TransportButton
      label={isEpisode ? 'Back 15 seconds' : 'Previous track'}
      variant="skip"
      {disabled}
      onpress={back}
      children={isEpisode ? stepBackGlyph : skipBackGlyph}
    />
  {/if}

  <TransportButton
    label={current.isPlaying ? 'Pause' : 'Play'}
    variant="play"
    {disabled}
    onpress={togglePlay}
    children={current.isPlaying ? pauseGlyph : playGlyph}
  />

  {#if item !== null}
    <TransportButton
      label={isEpisode ? 'Forward 15 seconds' : 'Next track'}
      variant="skip"
      {disabled}
      onpress={forward}
      children={isEpisode ? stepForwardGlyph : skipForwardGlyph}
    />

    <TransportButton
      label="Repeat"
      variant="toggle"
      active={current.repeat !== 'off'}
      {disabled}
      onpress={cycleRepeat}
      children={repeatGlyph}
    />
  {/if}
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    /* Space-between rather than a gap: the row is the full width of the plate
       and the disc belongs in the middle of it, not in the middle of a huddle.
       With play alone — nothing playing — there is nothing to space, so it is
       centred instead. */
    justify-content: space-between;
    width: 100%;
  }

  .transport.solo {
    justify-content: center;
  }

  .glyph {
    width: 34px;
    height: 34px;
    display: block;
  }

  .glyph.disc {
    width: 44px;
    height: 44px;
  }

  .badge {
    fill: currentColor;
    font-family: var(--jf-face-data);
    font-size: 8px;
  }
</style>
