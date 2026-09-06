/**
 * The swipe gesture, as a Svelte action.
 *
 * An action rather than a component wrapper: the grown surfaces already have a
 * container, and wrapping them in another one to catch pointer events would put
 * a div between the plate and its own layout.
 *
 * Pointer events, not touch events — one code path covers the Pi's touchscreen
 * and a mouse on a development machine, and `setPointerCapture` means a drag
 * that leaves the element still reports its release. Touch-only handlers would
 * make this untestable anywhere but the device.
 */
import { shouldDismiss, swipeOffset, type SwipeState } from './gesture.js';

export interface DismissibleOptions {
  readonly onDismiss: () => void;
  /** Called as the finger moves, so the surface can follow it. */
  readonly onOffset?: ((offset: number) => void) | undefined;
  /** Off while a list inside is being scrolled, so the two do not fight. */
  readonly enabled?: boolean | undefined;
}

/** The pointer surface this action touches. Narrow enough to fake in a test. */
export interface PointerTarget {
  addEventListener: (type: string, listener: (event: PointerLikeEvent) => void) => void;
  removeEventListener: (
    type: string,
    listener: (event: PointerLikeEvent) => void,
  ) => void;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
}

export interface PointerLikeEvent {
  readonly pointerId: number;
  readonly clientY: number;
  readonly isPrimary?: boolean;
  readonly target?: unknown;
}

/** Injected so a test drives the clock instead of waiting on one. */
export type NowMs = () => number;

export const createDismissible = (
  node: PointerTarget,
  options: DismissibleOptions,
  now: NowMs = () => performance.now(),
): { update: (next: DismissibleOptions) => void; destroy: () => void } => {
  let current = options;
  let state: SwipeState | null = null;
  let pointerId: number | null = null;

  const finish = (dismissed: boolean): void => {
    if (pointerId !== null) {
      node.releasePointerCapture?.(pointerId);
      pointerId = null;
    }
    state = null;
    // Always spring back, whether or not it dismissed: the surface is going
    // away in one case and staying in the other, and either way it should not
    // be left translated by however far the finger got.
    current.onOffset?.(0);
    if (dismissed) current.onDismiss();
  };

  const onDown = (event: PointerLikeEvent): void => {
    if (current.enabled === false) return;
    if (event.isPrimary === false) return;
    state = {
      start: { y: event.clientY, atMs: now() },
      latest: { y: event.clientY, atMs: now() },
    };
    pointerId = event.pointerId;
    node.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: PointerLikeEvent): void => {
    if (state === null) return;
    state = { start: state.start, latest: { y: event.clientY, atMs: now() } };
    current.onOffset?.(swipeOffset(state));
  };

  const onUp = (): void => {
    if (state === null) return;
    finish(shouldDismiss(state));
  };

  // A cancelled pointer is the browser taking the gesture away — a scroll
  // starting, a call arriving. Treating it as a release would dismiss the
  // screen for something the viewer did not do.
  const onCancel = (): void => {
    if (state === null) return;
    finish(false);
  };

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onCancel);

  return {
    update: (next) => {
      current = next;
      // Losing permission mid-drag ends the drag rather than leaving a gesture
      // running that nothing is listening to.
      if (next.enabled === false && state !== null) finish(false);
    },
    destroy: () => {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onCancel);
    },
  };
};

/**
 * The Svelte action form. `use:dismissible={{ onDismiss }}`
 *
 * No cast: an `HTMLElement` already satisfies `PointerTarget` structurally,
 * which is the point of keeping that interface narrow.
 */
export const dismissible = (
  node: HTMLElement,
  options: DismissibleOptions,
): { update: (next: DismissibleOptions) => void; destroy: () => void } =>
  createDismissible(node, options);
