/**
 * What the panel draws: playback truth, plus the presentation derived from it.
 *
 * ## Why this is a separate type from `PlaybackState`
 *
 * `PlaybackState` is our model of Spotify's player, and it should keep meaning
 * exactly that — a field in it is something Spotify reported. The album's
 * colour is not: we compute it here, from an image, some time after the track
 * change that prompted it. Putting it in `PlaybackState` would make the
 * normaliser's output depend on a disk cache and an image decoder.
 *
 * ## Why it is flat rather than nested
 *
 * `{ playback, presentation }` would be tidier to read and worse on the wire.
 * The diff protocol replaces whole keys, so a nested shape would resend the
 * entire playback object on every one-second progress tick to change one
 * number. Flat keeps each field its own key, and the diff stays a few bytes.
 *
 * It also means `PanelState` *is* a `PlaybackState` structurally, so every
 * component that only wants playback keeps taking `PlaybackState` and needs no
 * knowledge that presentation exists.
 *
 * ## Why `themeFor` exists
 *
 * The theme legitimately arrives after the track it belongs to: extraction
 * needs the image, and the image needs a fetch and a decode. Carrying the item
 * key the theme was derived from lets the UI keep showing the *previous*
 * album's colour for those few hundred milliseconds instead of flashing back
 * to neutral grey — the same reasoning as holding the outgoing artwork until
 * the incoming one has decoded (D-045).
 */
import { IDLE_PLAYBACK, type PlaybackState } from '../playback/state.js';
import { DEFAULT_THEME, type ThemeTokens } from '../theme/tokens.js';

export interface PanelState extends PlaybackState {
  /** Derived server-side from the album art (P3-03). Neutral until one lands. */
  readonly theme: ThemeTokens;
  /**
   * The `playingItemKey` the theme was derived from, or null while the theme
   * is still the neutral default. Compare it against the current item to know
   * whether the colour on screen belongs to the track on screen.
   */
  readonly themeFor: string | null;
  /**
   * Null until the account has been read.
   *
   * Deliberately three-valued. `false` means Spotify will refuse every write
   * and the panel should say so; `null` means we have not asked yet, and
   * accusing an account of being free before we know is the confident lie
   * D-022 exists to prevent.
   */
  readonly isPremium: boolean | null;
}

export const IDLE_PANEL: PanelState = {
  ...IDLE_PLAYBACK,
  theme: DEFAULT_THEME,
  themeFor: null,
  isPremium: null,
};

/**
 * Whether the theme on screen belongs to the track on screen.
 *
 * False during the window between a track change and its extraction landing —
 * which is not an error state, just a fact the UI may want to know.
 */
export const themeMatchesItem = (state: PanelState, itemKey: string | null): boolean =>
  state.themeFor !== null && state.themeFor === itemKey;
