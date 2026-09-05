<script lang="ts">
  /**
   * One device: 88px of full-width row carrying a name, a type glyph, an
   * accent lamp when it is the one playing, and a volume slider *only* when
   * the device actually reports a volume (D-022).
   *
   * The row is not a button wrapping its contents, because one of those
   * contents is a slider and a control inside a control is a fight over every
   * touch. Instead the button sits behind everything, filling the row, and the
   * contents float over it with `pointer-events: none` — except the slider,
   * which takes its own touches back. Tapping anywhere else is a transfer.
   *
   * A row with no transfer target — restricted (`id: null`), or the device
   * already playing — renders no button at all. An affordance that cannot work
   * is worse than a missing one (the principle behind D-007), and the active
   * device is not somewhere to move music *to*.
   */
  import type { PlaybackDevice } from '@joshify/core';
  import VolumeSlider from './VolumeSlider.svelte';
  import {
    deviceKind,
    deviceTypeLabel,
    showsVolume,
    transferTargetId,
  } from '../lib/devices.js';

  interface Props {
    device: PlaybackDevice;
    onTransfer: (deviceId: string) => void;
    onVolume: (deviceId: string, volumePercent: number) => void;
    /** Everything off — a free account, where Spotify refuses every write. */
    disabled?: boolean | undefined;
  }

  const { device, onTransfer, onVolume, disabled = false }: Props = $props();

  const target = $derived(disabled ? null : transferTargetId(device));
  const kind = $derived(deviceKind(device.type));
  const typeLabel = $derived(deviceTypeLabel(device.type));
  const volume = $derived(showsVolume(device) ? device.volumePercent : null);
</script>

<div class="row" class:active={device.isActive} class:restricted={device.id === null}>
  {#if target !== null}
    <button
      class="hit"
      type="button"
      aria-label="Play on {device.name}"
      onclick={() => {
        onTransfer(target);
      }}
    ></button>
  {/if}

  <span class="glyph" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      {#if kind === 'speaker'}
        <rect x="6" y="2" width="12" height="20" rx="2.5" />
        <circle cx="12" cy="15" r="3.4" />
        <circle cx="12" cy="6.6" r="1.1" />
      {:else if kind === 'phone'}
        <rect x="7" y="2" width="10" height="20" rx="2.5" />
        <path d="M10.5 18.6h3" />
      {:else if kind === 'tablet'}
        <rect x="4" y="2.5" width="16" height="19" rx="2.5" />
        <path d="M10.5 18.6h3" />
      {:else if kind === 'computer'}
        <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
        <path d="M2 20h20" />
      {:else if kind === 'tv'}
        <rect x="2" y="6.5" width="20" height="13" rx="2" />
        <path d="M8.5 2.5 12 6.5l3.5-4" />
      {:else if kind === 'car'}
        <path d="M3.5 12.5 6 6.5h12l2.5 6" />
        <rect x="2" y="12.5" width="20" height="5.5" rx="2" />
        <circle cx="7" cy="18" r="1.4" />
        <circle cx="17" cy="18" r="1.4" />
      {:else if kind === 'console'}
        <rect x="2" y="7" width="20" height="10" rx="5" />
        <path d="M7 10.5v3M5.5 12h3" />
        <circle cx="16.5" cy="12" r="1.2" />
      {:else if kind === 'cast'}
        <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
        <path d="M3 20a2 2 0 0 0-2-2" />
        <path d="M7 20a6 6 0 0 0-6-6" />
      {:else}
        <rect x="3" y="3" width="18" height="18" rx="4.5" />
        <circle cx="12" cy="12" r="1.6" />
      {/if}
    </svg>
  </span>

  <span class="text">
    <span class="name">{device.name}</span>
    <span class="jf-label type"
      >{typeLabel}{device.isActive ? ' · Playing here' : ''}</span
    >
  </span>

  {#if volume !== null}
    <span class="volume">
      <VolumeSlider
        volumePercent={volume}
        label="{device.name} volume"
        {disabled}
        onVolume={(percent: number) => {
          if (device.id !== null) onVolume(device.id, percent);
        }}
      />
    </span>
  {/if}

  {#if device.isActive}
    <!-- The lamp, and the only accent on the row: which speaker is playing is
         the one fact this screen exists to state. -->
    <span class="lamp" aria-hidden="true"></span>
  {/if}
</div>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--jf-gap);
    box-sizing: border-box;
    /* 88px, per SCREENS.md — comfortably past the 56px floor for anything
       important, because this is the "move it to the kitchen" button. */
    height: 88px;
    padding: 0 var(--jf-gap);
    border-radius: 14px;
    color: var(--jf-ink);
  }

  /* The tappable surface, behind everything, so the slider can keep its own
     touches without the two controls being nested. */
  .hit {
    position: absolute;
    inset: 0;
    width: 100%;
    padding: 0;
    border: none;
    border-radius: inherit;
    background: transparent;
    /* Not a hover affordance: this is the press feedback, and it is the only
       answer the viewer gets before the network replies. */
    transition: background var(--jf-press) ease;
  }

  .hit:active {
    background: rgb(255 255 255 / 0.09);
  }

  .glyph,
  .text,
  .lamp {
    position: relative;
    /* Taps fall through to the button underneath. */
    pointer-events: none;
  }

  .glyph {
    display: flex;
    flex: none;
    color: var(--jf-ink-dim);
  }

  .glyph svg {
    width: 28px;
    height: 28px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-size: var(--jf-size-body);
    font-weight: 700;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .type {
    color: var(--jf-ink-faint);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .volume {
    position: relative;
    /* The one region that keeps its own touches: everything else on the row is
       a transfer. */
    pointer-events: auto;
    flex: none;
    width: 232px;
  }

  .lamp {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 50%;
    background: var(--joshify-accent);
    transition: background var(--jf-theme-fade) ease;
  }

  /* A restricted device is dimmed rather than hidden. It is genuinely on the
     account, and dropping it from the list would leave the viewer hunting for
     a speaker Spotify can see and Joshify apparently cannot. */
  .row.restricted {
    color: var(--jf-ink-dim);
  }

  .row.restricted .glyph {
    color: var(--jf-ink-faint);
  }
</style>
