import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDismissible,
  type PointerLikeEvent,
  type PointerTarget,
} from './dismissible.js';

/** A node whose events the test fires by hand. No DOM required. */
const fakeNode = () => {
  const listeners = new Map<string, ((event: PointerLikeEvent) => void)[]>();
  const captured: number[] = [];
  const released: number[] = [];
  const node: PointerTarget = {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    setPointerCapture: (id) => captured.push(id),
    releasePointerCapture: (id) => released.push(id),
  };
  return {
    node,
    captured,
    released,
    fire: (type: string, event: Partial<PointerLikeEvent> = {}) => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ pointerId: 1, clientY: 0, isPrimary: true, ...event });
      }
    },
    listenerCount: () => [...listeners.values()].flat().length,
  };
};

let clock = 0;
const now = () => clock;

let dismissals: number;
let offsets: number[];

const attach = (enabled = true) => {
  const fake = fakeNode();
  const handle = createDismissible(
    fake.node,
    {
      onDismiss: () => {
        dismissals += 1;
      },
      onOffset: (offset) => offsets.push(offset),
      enabled,
    },
    now,
  );
  return { ...fake, handle };
};

beforeEach(() => {
  clock = 0;
  dismissals = 0;
  offsets = [];
});

describe('dragging', () => {
  it('follows the finger and dismisses past the threshold', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100 });
    clock = 300;
    fake.fire('pointermove', { clientY: 220 });
    fake.fire('pointerup');

    expect(offsets).toContain(120);
    expect(dismissals).toBe(1);
  });

  it('springs back when the drag was not enough', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100 });
    clock = 2_000;
    fake.fire('pointermove', { clientY: 130 });
    fake.fire('pointerup');

    expect(dismissals).toBe(0);
    expect(offsets.at(-1)).toBe(0);
  });

  // A tap on a row inside the surface must not dismiss the surface.
  it('does not dismiss on a tap', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100 });
    fake.fire('pointerup');

    expect(dismissals).toBe(0);
  });

  it('captures the pointer so a drag leaving the element still reports', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100 });
    expect(fake.captured).toEqual([1]);

    fake.fire('pointerup');
    expect(fake.released).toEqual([1]);
  });

  // The browser taking the gesture away — a scroll starting, a call arriving.
  // Treating that as a release would dismiss for something nobody did.
  it('treats a cancelled pointer as an abandoned drag', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100 });
    clock = 300;
    fake.fire('pointermove', { clientY: 400 });
    fake.fire('pointercancel');

    expect(dismissals).toBe(0);
    expect(offsets.at(-1)).toBe(0);
  });

  it('ignores a move that never began with a press', () => {
    const fake = attach();

    fake.fire('pointermove', { clientY: 400 });
    fake.fire('pointerup');

    expect(dismissals).toBe(0);
    expect(offsets).toEqual([]);
  });

  it('ignores a secondary pointer, so a second finger cannot start a drag', () => {
    const fake = attach();

    fake.fire('pointerdown', { clientY: 100, isPrimary: false });
    clock = 100;
    fake.fire('pointermove', { clientY: 400 });
    fake.fire('pointerup');

    expect(dismissals).toBe(0);
  });
});

describe('being switched off', () => {
  it('starts no gesture while disabled', () => {
    const fake = attach(false);

    fake.fire('pointerdown', { clientY: 100 });
    clock = 200;
    fake.fire('pointermove', { clientY: 400 });
    fake.fire('pointerup');

    expect(dismissals).toBe(0);
  });

  // Losing permission mid-drag ends the drag rather than leaving one running
  // that nothing is listening to.
  it('abandons a gesture already in flight', () => {
    const fake = attach();
    fake.fire('pointerdown', { clientY: 100 });
    clock = 200;
    fake.fire('pointermove', { clientY: 400 });

    fake.handle.update({ onDismiss: () => (dismissals += 1), enabled: false });

    expect(dismissals).toBe(0);
    fake.fire('pointerup');
    expect(dismissals).toBe(0);
  });
});

describe('tearing down', () => {
  it('removes every listener it added', () => {
    const fake = attach();
    expect(fake.listenerCount()).toBeGreaterThan(0);

    fake.handle.destroy();

    expect(fake.listenerCount()).toBe(0);
  });
});
