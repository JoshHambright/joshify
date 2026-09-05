<script lang="ts">
  /**
   * The progress bar, on the plate's top edge (SCREENS.md).
   *
   * Two jobs that pull in opposite directions, which is why they are one
   * component:
   *
   * **Smooth at refresh rate with zero extra API calls (P3-11).** Every frame
   * it draws is a local extrapolation from the last polled position and the
   * monotonic clock (D-023); nothing here ever asks the network where playback
   * is. The loop runs only while something is actually moving — a paused bar
   * and a dragged one both get no frames at all, because in one case nothing
   * changes and in the other the clock is not what is driving it.
   *
   * **The finger wins (P4-07).** While the pointer is down, interpolation is
   * suppressed and the thumb tracks the pointer; on release the seek goes out
   * and the model holds the chosen position through the round trip rather than
   * letting the bar snap back to where the track was before the drag.
   *
   * The listeners for the drag itself go on `window`, not on the bar. A finger
   * that slides off a 6px-tall track — which is most drags — must keep
   * dragging it, and pointer capture is not something to rely on.
   */
  import { IDLE_PLAYBACK, type PlaybackState } from '@joshify/core';
  import { formatRemaining, formatTime, progressFraction } from '../lib/format.js';
  import { createProgressModel, fractionAtX, type FrameLoop } from '../lib/progress.js';
  import type { CommandClient, CommandTarget } from '../lib/commands.js';

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
     * Where the seek is aimed. Absent means "whatever is active". Not called
     * `target`: that is one of Svelte's own mount options, and a component
     * prop by that name is silently ambiguous at every call site.
     */
    commandTarget?: CommandTarget | undefined;
    /** Monotonic reading, injected so tests need no real clock (D-023). */
    monotonic?: (() => number) | undefined;
    /** Injected so a test drives the redraw by hand instead of waiting a frame. */
    frames?: FrameLoop | undefined;
  }

  const {
    playback,
    client,
    disabled = false,
    commandTarget,
    monotonic = () => performance.now(),
    frames,
  }: Props = $props();

  const everyFrame: FrameLoop = (tick) => {
    let handle = 0;
    const step = (): void => {
      tick();
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(handle);
    };
  };

  const current = $derived(playback ?? IDLE_PLAYBACK);
  const item = $derived(current.item);
  const durationMs = $derived(item?.durationMs ?? 0);

  // Seeded idle rather than from the prop: the effect below observes the real
  // thing before the first paint, and reading a prop at init would capture its
  // initial value forever.
  const model = createProgressModel(IDLE_PLAYBACK, 0);

  let positionMs = $state(0);
  let scrubbing = $state(false);
  let bar: HTMLDivElement | undefined = $state();

  /**
   * Measured once per drag rather than per move: the plate cannot move while a
   * finger is on it, and re-measuring forces a layout on every frame of the
   * gesture — on the one device we know is slow.
   */
  let rect: { left: number; width: number } = { left: 0, width: 0 };

  const draw = (): void => {
    positionMs = model.readAt(monotonic()).positionMs;
  };

  $effect(() => {
    model.observe(current, monotonic());
    // `observe` drops a drag whose track changed underneath it, so the flag is
    // read back rather than assumed.
    scrubbing = model.isScrubbing;
    draw();
  });

  $effect(() => {
    if (!current.isPlaying || scrubbing) return;
    return (frames ?? everyFrame)(draw);
  });

  const move = (event: PointerEvent): void => {
    model.moveScrub(fractionAtX(event.clientX, rect));
    draw();
  };

  const finish = (event: PointerEvent): void => {
    // The release position counts: a tap is a drag with no move events, and
    // this is what makes tapping the bar seek there.
    model.moveScrub(fractionAtX(event.clientX, rect));
    const seekTo = model.endScrub(monotonic());
    scrubbing = false;
    detach();
    draw();
    if (seekTo === null) return;
    // Not awaited (D-028): the model is already holding the new position, and
    // the server's optimistic state echoes it back within a poll.
    void client.send({ kind: 'seek', positionMs: seekTo }, commandTarget);
  };

  const abandon = (): void => {
    model.cancelScrub();
    scrubbing = false;
    detach();
    draw();
  };

  function detach(): void {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', abandon);
  }

  const start = (event: PointerEvent): void => {
    // Nothing playing has no position to choose, and no Premium means the seek
    // would be refused. Either way the bar is inert rather than misleading.
    if (disabled || durationMs <= 0) return;
    rect = bar?.getBoundingClientRect() ?? { left: 0, width: 0 };
    model.beginScrub(fractionAtX(event.clientX, rect));
    scrubbing = model.isScrubbing;
    draw();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', abandon);
  };

  $effect(() => () => {
    // A drag interrupted by a screen change would otherwise leave three window
    // listeners holding a dead component.
    detach();
  });

  const fraction = $derived(progressFraction(positionMs, durationMs));
  const elapsed = $derived(formatTime(item === null ? null : positionMs));
  const remaining = $derived(
    formatRemaining(item === null ? null : positionMs, item === null ? null : durationMs),
  );
</script>

<div class="scrubber" data-scrubbing={scrubbing ? 'true' : null}>
  <div
    class="bar"
    bind:this={bar}
    role="slider"
    tabindex="-1"
    aria-label="Seek"
    aria-valuemin={0}
    aria-valuemax={durationMs}
    aria-valuenow={positionMs}
    aria-valuetext={elapsed}
    aria-disabled={disabled || durationMs <= 0}
    onpointerdown={start}
  >
    <div class="rail">
      <div class="fill" style:width="{fraction * 100}%"></div>
    </div>
    <div class="thumb" style:left="{fraction * 100}%"></div>
  </div>
  <div class="jf-data times">
    <span class="elapsed">{elapsed}</span>
    <span class="remaining">{remaining}</span>
  </div>
</div>

<style>
  .scrubber {
    width: 100%;
  }

  /* The visible track is 6px; the target it sits inside is 48px, which is the
     floor for anything touchable (SCREENS.md). Padding is the target. */
  .bar {
    position: relative;
    display: flex;
    align-items: center;
    height: var(--jf-touch-min);
    touch-action: none;
    cursor: default;
  }

  .rail {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.16);
  }

  .fill {
    height: 100%;
    background: var(--joshify-accent);
    transition: background var(--jf-theme-fade) ease;
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    background: var(--joshify-accent);
    transform: translateY(-50%);
    transition:
      background var(--jf-theme-fade) ease,
      width var(--jf-press) ease-out,
      height var(--jf-press) ease-out;
  }

  /* The one moment this panel grows a control: under a finger the thumb has to
     be visible past the finger covering it. */
  .scrubber[data-scrubbing] .thumb {
    width: 26px;
    height: 26px;
    margin-left: -13px;
  }

  .times {
    display: flex;
    justify-content: space-between;
    color: var(--jf-ink-faint);
  }

  .elapsed {
    color: var(--jf-ink-dim);
  }
</style>
