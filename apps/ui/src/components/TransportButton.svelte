<script lang="ts">
  /**
   * One transport key, in one of the three weights the row is built from
   * (D-040): a 96px accent disc for play, a bare glyph with no box for skip,
   * and a quiet toggle that only takes the accent once it is on.
   *
   * The variants exist because **the transport is deliberately unequal**. Five
   * identical keys in a row give the eye nothing to land on, which was most of
   * why the first attempt read as a stock media player. Encoding the weight as
   * a variant rather than as per-call styling is what keeps that true the next
   * time a control is added.
   *
   * `:active` is the entire feedback story, and it is not decoration: the
   * command is a network round trip and the speaker will not react for a
   * moment, so the *button* has to. There is no hover state and no tooltip —
   * this is a panel being touched, not a page being pointed at (SCREENS.md).
   */
  import type { Snippet } from 'svelte';

  type TransportVariant = 'play' | 'skip' | 'toggle';

  interface Props {
    /** The control's only name: there are no tooltips and no visible labels. */
    label: string;
    variant: TransportVariant;
    onpress: () => void;
    /** Not Premium means every write fails, so every control is off (D-026). */
    disabled?: boolean | undefined;
    /** Toggles only: on is the accent, off is `--jf-ink-faint`. */
    active?: boolean | undefined;
    children: Snippet;
  }

  const { label, variant, onpress, disabled = false, active, children }: Props =
    $props();
</script>

<button
  class="key"
  class:active={active === true}
  type="button"
  data-variant={variant}
  aria-label={label}
  aria-pressed={variant === 'toggle' ? active === true : undefined}
  {disabled}
  onclick={onpress}
>
  {@render children()}
</button>

<style>
  .key {
    display: grid;
    place-items: center;
    padding: 0;
    border: none;
    background: none;
    color: var(--jf-ink);
    /* Nothing important below 56px (SCREENS.md); the glyph inside is smaller
       than the target, which is the point of having a target at all. */
    min-width: var(--jf-touch);
    min-height: var(--jf-touch);
    /* Removes the tap delay a double-tap-to-zoom gesture would otherwise cost
       every press on a touchscreen. */
    touch-action: manipulation;
    transition:
      transform var(--jf-press) ease-out,
      color var(--jf-theme-fade) ease,
      background var(--jf-theme-fade) ease;
  }

  .key:active:not(:disabled) {
    transform: scale(0.92);
  }

  .key:disabled {
    /* Dimmed, not hidden: the controls are still the shape of the thing, and
       the plate explains why they will not move (SCREENS.md). */
    opacity: 0.3;
  }

  /* The one control the eye lands on. */
  .key[data-variant='play'] {
    width: var(--jf-touch-play);
    height: var(--jf-touch-play);
    border-radius: 50%;
    background: var(--joshify-accent);
    color: var(--joshify-on-accent);
  }

  .key[data-variant='play']:active:not(:disabled) {
    transform: scale(0.95);
  }

  /* A bare glyph. No box, no fill — the absence of a container is what makes
     the disc beside it read as the primary action. */
  .key[data-variant='skip'] {
    width: var(--jf-touch);
    height: var(--jf-touch);
  }

  .key[data-variant='toggle'] {
    width: var(--jf-touch);
    height: var(--jf-touch);
    color: var(--jf-ink-faint);
  }

  .key[data-variant='toggle'].active {
    color: var(--joshify-accent);
  }
</style>
