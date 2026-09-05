/**
 * @vitest-environment jsdom
 */
/**
 * The component half of the crossfade: that the load, decode, error and
 * transition events are actually wired to the decisions in `lib/artwork.ts`.
 * The decisions themselves are asserted there, in Node.
 *
 * jsdom loads no images and decodes nothing, which is exactly why the events
 * are driven by hand here — and why the component takes its decode step as a
 * prop instead of reaching for `Image.prototype.decode` directly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import Hero from './Hero.svelte';

afterEach(cleanup);

const images = (container: HTMLElement): HTMLImageElement[] => [
  ...container.querySelectorAll('img'),
];

const sources = (container: HTMLElement): (string | null)[] =>
  images(container).map((image) => image.getAttribute('src'));

/** The one that is actually visible: `data-ready` drives the opacity. */
const showing = (container: HTMLElement): (string | null)[] =>
  images(container)
    .filter((image) => image.dataset['ready'] === 'true')
    .map((image) => image.getAttribute('src'));

const arrive = async (container: HTMLElement, src: string): Promise<void> => {
  const image = images(container).find(
    (candidate) => candidate.getAttribute('src') === src,
  );
  if (image === undefined) throw new Error(`no layer for ${src}`);
  await fireEvent.load(image);
  await waitFor(() => {
    expect(showing(container)).toContain(src);
  });
};

describe('the hero', () => {
  it('renders the album full bleed with an empty alt, since it is not content', () => {
    const { container } = render(Hero, { src: 'https://i/640' });

    expect(sources(container)).toEqual(['https://i/640']);
    expect(images(container)[0]?.getAttribute('alt')).toBe('');
  });

  // The single rule this component exists for. An image is mounted invisible
  // and stays invisible until the browser says it has pixels.
  it('does not show an image until it has decoded', async () => {
    const { container } = render(Hero, { src: 'https://i/640' });
    expect(showing(container)).toEqual([]);

    await arrive(container, 'https://i/640');
    expect(showing(container)).toEqual(['https://i/640']);
  });

  it('holds the old album on screen while the new one is still loading', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');

    await rerender({ src: 'https://i/b' });

    // Both are mounted; only the outgoing one is visible. This is the moment
    // a naive swap would be showing the surface tint instead.
    expect(sources(container)).toEqual(['https://i/a', 'https://i/b']);
    expect(showing(container)).toEqual(['https://i/a']);
  });

  it('crossfades — the new image is over the old one, not instead of it', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');
    await rerender({ src: 'https://i/b' });
    await arrive(container, 'https://i/b');

    expect(showing(container)).toEqual(['https://i/a', 'https://i/b']);
  });

  it('drops the covered image once the fade reports finished', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');
    await rerender({ src: 'https://i/b' });
    await arrive(container, 'https://i/b');

    const incoming = images(container)[1];
    if (incoming === undefined) throw new Error('nothing to finish');
    await fireEvent.transitionEnd(incoming);

    expect(sources(container)).toEqual(['https://i/b']);
  });

  // A poll re-renders with the same URL every few seconds. Restarting the fade
  // on each would be a permanent shimmer.
  it('ignores a re-render of the image it is already showing', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');

    await rerender({ src: 'https://i/a' });

    expect(sources(container)).toEqual(['https://i/a']);
    expect(showing(container)).toEqual(['https://i/a']);
  });

  // A local file, or some podcasts: a flat surface tint, never a placeholder
  // graphic. A missing-image glyph at this size reads as a fault.
  it('shows no image element at all when there is no artwork', () => {
    const { container } = render(Hero, { src: null });

    expect(images(container)).toHaveLength(0);
    expect(container.querySelector('.hero')).not.toBeNull();
  });

  it('clears to the flat surface when the artwork goes away', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');

    await rerender({ src: null });

    expect(images(container)).toHaveLength(0);
  });

  it('falls back to the flat surface rather than leaving a broken image', async () => {
    const { container } = render(Hero, { src: 'https://i/gone' });

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to break');
    await fireEvent.error(image);

    expect(images(container)).toHaveLength(0);
  });

  // Keeping the previous cover up would be the prettier failure and the
  // dishonest one: the panel would be confidently showing the wrong record.
  it('does not keep the previous album when the new one fails', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');
    await rerender({ src: 'https://i/gone' });

    const incoming = images(container)[1];
    if (incoming === undefined) throw new Error('nothing to break');
    await fireEvent.error(incoming);

    expect(images(container)).toHaveLength(0);
  });

  it('treats bytes that will not decode as a broken image', async () => {
    const decode = (): Promise<void> => Promise.reject(new Error('undecodable'));
    const { container } = render(Hero, { src: 'https://i/640', decode });

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to decode');
    await fireEvent.load(image);

    await waitFor(() => {
      expect(images(container)).toHaveLength(0);
    });
  });

  it('waits for the decode before showing the image, not just the load', async () => {
    let release = (): void => undefined;
    const decode = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const { container } = render(Hero, { src: 'https://i/640', decode });

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to decode');
    await fireEvent.load(image);
    expect(showing(container)).toEqual([]);

    release();
    await waitFor(() => {
      expect(showing(container)).toEqual(['https://i/640']);
    });
  });

  // Nothing playing keeps the last album, dimmed (SCREENS.md) — the caller
  // keeps passing the same src and adds the flag.
  it('dims the album without dropping it', async () => {
    const { container, rerender } = render(Hero, { src: 'https://i/a' });
    await arrive(container, 'https://i/a');

    await rerender({ src: 'https://i/a', dimmed: true });

    expect(container.querySelector('.hero')?.classList.contains('dimmed')).toBe(true);
    expect(showing(container)).toEqual(['https://i/a']);
  });
});
