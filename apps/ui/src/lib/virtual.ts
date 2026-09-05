/**
 * Which rows of a long list are worth existing.
 *
 * A saved library of a thousand albums is ordinary, and a thousand rows is a
 * thousand DOM subtrees and a thousand images on a device with a fixed memory
 * budget. So the list renders the rows in view plus a small overscan, and pads
 * the space above and below with two empty boxes — the scrollbar still measures
 * the whole list, because the sizer is the whole list's height.
 *
 * **The arithmetic lives here, in a pure function, on purpose.** The panel is a
 * fixed 720×1280 (D-039), so the viewport height is a number the caller already
 * knows rather than something to measure — and jsdom reports every element as
 * 0×0, which means a window derived from a real layout is a window no test can
 * check. Every off-by-one in this file is one row that never renders at the
 * bottom of a scroll, which is exactly the bug that ships.
 */

/**
 * Rows of a search result or a library list. Matches the 76px queue rows in
 * SCREENS.md: the same list on the same panel should not change height because
 * it is showing different nouns.
 */
export const DEFAULT_ROW_HEIGHT = 76;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Three is a compromise measured in flicks, not pixels: a fast finger moves
 * further than one frame of rendering can keep up with, and an empty row
 * arriving late reads as the list tearing. More overscan buys smoothness at a
 * cost this device pays in memory, which is the thing being conserved.
 */
export const DEFAULT_OVERSCAN = 3;

export interface WindowRequest {
  readonly itemCount: number;
  readonly rowHeight: number;
  /** Height of the scrolling box, in CSS px. Known, not measured. */
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly overscan?: number | undefined;
}

export interface VirtualWindow {
  /** First row to render. */
  readonly startIndex: number;
  /** One past the last row to render, so `slice(start, end)` is the window. */
  readonly endIndex: number;
  /** Spacer above the window, in px. */
  readonly padTop: number;
  /** Spacer below it. `padTop + rendered + padBottom === totalHeight`. */
  readonly padBottom: number;
  /** The whole list, so the scrollbar tells the truth about its length. */
  readonly totalHeight: number;
}

const EMPTY_WINDOW: VirtualWindow = {
  startIndex: 0,
  endIndex: 0,
  padTop: 0,
  padBottom: 0,
  totalHeight: 0,
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const virtualWindow = (request: WindowRequest): VirtualWindow => {
  const { itemCount, rowHeight, viewportHeight } = request;

  // A row height of zero divides into infinite rows, and the failure mode is
  // not an exception — it is a loop that tries to render every item in the
  // library at once. Refusing to guess is the only safe answer.
  if (itemCount <= 0 || rowHeight <= 0 || !Number.isFinite(rowHeight)) {
    return EMPTY_WINDOW;
  }

  const overscan = Math.max(0, Math.trunc(request.overscan ?? DEFAULT_OVERSCAN));
  const totalHeight = itemCount * rowHeight;
  // Touch scrolling overshoots both ends — rubber-banding reports a negative
  // scrollTop at the top and one past the end at the bottom. Neither is a
  // reason to compute a window outside the list.
  const scrollTop = clamp(request.scrollTop, 0, Math.max(0, totalHeight - viewportHeight));
  const height = Math.max(0, viewportHeight);

  // `floor` for the first row: a row scrolled half out of view is still on
  // screen. `ceil` for the last: a row half in view is too.
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.ceil((scrollTop + height) / rowHeight);

  const startIndex = clamp(firstVisible - overscan, 0, itemCount);
  const endIndex = clamp(lastVisible + overscan, startIndex, itemCount);

  return {
    startIndex,
    endIndex,
    padTop: startIndex * rowHeight,
    padBottom: (itemCount - endIndex) * rowHeight,
    totalHeight,
  };
};

export interface PageTrigger {
  /** The window's `endIndex` — how far down the list has actually been drawn. */
  readonly endIndex: number;
  /** Rows currently loaded. */
  readonly rowCount: number;
  /** From the server's page. Null means there is nothing more to fetch. */
  readonly nextOffset: number | null;
  /** How close to the end counts as near it. */
  readonly threshold?: number | undefined;
}

/**
 * Rows left below the window before the next page is asked for.
 *
 * Roughly a screenful on a 1280px panel: the request has to be in flight before
 * the finger arrives, or the list ends under it and the scroll stops dead.
 */
export const DEFAULT_PAGE_THRESHOLD = 8;

/**
 * Whether the list has been scrolled far enough to want the next page.
 *
 * Separate from the fetch so the decision is testable without one, and so the
 * caller keeps ownership of not asking twice for the same offset — this
 * function is deliberately stateless and will keep saying yes until new rows
 * arrive.
 */
export const shouldLoadNextPage = (trigger: PageTrigger): boolean => {
  if (trigger.nextOffset === null) return false;
  const threshold = Math.max(0, trigger.threshold ?? DEFAULT_PAGE_THRESHOLD);
  return trigger.endIndex >= trigger.rowCount - threshold;
};
