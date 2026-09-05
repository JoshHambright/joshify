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
  import Scrubber from './components/Scrubber.svelte';
  import StatusRail from './components/StatusRail.svelte';
  import Transport from './components/Transport.svelte';
  import { artworkSources } from './lib/artwork.js';
  import { controlsDisabled, noticeFor } from './lib/notices.js';
  import type { CommandClient } from './lib/commands.js';
  import type { Connection } from './lib/connection.js';
  import type { DeviceSource } from './lib/device-source.js';

  interface Props {
    connection: Connection;
    client: CommandClient;
    devices: DeviceSource;
    /**
     * Undefined until the account has been read — and treated as Premium,
     * because accusing an account of being free before we know is the kind of
     * confident lie D-022 exists to prevent. P3-14 puts this on the wire.
     */
    isPremium?: boolean | undefined;
    /** Injected so the clock is testable, and so a device with no RTC can be
     *  handed the server's time later rather than showing 1970 (D-023). */
    now?: () => Date;
  }

  const {
    connection,
    client,
    devices,
    isPremium,
    now = () => new Date(),
  }: Props = $props();

  /** The plate at rest, or the plate grown. That is the whole of navigation. */
  let surface = $state<'now-playing' | 'devices'>('now-playing');
  let clock = $state('--:--');

  const playback = $derived($connection.state);
  const item = $derived(playback?.item ?? null);
  const art = $derived(artworkSources(item));
  const notice = $derived(
    noticeFor({
      link: $connection.link,
      state: playback,
      ...(isPremium === undefined ? {} : { isPremium }),
    }),
  );
  const controlsOff = $derived(controlsDisabled(notice));

  const showDevices = (): void => {
    surface = 'devices';
    devices.open();
  };

  const showNowPlaying = (): void => {
    surface = 'now-playing';
    devices.close();
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
      devices.close();
      connection.close();
    };
  });
</script>

<Panel>
  {#snippet stage()}
    <Backdrop src={art.backdrop} />
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
        <div class="grown">
          <div class="grown-head">
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

  .grown-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--jf-gap);
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
