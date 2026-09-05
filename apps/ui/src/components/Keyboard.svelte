<script lang="ts">
  /**
   * The on-screen keyboard (P6-02).
   *
   * There is no physical keyboard, so the key arithmetic is the design. Ten
   * keys have to fit across a 720px panel and every one of them has to be a
   * touch target: with 14px of padding either side and 8px between keys, a
   * single key is `(720 - 28 - 72) / 10 = 62px` wide — over the 48px minimum in
   * SCREENS.md — and a key of span `s` is `s * 70 - 8` px, so a row whose spans
   * sum to 10 fills the panel exactly. That is the whole layout system, and it
   * is why the board is ten columns and not eleven.
   *
   * Keys are 64px tall, past the 56px floor for anything important, because a
   * mistyped letter on a debounced search costs a request and a re-read of the
   * results.
   *
   * The component holds no state at all: the board it draws and the effect of a
   * press are both `lib/keyboard.ts`, where they are asserted in Node rather
   * than through a mounted DOM.
   */
  import { layoutFor, type KeyboardState, type KeyCap } from '../lib/keyboard.js';

  interface Props {
    state: KeyboardState;
    onKey: (key: KeyCap) => void;
  }

  const { state, onKey }: Props = $props();

  const rows = $derived(layoutFor(state));
</script>

<div class="keyboard" role="group" aria-label="Keyboard">
  {#each rows as row, rowIndex (rowIndex)}
    <div class="row">
      {#each row as key (key.name)}
        <button
          class="key"
          type="button"
          data-kind={key.kind}
          data-shift={key.kind === 'shift' ? state.shift : undefined}
          aria-label={key.name}
          aria-pressed={key.kind === 'shift' ? state.shift !== 'off' : undefined}
          style="--jf-key-span: {key.span}"
          onclick={() => {
            onKey(key);
          }}
        >
          {key.label}
        </button>
      {/each}
    </div>
  {/each}
</div>

<style>
  .keyboard {
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    padding: 14px;
  }

  .row {
    display: flex;
    gap: 8px;
    /* The nine-key row is one key narrower than the panel; centring it is what
       makes the board read as a keyboard rather than a left-aligned grid. */
    justify-content: center;
  }

  .key {
    /* 62px per span, plus the 8px gap each extra span swallows. */
    width: calc(var(--jf-key-span) * 70px - 8px);
    height: 64px;
    flex: none;
    border: 1px solid var(--jf-plate-edge);
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--jf-ink);
    font-family: var(--jf-face-display);
    font-size: var(--jf-size-body);
    font-weight: 600;
    /* No hover: this is a finger. `:active` is the only feedback there is. */
    transition:
      background var(--jf-press) ease,
      color var(--jf-press) ease;
  }

  .key:active {
    background: var(--joshify-accent);
    color: var(--joshify-on-accent);
  }

  /* The word keys are labels, not letters, so they take the label face. */
  .key[data-kind='space'],
  .key[data-kind='clear'],
  .key[data-kind='layer'] {
    font-family: var(--jf-face-label);
    font-size: var(--jf-size-label);
    letter-spacing: var(--jf-track-label);
    text-transform: uppercase;
    color: var(--jf-ink-dim);
  }

  .key[data-kind='shift'],
  .key[data-kind='backspace'] {
    font-size: var(--jf-size-heading);
    color: var(--jf-ink-dim);
  }

  /* One-shot shift is lit; a lock is filled, so the two are told apart at a
     glance rather than by remembering how many times you tapped. */
  .key[data-shift='once'] {
    color: var(--joshify-accent);
    border-color: var(--joshify-accent);
  }

  .key[data-shift='lock'] {
    background: var(--joshify-accent);
    color: var(--joshify-on-accent);
  }
</style>
