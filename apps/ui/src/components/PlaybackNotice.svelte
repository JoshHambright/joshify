<script lang="ts">
  /**
   * What the plate says when it is not saying a track title (P3-12).
   *
   * Idle, no active device, not Premium, offline. SCREENS.md gives all four
   * one rule — **never a raw error, never a spinner where last-known truth
   * exists** — and the component's whole job is to look like a sentence
   * somebody wrote rather than a state a machine fell into.
   *
   * Which notice applies, and whether it should switch the transport off, is
   * decided in `lib/notices.ts`. This renders one; it never picks one.
   *
   * The only action here is **Choose a device**, and it appears only on the
   * notice that has somewhere for it to lead. It is styled as the primary
   * control on the plate because in that state it *is* the primary control:
   * "no active device" is an offer, not a failure.
   */
  import type { Notice } from '../lib/notices.js';

  interface Props {
    /** Null when the plate should be showing a track instead. */
    notice: Notice | null;
    onChooseDevice?: (() => void) | undefined;
  }

  const { notice, onChooseDevice }: Props = $props();
</script>

{#if notice !== null}
  <div class="notice" data-notice={notice.kind}>
    <p class="jf-label eyebrow">{notice.eyebrow}</p>
    <h1 class="title">{notice.title}</h1>
    <p class="body">{notice.body}</p>

    {#if notice.action === 'choose-device'}
      <button
        class="action"
        type="button"
        onclick={() => {
          onChooseDevice?.();
        }}
      >
        Choose a device
      </button>
    {/if}
  </div>
{/if}

<style>
  .notice {
    display: flex;
    flex-direction: column;
  }

  .eyebrow {
    margin: 0 0 var(--jf-gap-tight);
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .title {
    margin: 0;
    font-size: var(--jf-size-heading);
    font-weight: 800;
    line-height: 1.05;
    color: var(--jf-ink);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .body {
    margin: var(--jf-gap-tight) 0 0;
    font-size: var(--jf-size-body);
    line-height: 1.3;
    color: var(--jf-ink-dim);
  }

  .action {
    /* Past the 56px floor for anything important, and the full width of the
       plate: it is the only thing to do on this screen. */
    min-height: var(--jf-touch-play);
    margin-top: var(--jf-gap-wide);
    padding: 0 var(--jf-gap-wide);
    border: none;
    border-radius: 18px;
    background: var(--joshify-accent);
    color: var(--joshify-on-accent);
    font-family: var(--jf-face-display);
    font-size: var(--jf-size-body);
    font-weight: 800;
    transition:
      background var(--jf-theme-fade) ease,
      transform var(--jf-press) ease;
  }

  /* No hover state on a panel nobody points at; the press is the feedback. */
  .action:active {
    transform: scale(0.98);
  }
</style>
