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
    /** Last known playback. Null before the first snapshot lands. */
    state: PlaybackState | null;
    client: CommandClient;
    /** True when the account is not Premium: Spotify refuses every write. */
    disabled?: boolean | undefined;
    /** Where the commands are aimed. Absent means "whatever is active". */
    target?: CommandTarget | undefined;
    /** Monotonic reading, injected so tests need no real clock (D-023). */
    monotonic?: (() => number) | undefined;
  }

  const {
    state,
    client,
    disabled = false,
    target,
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

  const playback = $derived(state ?? IDLE_PLAYBACK);
  const item = $derived(playback.item);
  const isEpisode = $derived(item?.kind === 'episode');

  const model = createProgressModel(state ?? IDLE_PLAYBACK, monotonic());
  $effect(() => {
    model.observe(playback, monotonic());
  });

  const send = (command: Command): void => {
    // Not awaited on purpose: the failure path is the client's `onProblem`,
    // and the optimistic state rolls back on the next poll (D-028).
    void client.send(command, target);
  };

  const seekBy = (deltaMs: number): void => {
    const now = model.readAt(monotonic());
    const positionMs = Math.min(
      Math.max(0, now.positionMs + deltaMs),
      now.durationMs,
    );
    send({ kind: 'seek', positionMs: Math.round(positionMs) });
  };

  const togglePlay = (): void => {
    send(playback.isPlaying ? { kind: 'pause' } : { kind: 'play' });
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
    send({ kind: 'shuffle', enabled: !playback.shuffle });
  };

  const cycleRepeat = (): void => {
    send({ kind: 'repeat', mode: NEXT_REPEAT[playback.repeat] });
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
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" data-repeat={playback.repeat}>
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M6.5 7.5h10a3 3 0 013 3v1.5" />
      <path d="M17.5 16.5h-10a3 3 0 01-3-3V12" />
    </g>
    <path fill="currentColor" d="M17.4 11.5h4.2l-2.1 3.4z" />
    <path fill="currentColor" d="M2.4 12.5h4.2L4.5 9.1z" />
    {#if playback.repeat === 'track'}
      <text class="badge" x="12" y="14.4" text-anchor="middle">1</text>
    {/if}
  </svg>
{/snippet}

{#snippet stepGlyph(direction: 'back' | 'forward')}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      {#if direction === 'back'}
        <path d="M12 5.5A6.5 6.5 0 106.5 8.7" />
      {:else}
        <path d="M12 5.5a6.5 6.5 0 115.5 3.2" />
      {/if}
    </g>
    <path
      fill="currentColor"
      d={direction === 'back' ? 'M12 2.2v6.6L8 5.5z' : 'M12 2.2v6.6l4-3.3z'}
    />
    <text class="badge" x="12" y="19.5" text-anchor="middle">15</text>
  </svg>
{/snippet}

{#snippet skipGlyph(direction: 'back' | 'forward')}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    {#if direction === 'back'}
      <path d="M19 5v14l-10-7z" />
      <rect x="5" y="5" width="2.6" height="14" rx="1" />
    {:else}
      <path d="M5 5v14l10-7z" />
      <rect x="16.4" y="5" width="2.6" height="14" rx="1" />
    {/if}
  </svg>
{/snippet}

<div class="transport" role="group" aria-label="Transport">
  {#if item !== null}
    <TransportButton
      label="Shuffle"
      variant="toggle"
      active={playback.shuffle}
      {disabled}
      onpress={toggleShuffle}
    >
      {@render shuffleGlyph()}
    </TransportButton>

    <TransportButton
      label={isEpisode ? 'Back 15 seconds' : 'Previous track'}
      variant="skip"
      {disabled}
      onpress={back}
    >
      {#if isEpisode}{@render stepGlyph('back')}{:else}{@render skipGlyph('back')}{/if}
    </TransportButton>
  {/if}

  <TransportButton
    label={playback.isPlaying ? 'Pause' : 'Play'}
    variant="play"
    {disabled}
    onpress={togglePlay}
  >
    <svg class="glyph disc" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      {#if playback.isPlaying}
        <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
        <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
      {:else}
        <!-- Nudged right: an optically centred triangle sits off-centre. -->
        <path d="M8.5 5.2l10 6.8-10 6.8z" />
      {/if}
    </svg>
  </TransportButton>

  {#if item !== null}
    <TransportButton
      label={isEpisode ? 'Forward 15 seconds' : 'Next track'}
      variant="skip"
      {disabled}
      onpress={forward}
    >
      {#if isEpisode}
        {@render stepGlyph('forward')}
      {:else}
        {@render skipGlyph('forward')}
      {/if}
    </TransportButton>

    <TransportButton
      label="Repeat"
      variant="toggle"
      active={playback.repeat !== 'off'}
      {disabled}
      onpress={cycleRepeat}
    >
      {@render repeatGlyph()}
    </TransportButton>
  {/if}
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    /* Space-between rather than a gap: the row is the full width of the plate
       and the disc belongs in the middle of it, not in the middle of a huddle.
       With play alone — nothing playing — centring is what is left. */
    justify-content: space-between;
    width: 100%;
  }

  .transport:has(> :only-child) {
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
