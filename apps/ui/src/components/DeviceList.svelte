<script lang="ts">
  /**
   * Devices — the plate, grown (SCREENS.md).
   *
   * The highest-value screen after Now Playing: it is the "move it to the
   * kitchen" button, and it is why the panel is on the wall rather than in a
   * phone. Nothing navigates away from the album to get here; the same glass
   * plate simply grows to hold the list.
   *
   * The component holds no opinions of its own. The order of the rows, whether
   * a row can be tapped, and whether it may draw a slider are all decided by
   * pure functions in `lib/devices.ts`, where they are asserted in Node rather
   * than through a mounted DOM.
   *
   * The device list arrives as a prop. Fetching it is the server's business
   * (P4-01) and polling it is the connection's — this renders what it is told.
   */
  import type { PlaybackDevice } from '@joshify/core';
  import DeviceRow from './DeviceRow.svelte';
  import { deviceKey, sortDevices } from '../lib/devices.js';

  interface Props {
    devices: readonly PlaybackDevice[];
    /** Move playback. The id is always a real transfer target. */
    onTransfer: (deviceId: string) => void;
    onVolume: (deviceId: string, volumePercent: number) => void;
    /** Everything off — a free account, where Spotify refuses every write. */
    disabled?: boolean | undefined;
  }

  const { devices, onTransfer, onVolume, disabled = false }: Props = $props();

  const ordered = $derived(sortDevices(devices));
</script>

<section class="devices" aria-label="Devices">
  <p class="jf-label heading">Devices</p>

  {#if ordered.length === 0}
    <!-- Not an error, and not a spinner. An account with no Connect device
         visible is an ordinary Tuesday: nothing has opened Spotify recently. -->
    <p class="empty">
      Nothing to play on yet. Open Spotify anywhere on the account and it turns up here.
    </p>
  {:else}
    <ul class="list">
      {#each ordered as device (deviceKey(device))}
        <li>
          <DeviceRow {device} {onTransfer} {onVolume} {disabled} />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .devices {
    display: flex;
    flex-direction: column;
    gap: var(--jf-gap);
  }

  .heading {
    margin: 0;
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    /* The panel itself never scrolls (D-039), so a long list scrolls inside
       its own box. Eight rows is the most the grown plate can show without
       pushing the album off the screen entirely. */
    max-height: calc(88px * 8);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* A kiosk has no mouse and no scrollbar worth looking at. */
  .list::-webkit-scrollbar {
    display: none;
  }

  .empty {
    margin: 0;
    font-size: var(--jf-size-body);
    color: var(--jf-ink-dim);
  }
</style>
