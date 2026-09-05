<script lang="ts">
  /**
   * The shell (P3-06). It wires the connection store to the panel and nothing
   * else: the transport (P3-10), the scrubber (P3-11) and the crossfading hero
   * (P3-08) each land in their own task, into the slots below.
   *
   * What it does own is the honesty rules from SCREENS.md, because they are
   * about *state*, not about any one control: never a raw error, never a
   * spinner where a last-known truth exists, and never a blank screen because
   * a packet dropped.
   */
  import { onMount } from 'svelte';
  import { playingItemKey, selectArtwork } from '@joshify/core';
  import Panel from './components/Panel.svelte';
  import Plate from './components/Plate.svelte';
  import Stage from './components/Stage.svelte';
  import StatusRail from './components/StatusRail.svelte';
  import { formatTime } from './lib/format.js';
  import type { Connection } from './lib/connection.js';

  interface Props {
    connection: Connection;
    /** Injected so the clock is testable and so a device with no RTC can be
     *  given the server's time later rather than showing 1970 (D-023). */
    now?: () => Date;
  }

  const { connection, now = () => new Date() }: Props = $props();

  // `connection` implements the Svelte store contract, so `$connection` is the
  // subscription — which is exactly why the store was written that way rather
  // than as a rune: the same object is driven by a fake socket in Node tests.
  let clock = $state('--:--');

  const item = $derived($connection.state?.item ?? null);
  const device = $derived($connection.state?.device ?? null);
  const artUrl = $derived(
    item === null ? null : (selectArtwork(item.images, 720)?.url ?? null),
  );
  const trackKey = $derived(item === null ? null : playingItemKey(item));

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
    return () => {
      clearInterval(ticking);
      connection.close();
    };
  });
</script>

<Panel>
  {#snippet stage()}
    <Stage src={artUrl} {trackKey} />
  {/snippet}

  {#snippet rail()}
    <StatusRail deviceName={device?.name ?? null} link={$connection.link} {clock} />
  {/snippet}

  {#snippet plate()}
    <Plate>
      {#if item === null}
        <!-- Not an error, and not a spinner: there is genuinely nothing
             playing, and saying so is the whole message. -->
        <p class="jf-label eyebrow">Joshify</p>
        <h1 class="title">Nothing playing</h1>
        <!-- An offer, not an error. The rail already says *that* there is no
             device; the plate says what to do about it, and Phase 4 (P4-02)
             makes this the tappable primary action. -->
        <p class="subtitle">{device === null ? 'Choose a device' : device.name}</p>
      {:else}
        <p class="jf-label eyebrow">
          Playing from {item.kind === 'episode' ? 'podcast' : 'album'}
        </p>
        <h1 class="title">{item.title}</h1>
        <p class="subtitle">{item.subtitle}</p>
        <p class="jf-data times">
          {formatTime($connection.state?.progressMs ?? null)} · {formatTime(
            item.durationMs,
          )}
        </p>
      {/if}
    </Plate>
  {/snippet}
</Panel>

<style>
  .eyebrow {
    margin: 0 0 var(--jf-gap-tight);
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
       the plate's height is the layout. */
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .subtitle {
    margin: var(--jf-gap-tight) 0 0;
    font-size: var(--jf-size-body);
    color: var(--jf-ink-dim);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .times {
    margin: var(--jf-gap) 0 0;
    color: var(--jf-ink-faint);
  }
</style>
