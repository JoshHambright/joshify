import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROW_HEIGHT,
  shouldLoadNextPage,
  virtualWindow,
  type VirtualWindow,
  type WindowRequest,
} from './virtual.js';

/** A list of `itemCount` 100px rows in a 300px box — three rows on screen. */
const request = (over: Partial<WindowRequest> = {}): WindowRequest => ({
  itemCount: 100,
  rowHeight: 100,
  viewportHeight: 300,
  scrollTop: 0,
  overscan: 0,
  ...over,
});

const rendered = (window: VirtualWindow): number => window.endIndex - window.startIndex;

describe('the window', () => {
  it('renders exactly the rows a whole viewport holds', () => {
    expect(virtualWindow(request())).toEqual({
      startIndex: 0,
      endIndex: 3,
      padTop: 0,
      padBottom: 9700,
      totalHeight: 10_000,
    });
  });

  // The off-by-one that ships: a row scrolled half out of view is still on
  // screen at the top, and a row half into view is on screen at the bottom. One
  // pixel of scroll therefore renders four rows, not three.
  it('keeps the partly visible row at each edge', () => {
    const window = virtualWindow(request({ scrollTop: 1 }));

    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(4);
  });

  it('starts a new row exactly on the boundary rather than a pixel late', () => {
    expect(virtualWindow(request({ scrollTop: 100 }))).toMatchObject({
      startIndex: 1,
      endIndex: 4,
    });
  });

  it('pads above and below with the rows it did not draw', () => {
    const window = virtualWindow(request({ scrollTop: 1000 }));

    expect(window).toMatchObject({ startIndex: 10, endIndex: 13, padTop: 1000 });
    expect(window.padBottom).toBe(8700);
  });

  // The invariant that keeps the scrollbar honest: the sizer is always the
  // whole list, however much of it is currently real.
  it.each([0, 1, 250, 4321, 9_999_999])('adds up at scrollTop %i', (scrollTop) => {
    const window = virtualWindow(request({ scrollTop, overscan: 3 }));

    expect(window.padTop + rendered(window) * 100 + window.padBottom).toBe(
      window.totalHeight,
    );
  });

  it('draws the overscan either side of what is visible', () => {
    const window = virtualWindow(request({ scrollTop: 1000, overscan: 2 }));

    expect(window).toMatchObject({ startIndex: 8, endIndex: 15 });
  });

  it('never overscans past the ends of the list', () => {
    expect(virtualWindow(request({ scrollTop: 0, overscan: 5 }))).toMatchObject({
      startIndex: 0,
      endIndex: 8,
    });
    expect(
      virtualWindow(request({ itemCount: 5, scrollTop: 200, overscan: 5 })),
    ).toMatchObject({ startIndex: 0, endIndex: 5 });
  });

  it('shows the last rows when scrolled to the bottom', () => {
    const window = virtualWindow(request({ itemCount: 10, scrollTop: 700 }));

    expect(window).toMatchObject({ startIndex: 7, endIndex: 10, padBottom: 0 });
  });

  // Touch scrolling overshoots both ends. Neither overshoot is a reason to
  // compute a window outside the list.
  it.each([
    [-400, 'rubber-banded past the top'],
    [999_999, 'flicked past the bottom'],
  ])('clamps a scrollTop %i (%s)', (scrollTop) => {
    const window = virtualWindow(request({ itemCount: 10, scrollTop }));

    expect(window.startIndex).toBeGreaterThanOrEqual(0);
    expect(window.endIndex).toBeLessThanOrEqual(10);
    expect(window.padTop).toBeGreaterThanOrEqual(0);
    expect(window.padBottom).toBeGreaterThanOrEqual(0);
  });

  it('draws nothing for an empty list', () => {
    expect(virtualWindow(request({ itemCount: 0 }))).toEqual({
      startIndex: 0,
      endIndex: 0,
      padTop: 0,
      padBottom: 0,
      totalHeight: 0,
    });
  });

  // A row height of zero divides into infinitely many rows. The failure mode is
  // not an exception, it is an attempt to render the entire library at once.
  it.each([0, -76, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to guess a window for a row height of %s',
    (rowHeight) => {
      expect(virtualWindow(request({ rowHeight })).endIndex).toBe(0);
    },
  );

  it('renders nothing but still sizes the list when the box has no height', () => {
    const window = virtualWindow(request({ viewportHeight: 0 }));

    expect(rendered(window)).toBe(0);
    expect(window.totalHeight).toBe(10_000);
  });

  it('rounds a fractional overscan down rather than rendering half a row', () => {
    expect(virtualWindow(request({ overscan: 2.9 }))).toMatchObject({ endIndex: 5 });
    expect(virtualWindow(request({ overscan: -4 }))).toMatchObject({ endIndex: 3 });
  });

  it('defaults the overscan when it is not asked for', () => {
    const window = virtualWindow({
      itemCount: 100,
      rowHeight: DEFAULT_ROW_HEIGHT,
      viewportHeight: DEFAULT_ROW_HEIGHT * 4,
      scrollTop: 0,
    });

    expect(window.endIndex).toBe(7);
  });
});

describe('paging', () => {
  it('asks for the next page once the end is in sight', () => {
    expect(
      shouldLoadNextPage({ endIndex: 45, rowCount: 50, nextOffset: 50, threshold: 8 }),
    ).toBe(true);
  });

  it('stays quiet in the middle of a long list', () => {
    expect(
      shouldLoadNextPage({ endIndex: 20, rowCount: 50, nextOffset: 50, threshold: 8 }),
    ).toBe(false);
  });

  // The last page is the one place a list may end under the finger, because
  // there is genuinely nothing more.
  it('never asks when the server said there is no next page', () => {
    expect(shouldLoadNextPage({ endIndex: 50, rowCount: 50, nextOffset: null })).toBe(
      false,
    );
  });

  it('uses its own threshold when none is given', () => {
    expect(shouldLoadNextPage({ endIndex: 42, rowCount: 50, nextOffset: 50 })).toBe(true);
    expect(shouldLoadNextPage({ endIndex: 41, rowCount: 50, nextOffset: 50 })).toBe(
      false,
    );
  });

  it('treats a negative threshold as none at all', () => {
    expect(
      shouldLoadNextPage({ endIndex: 49, rowCount: 50, nextOffset: 50, threshold: -5 }),
    ).toBe(false);
    expect(
      shouldLoadNextPage({ endIndex: 50, rowCount: 50, nextOffset: 50, threshold: -5 }),
    ).toBe(true);
  });
});
