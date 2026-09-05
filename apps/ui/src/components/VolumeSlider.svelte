<script lang="ts">
  /**
   * One device's volume, as a thing you drag with a thumb.
   *
   * Two things make this more than an `<input type="range">` with a class on
   * it:
   *
   * 1. **It must not fight the poll.** The panel is told the device's volume
   *    roughly once a second. Applied blindly, that would drag the thumb out
   *    from under a finger mid-gesture, and would snap it back to the old
   *    value for one poll after release — the write has not reached the
   *    speaker yet, so the poll is *correctly* reporting stale truth. The
   *    reconcile rule lives in `lib/devices.ts` (`VolumeGesture`) and follows
   *    D-028's two axes, so it is asserted in Node rather than through a DOM.
   * 2. **It only sends on release.** A drag across the track would otherwise
   *    fire fifty volume commands at Spotify, which is both rude and slow. A
   *    keyboard step has no release to wait for, so it commits on the spot.
   *
   * A native range is used deliberately: the browser already implements touch
   * dragging, keyboard stepping and the accessibility semantics correctly, and
   * a hand-rolled div would be a worse version of all three on the one device
   * that matters.
   */
  import { onDestroy } from 'svelte';
  import {
    beginDrag,
    dragTo,
    endDrag,
    holdVolume,
    IDLE_VOLUME_GESTURE,
    settleVolume,
    shownVolume,
    type VolumeGesture,
  } from '../lib/devices.js';

  interface Props {
    /** The polled value, 0–100. Only ever rendered for a device that reports
     *  one — the decision not to draw a slider at all belongs to the row. */
    volumePercent: number;
    /** Names the control for anything that cannot see it, e.g. "Kitchen". */
    label: string;
    disabled?: boolean | undefined;
    /** Fired once, with the released value. */
    onVolume: (volumePercent: number) => void;
  }

  const { volumePercent, label, disabled = false, onVolume }: Props = $props();

  // Held as state and reconciled in an effect rather than as a writable
  // $derived, which is what the lint rule below would prefer: a derived
  // recomputes whenever its dependencies change, so it would drop the held
  // value on the very poll this exists to ignore. The reconcile also reads
  // the gesture it is updating, so it is not a function of the prop alone.
  // eslint-disable-next-line svelte/prefer-writable-derived
  let gesture = $state<VolumeGesture>(IDLE_VOLUME_GESTURE);
  const shown = $derived(shownVolume(gesture, volumePercent));

  // Reconciling on every incoming value rather than on a timer: the poll is
  // the only thing that can tell us whether our write landed.
  $effect(() => {
    gesture = settleVolume(gesture, volumePercent);
  });

  const release = (): void => {
    if (!gesture.dragging) return;
    detach();
    const ended = endDrag(gesture);
    gesture = ended;
    // Null means the gesture ended exactly where it started. A stray tap on
    // the track must not fire a volume command at the speaker.
    if (ended.local !== null) onVolume(ended.local);
  };

  // The finger can leave the element before it lifts, and on a 7" panel it
  // usually does. Listening on the window is what makes a drag that ends off
  // the track still count as a release rather than sticking forever.
  const attach = (): void => {
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  function detach(): void {
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  }

  const grab = (): void => {
    if (disabled) return;
    gesture = beginDrag(gesture, volumePercent);
    attach();
  };

  const moveTo = (raw: string): void => {
    const held = dragTo(holdVolume(gesture, volumePercent), Number(raw));
    gesture = held;
    // No pointer is down, so this is a keyboard step: there is no release
    // coming and it is a complete gesture on its own.
    if (!held.dragging && held.local !== null) onVolume(held.local);
  };

  onDestroy(detach);
</script>

<div class="volume" style="--jf-volume-fill: {shown}%">
  <input
    class="slider"
    type="range"
    min="0"
    max="100"
    step="1"
    value={shown}
    {disabled}
    aria-label={label}
    onpointerdown={grab}
    oninput={(event) => {
      moveTo(event.currentTarget.value);
    }}
  />
  <span class="jf-data readout">{shown}</span>
</div>

<style>
  .volume {
    display: flex;
    align-items: center;
    gap: var(--jf-gap-tight);
    width: 100%;
  }

  /* A native range with every default stripped. The track and thumb below are
     drawn per engine, because there is no shared pseudo-element for either. */
  .slider {
    flex: 1;
    /* The full touch minimum, even though the track is 6px: the target is the
       control, not the paint (SCREENS.md). */
    height: var(--jf-touch-min);
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
  }

  .slider:disabled {
    opacity: 0.4;
  }

  /* Filled in the album's accent up to the value, and dim beyond it, so the
     level reads from across the room without a number. */
  .slider::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(
      to right,
      var(--joshify-accent) var(--jf-volume-fill),
      var(--jf-ink-faint) var(--jf-volume-fill)
    );
  }

  .slider::-moz-range-track {
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(
      to right,
      var(--joshify-accent) var(--jf-volume-fill),
      var(--jf-ink-faint) var(--jf-volume-fill)
    );
  }

  .slider::-webkit-slider-thumb {
    width: 26px;
    height: 26px;
    /* Centres the thumb on a 6px track. */
    margin-top: -10px;
    border: none;
    border-radius: 50%;
    background: var(--joshify-accent);
    appearance: none;
    -webkit-appearance: none;
  }

  .slider::-moz-range-thumb {
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 50%;
    background: var(--joshify-accent);
  }

  /* No hover state anywhere on this device; a press has to answer instantly
     because the network round trip does not (D-028). */
  .slider:active::-webkit-slider-thumb {
    transform: scale(1.12);
  }

  .slider:active::-moz-range-thumb {
    transform: scale(1.12);
  }

  .readout {
    min-width: 3ch;
    color: var(--jf-ink-dim);
    text-align: right;
  }
</style>
