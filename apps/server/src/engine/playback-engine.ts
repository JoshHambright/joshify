/**
 * The engine: the loop that keeps the device's idea of playback true.
 *
 * Every piece it needs already existed — the poll schedule, the normaliser, the
 * optimistic layer, the broadcaster — but nothing composed them. This is that
 * composition, and it is the thing P2-10's suite exercises end to end.
 *
 * It owns no timers of its own. Both the clock and the scheduler are injected,
 * so the whole loop can be driven deterministically in tests without waiting a
 * single real millisecond.
 */
import {
  createOptimisticPlayback,
  DEFAULT_THEME,
  IDLE_PLAYBACK,
  nextPollDelayMs,
  playingItemKey,
  type Clock,
  type JoshifyError,
  type OptimisticChange,
  type PanelState,
  type PlayingItem,
  type Result,
  type ThemeTokens,
} from '@joshify/core';
import { normalisePlaybackState } from '@joshify/core';
import type { Broadcaster } from '../http/broadcast.js';
import type { SpotifyClient } from '../spotify/client.js';
import type { CommandTarget, SpotifyCommands } from '../spotify/commands.js';

/** Cancels a pending scheduled call. */
export type CancelScheduled = () => void;

/** Injected so tests advance time by hand rather than waiting for it. */
export type Scheduler = (delayMs: number, run: () => void) => CancelScheduled;

export const realScheduler: Scheduler = (delayMs, run) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Where the album's colour comes from.
 *
 * Injected rather than constructed here because extraction needs a disk cache
 * and an image decoder, and the engine should stay testable without either.
 * It is deliberately allowed to be slow: nothing in the poll path awaits it.
 */
export interface Presenter {
  readonly themeFor: (item: PlayingItem) => Promise<ThemeTokens>;
}

export interface PlaybackEngineConfig {
  readonly client: Pick<SpotifyClient, 'getPlaybackState'>;
  readonly commands: SpotifyCommands;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly scheduler?: Scheduler | undefined;
  /** Reported so the UI can show that something is wrong without guessing. */
  readonly onProblem?: ((error: JoshifyError) => void) | undefined;
  /** Absent means the panel stays on the neutral default theme. */
  readonly presenter?: Presenter | undefined;
  /**
   * Read once at start. `null` — the default — means "we have not asked",
   * which the UI must not render as "this account is free" (D-022).
   */
  readonly readProfile?:
    (() => Promise<Result<{ isPremium: boolean }, JoshifyError>>) | undefined;
}

export interface PlaybackEngine {
  readonly start: () => void;
  readonly stop: () => void;
  /** What the UI should be drawing: polled truth with pending changes over it. */
  readonly state: () => PanelState;
  /** Apply optimistically, send, and reconcile or roll back. */
  readonly command: (change: EngineCommand) => Promise<Result<void, JoshifyError>>;
  /** Force a poll now. Exposed for tests and for the reconnect path. */
  readonly poll: () => Promise<void>;
}

/**
 * A command as the UI issues it: the optimistic change and the device it is
 * aimed at, together. Keeping them in one shape means a caller cannot apply an
 * optimistic update and then send a command somewhere else.
 */
export interface EngineCommand {
  readonly change: OptimisticChange;
  readonly target?: CommandTarget | undefined;
}

export const createPlaybackEngine = (config: PlaybackEngineConfig): PlaybackEngine => {
  const schedule = config.scheduler ?? realScheduler;
  const optimistic = createOptimisticPlayback(IDLE_PLAYBACK, {});

  let running = false;
  let cancelNext: CancelScheduled | null = null;

  // Presentation, held alongside playback rather than inside it. The theme
  // legitimately lags the track it belongs to — extraction needs the image,
  // and the image needs a fetch and a decode — so `themeFor` records which
  // item the colour on screen actually belongs to (D-050).
  let theme: ThemeTokens = DEFAULT_THEME;
  let themeFor: string | null = null;
  let isPremium: boolean | null = null;
  /** Which extraction is current. A track change invalidates the one in flight. */
  let themeGeneration = 0;

  const panelState = (): PanelState => ({
    ...optimistic.state,
    theme,
    themeFor,
    isPremium,
  });

  const publish = (): void => {
    config.broadcaster.publish(panelState());
  };

  /**
   * Kick off extraction for a newly playing item, and publish again when it
   * lands.
   *
   * Deliberately not awaited by `poll`. Making the poll wait would delay the
   * title and the progress bar behind a disk read and a decode, to deliver a
   * colour — exactly backwards. The panel gets the track immediately and the
   * colour a moment later, holding the *previous* album's colour in between
   * rather than flashing to neutral grey.
   */
  const refreshTheme = (item: PlayingItem | null): void => {
    const presenter = config.presenter;
    if (presenter === undefined) return;
    const key = item === null ? null : playingItemKey(item);
    if (key === themeFor) return;

    themeGeneration += 1;
    const generation = themeGeneration;

    if (item === null) {
      // Nothing playing keeps the last album's colour rather than snapping to
      // grey: the artwork is still on screen, dimmed (SCREENS.md).
      return;
    }

    void presenter.themeFor(item).then(
      (next) => {
        // Fenced after the await: a track that changed while the image was
        // decoding must not be repainted in the previous album's colour
        // (D-032's rule, in a different place).
        if (generation !== themeGeneration) return;
        theme = next;
        themeFor = key;
        publish();
      },
      (error: unknown) => {
        // A theme we could not derive is not worth a fault on screen. The
        // panel keeps whatever colour it has.
        config.onProblem?.({
          kind: 'unexpected',
          message: `theme extraction failed: ${String(error)}`,
          retryable: true,
        });
      },
    );
  };

  const armNextPoll = (): void => {
    if (!running) return;
    cancelNext?.();
    const since = optimistic.lastCommandAtMs;
    const monotonic = config.clock.monotonic();
    const delay = nextPollDelayMs(
      optimistic.state,
      since === null ? {} : { msSinceCommand: monotonic - since },
    );
    cancelNext = schedule(delay, () => {
      void poll();
    });
  };

  const poll = async (): Promise<void> => {
    const raw = await config.client.getPlaybackState();
    if (!raw.ok) {
      // A failed poll is not a reason to blank the screen. Keep showing the
      // last truth and try again on the normal cadence (PRODUCT.md §5.3).
      config.onProblem?.(raw.error);
      armNextPoll();
      return;
    }
    const normalised = normalisePlaybackState(raw.value);
    if (!normalised.ok) {
      config.onProblem?.(normalised.error);
      armNextPoll();
      return;
    }
    optimistic.reconcile(normalised.value, config.clock.monotonic());
    refreshTheme(optimistic.state.item);
    publish();
    armNextPoll();
  };

  const send = async (command: EngineCommand): Promise<Result<void, JoshifyError>> => {
    const { change, target } = command;
    const t = target;
    switch (change.kind) {
      case 'play':
        return config.commands.play(t === undefined ? {} : { ...t });
      case 'pause':
        return config.commands.pause(t);
      case 'next':
        return config.commands.next(t);
      case 'previous':
        return config.commands.previous(t);
      case 'seek':
        return config.commands.seek(change.positionMs, t);
      case 'volume':
        return config.commands.setVolume(change.volumePercent, t);
      case 'shuffle':
        return config.commands.setShuffle(change.enabled, t);
      case 'repeat':
        return config.commands.setRepeat(change.mode, t);
    }
  };

  const command = async (input: EngineCommand): Promise<Result<void, JoshifyError>> => {
    const receipt = optimistic.apply(input.change, config.clock.monotonic());
    // Publish before awaiting the network: this is the whole point of the
    // optimistic layer, and the reason a tap feels instant (D-028).
    publish();
    // Re-arm immediately so the after-command burst starts now rather than
    // whenever the previous long idle delay happens to expire (D-025).
    armNextPoll();

    const result = await send(input);
    if (!result.ok) {
      optimistic.fail(receipt);
      publish();
      config.onProblem?.(result.error);
    }
    return result;
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      const readProfile = config.readProfile;
      if (readProfile !== undefined) {
        void readProfile().then(
          (result) => {
            // Only a definite answer moves it off null. A failed read leaves
            // the account unclassified, which is the honest state.
            if (!result.ok) {
              config.onProblem?.(result.error);
              return;
            }
            isPremium = result.value.isPremium;
            publish();
          },
          () => undefined,
        );
      }
      void poll();
    },
    stop: () => {
      running = false;
      cancelNext?.();
      cancelNext = null;
    },
    state: panelState,
    command,
    poll,
  };
};
