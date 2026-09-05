/**
 * @vitest-environment jsdom
 */
/**
 * The window arithmetic is `lib/virtual.ts` and is asserted in Node. What these
 * add is the part only a mounted list can get wrong: that the rows outside the
 * window genuinely do not exist, that the sizer still claims the whole list so
 * the scrollbar and the flick physics are honest, and that a scroll moves the
 * window rather than only the pixels.
 *
 * jsdom does no layout, so `scrollTop` is defined on the element by hand before
 * the scroll event is dispatched. That is not a workaround for the test — it is
 * the reason the component takes its height as a prop: a list whose window can
 * only be derived from a real layout is a list nothing can check (D-039 makes
 * the height a known number anyway).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import VirtualList from './VirtualList.svelte';
import { createRawSnippet } from 'svelte';
import type { VirtualWindow } from '../lib/virtual.js';

/** A snippet that just prints the row, so the DOM says which rows are real. */
const rowSnippet = createRawSnippet<[string, number]>((item, index) => ({
  render: () => `<span class="cell">${item()}:${String(index())}</span>`,
}));

const items = Array.from({ length: 1000 }, (_, index) => `row-${String(index)}`);

const mount = (over: { height?: number; overscan?: number } = {}) => {
  const windows: VirtualWindow[] = [];
  const view = render(VirtualList<string>, {
    items,
    height: over.height ?? 300,
    rowHeight: 100,
    overscan: over.overscan ?? 0,
    keyOf: (item: string) => item,
    row: rowSnippet,
    label: 'Rows',
    onWindowChange: (window: VirtualWindow) => {
      windows.push(window);
    },
  });
  return { ...view, windows };
};

const cells = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.cell')].map((node) => node.textContent ?? '');

/** Scroll the viewport the way a finger would, without a layout to do it. */
const scrollTo = async (container: HTMLElement, scrollTop: number): Promise<void> => {
  const viewport = container.querySelector('.viewport');
  if (viewport === null) throw new Error('no viewport');
  Object.defineProperty(viewport, 'scrollTop', { value: scrollTop, configurable: true });
  await fireEvent.scroll(viewport);
};

afterEach(cleanup);

describe('a virtualised list', () => {
  // The whole point: a thousand rows must not be a thousand DOM subtrees on a
  // device with a fixed memory budget.
  it('draws only the rows in view out of a thousand', () => {
    const { container } = mount();

    expect(cells(container)).toEqual(['row-0:0', 'row-1:1', 'row-2:2']);
  });

  it('still claims the whole list, so the scrollbar does not lie', () => {
    const { container } = mount();
    const sizer = container.querySelector('.sizer');

    expect(sizer?.getAttribute('style')).toContain('height: 100000px');
  });

  it('moves the window when the list is scrolled', async () => {
    const { container } = mount();
    await scrollTo(container, 5000);

    expect(cells(container)).toEqual(['row-50:50', 'row-51:51', 'row-52:52']);
  });

  // The offset is a transform, not a spacer element: it moves the window on the
  // compositor instead of relaying out the list on every frame of a flick.
  it('offsets the window rather than padding it with elements', async () => {
    const { container } = mount();
    await scrollTo(container, 5000);

    expect(container.querySelector('.window')?.getAttribute('style')).toContain(
      'translateY(5000px)',
    );
  });

  it('renders the overscan either side of what is visible', async () => {
    const { container } = mount({ overscan: 2 });
    await scrollTo(container, 5000);

    expect(cells(container)).toHaveLength(7);
    expect(cells(container)[0]).toBe('row-48:48');
  });

  it('tells the caller where the window is, so a pager can hang off it', async () => {
    const { container, windows } = mount();
    await scrollTo(container, 5000);

    expect(windows.at(-1)).toMatchObject({ startIndex: 50, endIndex: 53 });
  });

  it('draws nothing at all for an empty list', () => {
    const { container } = render(VirtualList<string>, {
      items: [],
      height: 300,
      rowHeight: 100,
      keyOf: (item: string) => item,
      row: rowSnippet,
    });

    expect(cells(container)).toEqual([]);
    expect(container.querySelector('.sizer')?.getAttribute('style')).toContain(
      'height: 0px',
    );
  });
});
