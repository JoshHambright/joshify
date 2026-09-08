<script lang="ts">
  /**
   * Visuals — the plate, grown (P5-36).
   *
   * Three controls and no settings screen. A theme is a whole machine (D-017):
   * its look, its chrome and, where the idiom demands it, its palette. Picking
   * one is therefore a single tap on a row rather than four separate choices,
   * which is the entire reason the bundle format exists.
   *
   * **Shuffle is separate from the theme, and that is deliberate.** It changes
   * the *look* on every track and leaves the chrome and palette where they
   * are. Shuffling whole themes would repaint the panel and reshape its corners
   * every three minutes, which is not a screensaver, it is a fault.
   *
   * The full-screen action lives here rather than on the chip because the panel
   * gets there on its own after forty-five seconds anyway (D-067). What the
   * chip is actually useful for is this list.
   */
  import type { Theme } from '../gl/themes.js';

  interface Props {
    themes: readonly Theme[];
    currentId: string;
    shuffle: boolean;
    /** True when this browser gave us no WebGL2 — the rows still apply chrome
     *  and palette, so the list is useful, but it cannot promise the scene. */
    available?: boolean | undefined;
    onSelect: (id: string) => void;
    onShuffle: (on: boolean) => void;
    onFullScreen: () => void;
  }

  const {
    themes,
    currentId,
    shuffle,
    available = true,
    onSelect,
    onShuffle,
    onFullScreen,
  }: Props = $props();
</script>

<section class="visuals" aria-label="Visuals">
  <p class="jf-label heading">Visuals</p>

  {#if !available}
    <!-- Honest rather than hidden: the chrome and the palette are CSS and still
         apply, so the list is not useless — but the scene will not run. -->
    <p class="note">
      This screen has no WebGL2, so a theme changes the panel’s colour and shape but not
      its scene.
    </p>
  {/if}

  <ul class="list">
    {#each themes as theme (theme.id)}
      <li>
        <button
          class="row"
          type="button"
          data-theme={theme.id}
          aria-pressed={theme.id === currentId}
          onclick={() => {
            onSelect(theme.id);
          }}
        >
          <span class="lamp" data-on={theme.id === currentId} aria-hidden="true"></span>
          <span class="name">{theme.name}</span>
          <span class="jf-label look">{theme.preset.name}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="actions">
    <button
      class="chip jf-label"
      type="button"
      aria-pressed={shuffle}
      data-on={shuffle}
      onclick={() => {
        onShuffle(!shuffle);
      }}
    >
      Shuffle looks
    </button>
    <button class="chip jf-label" type="button" onclick={onFullScreen}>
      Take the panel
    </button>
  </div>
</section>

<style>
  .visuals {
    display: flex;
    flex-direction: column;
    gap: var(--jf-gap);
  }

  .heading {
    margin: 0;
    color: var(--joshify-accent);
    transition: color var(--jf-theme-fade) ease;
  }

  .note {
    margin: 0;
    font-size: var(--jf-size-body);
    color: var(--jf-ink-dim);
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: calc(var(--jf-touch) * 6);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .list::-webkit-scrollbar {
    display: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--jf-gap);
    width: 100%;
    /* The touch floor, not a design choice (SCREENS.md). */
    min-height: var(--jf-touch);
    padding: 0 var(--jf-gap-tight);
    border: 0;
    background: none;
    color: var(--jf-ink);
    font-family: var(--jf-face-display);
    font-size: var(--jf-size-body);
    text-align: left;
  }

  .lamp {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 50%;
    background: var(--jf-ink-faint);
    transition: background var(--jf-theme-fade) ease;
  }

  .lamp[data-on='true'] {
    background: var(--joshify-accent);
  }

  .name {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .look {
    color: var(--jf-ink-faint);
  }

  .actions {
    display: flex;
    gap: var(--jf-gap-tight);
  }

  .chip {
    min-height: var(--jf-touch-min);
    padding: 0 var(--jf-gap);
    border: 1px solid var(--joshify-control-tint);
    border-radius: 999px;
    background: none;
    color: var(--jf-ink-dim);
    transition:
      color var(--jf-theme-fade) ease,
      border-color var(--jf-theme-fade) ease;
  }

  .chip[data-on='true'] {
    border-color: var(--joshify-accent);
    color: var(--joshify-accent);
  }
</style>
