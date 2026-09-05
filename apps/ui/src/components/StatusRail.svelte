<script lang="ts">
  /**
   * The status rail: which speaker, and whether the link is honest.
   *
   * The lamp is the whole reason this exists. A wall-mounted screen that has
   * lost its server looks exactly like one showing a paused track, and nobody
   * is standing next to it to click something and find out. So the link state
   * is always on screen — as a 10px dot, not a banner, because it is
   * reassurance 99.9% of the time and an explanation the rest.
   */
  import type { LinkStatus } from '../lib/connection.js';

  interface Props {
    deviceName: string | null;
    link: LinkStatus;
    clock: string;
  }

  const { deviceName, link, clock }: Props = $props();

  // "Reconnecting" is only worth saying once it has failed a few times; before
  // that it is a blip the viewer never needed to know about.
  const label = $derived(deviceName ?? 'No active device');
</script>

<div class="rail">
  <span class="lamp" data-link={link} aria-hidden="true"></span>
  <span class="jf-label name">{label}</span>
  <span class="jf-label kind">Spotify Connect</span>
  <span class="jf-data clock">{clock}</span>
</div>

<style>
  .rail {
    display: flex;
    align-items: center;
    gap: var(--jf-gap);
    width: 100%;
    color: var(--jf-ink-dim);
  }

  .lamp {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 50%;
    background: var(--joshify-accent);
    transition: background var(--jf-theme-fade) ease;
  }

  /* Amber, never a spinner: the last known state stays on screen (SCREENS.md). */
  .lamp[data-link='reconnecting'] {
    background: #e0a23c;
  }

  .lamp[data-link='connecting'] {
    background: var(--jf-ink-faint);
  }

  .name {
    color: var(--jf-ink);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .kind {
    color: var(--jf-ink-faint);
  }

  .clock {
    margin-left: auto;
    color: var(--jf-ink-dim);
  }
</style>
