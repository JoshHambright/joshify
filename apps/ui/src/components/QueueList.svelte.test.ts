/**
 * @vitest-environment jsdom
 */
/**
 * The queue is the one screen whose main risk is not what it draws but what it
 * *offers*. Spotify has no reorder, no remove and no jump-to-position, so these
 * assert the two ways this screen could lie: putting something on it that
 * invites a touch and cannot answer one, and leaving the rows inert with no
 * word about why (P4-05, D-007).
 *
 * `QueueRow` has no test file of its own on purpose — it is never rendered
 * alone, and testing it through the list keeps the assertions about what is on
 * the screen rather than about the component tree behind it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import type { JoshifyError, PlayingItem } from '@joshify/core';
import QueueList from './QueueList.svelte';

const track = (over: Partial<PlayingItem> = {}): PlayingItem => ({
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Xtal',
  subtitle: 'Aphex Twin',
  durationMs: 293_000,
  images: [],
  isLocal: false,
  ...over,
});

const offline: JoshifyError = {
  kind: 'network',
  message: 'the panel could not reach the Joshify server',
  retryable: true,
};

const mount = (props: {
  current?: PlayingItem | null;
  upcoming?: readonly PlayingItem[];
  pending?: boolean;
  problem?: JoshifyError | null;
}) =>
  render(QueueList, {
    queue: { current: props.current ?? null, upcoming: props.upcoming ?? [] },
    pending: props.pending ?? false,
    problem: props.problem ?? null,
  });

const rowTitles = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.queue-row .title')].map((node) => node.textContent);

afterEach(cleanup);

describe('the queue list', () => {
  it('lists what is coming, in order, with its length', () => {
    const { container } = mount({
      current: track({ title: 'Xtal' }),
      upcoming: [
        track({ id: 'b', title: 'Tha', durationMs: 550_000 }),
        track({ id: 'c', title: 'Pulsewidth' }),
      ],
    });

    expect(rowTitles(container)).toEqual(['Xtal', 'Tha', 'Pulsewidth']);
    expect(screen.getByText('9:10')).toBeDefined();
  });

  // The current item is where the order is counted from, so it is marked
  // rather than numbered, and it is pinned outside the scroller so it stays on
  // screen however far down the list a finger has pushed.
  it('pins the playing item at the top and marks it', () => {
    const { container } = mount({
      current: track({ title: 'Xtal' }),
      upcoming: [track({ id: 'b', title: 'Tha' })],
    });

    const pinned = container.querySelector('.now .queue-row');
    expect(pinned?.querySelector('.title')?.textContent).toBe('Xtal');
    expect(pinned?.querySelector('.position')?.textContent).toBe('NOW');
  });

  it('numbers the upcoming rows from one', () => {
    const { container } = mount({
      current: track(),
      upcoming: [track({ id: 'b' }), track({ id: 'c' }), track({ id: 'd' })],
    });

    const numbers = [...container.querySelectorAll('[role="listitem"] .position')].map(
      (node) => node.textContent,
    );
    expect(numbers).toEqual(['1', '2', '3']);
  });

  // P4-05, and the whole point of the screen: Spotify has no reorder, no
  // remove and no jump-to-position, so there is nothing here that a touch
  // could honestly do. A row that invited one and then did nothing would teach
  // the viewer that the panel is broken.
  it('offers nothing to tap, anywhere on the screen', () => {
    const { container } = mount({
      current: track(),
      upcoming: [track({ id: 'b' }), track({ id: 'c' })],
    });

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('input, a, [tabindex]')).toHaveLength(0);
  });

  it('says why the queue cannot be touched rather than leaving it a mystery', () => {
    mount({ current: track(), upcoming: [track({ id: 'b' })] });

    const note = screen.getByText(/view only/i);
    expect(note.textContent).toMatch(/reorder/i);
    expect(note.textContent).toMatch(/jump/i);
  });

  // The explanation is about the list. With no list, it is noise on a screen
  // that already has a sentence of its own.
  it('drops the explanation when there is no list to explain', () => {
    mount({ current: track() });
    expect(screen.queryByText(/view only/i)).toBeNull();
  });

  // Two genuinely different facts. A track playing with nothing after it is an
  // account behaving normally; an empty queue means nothing is playing at all.
  it('tells "nothing after this" apart from "nothing at all"', () => {
    mount({ current: track() });
    expect(screen.getByText(/Nothing queued after this one/)).toBeDefined();

    cleanup();
    mount({});
    expect(screen.getByText(/Start something playing/)).toBeDefined();
  });

  it('explains an empty queue rather than showing a fault or a spinner', () => {
    const { container } = mount({});
    expect(container.textContent).not.toMatch(/error|failed|loading/i);
  });

  it('says it is reading only before the first answer lands', () => {
    mount({ pending: true });
    expect(screen.getByText(/Reading the queue/)).toBeDefined();
  });

  // D-049's failure rule: emptying a list somebody is reading, to report that
  // we could not confirm it, is the same mistake as blanking the album on a
  // dropped packet.
  it('keeps showing the rows it has when a refresh failed', () => {
    const { container } = mount({
      current: track({ title: 'Xtal' }),
      upcoming: [track({ id: 'b', title: 'Tha' })],
      problem: offline,
    });

    expect(rowTitles(container)).toEqual(['Xtal', 'Tha']);
  });

  it('says the queue is unreadable only when it has no rows to show instead', () => {
    mount({ problem: offline });
    expect(screen.getByText(/could not be read/)).toBeDefined();
  });

  // A queue legitimately holds the same track twice; keyed on identity alone
  // one of them would vanish.
  it('shows a track queued twice twice', () => {
    const { container } = mount({
      upcoming: [track({ id: 'b', title: 'Tha' }), track({ id: 'b', title: 'Tha' })],
    });

    expect(rowTitles(container)).toEqual(['Tha', 'Tha']);
  });

  // A real queue can be hundreds of items and the device's memory is fixed, so
  // the rows that are not on screen do not exist.
  it('draws a screenful of a long queue, not the whole thing', () => {
    const upcoming = Array.from({ length: 300 }, (_unused, index) =>
      track({ id: `t-${String(index)}`, title: `Track ${String(index)}` }),
    );
    const { container } = mount({ current: track(), upcoming });

    const drawn = container.querySelectorAll('[role="listitem"] .queue-row');
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(20);
    expect(screen.getByText('Track 0')).toBeDefined();
    expect(screen.queryByText('Track 299')).toBeNull();
  });

  it('drops an empty second line rather than drawing a blank one', () => {
    const { container } = mount({
      upcoming: [track({ id: 'b', title: 'Demo', subtitle: '', isLocal: true })],
    });

    expect(container.querySelectorAll('.subtitle')).toHaveLength(0);
  });
});
