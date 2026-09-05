/**
 * @vitest-environment jsdom
 */
/**
 * The wash. Its crossfade is the hero's, proved in `lib/artwork.test.ts`, so
 * what is asserted here is what makes it a *backdrop*: it is decoration rather
 * than content, the drift is an ancestor of the images rather than the images
 * themselves, and a track with no artwork gets nothing invented for it.
 *
 * The drift itself is a CSS animation. jsdom does not run animations, so
 * asserting it here would only be asserting that a string is present in a
 * stylesheet; it is reviewed in the browser (D-016) and read in the component.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import Backdrop from './Backdrop.svelte';

afterEach(cleanup);

const images = (container: HTMLElement): HTMLImageElement[] => [
  ...container.querySelectorAll('img'),
];

const showing = (container: HTMLElement): (string | null)[] =>
  images(container)
    .filter((image) => image.dataset['ready'] === 'true')
    .map((image) => image.getAttribute('src'));

describe('the backdrop', () => {
  // It is the same picture as the hero, blurred past recognition: announcing
  // it a second time would be noise, and it carries no information anyway.
  it('is decoration, and says so', () => {
    const { container } = render(Backdrop, { src: 'https://i/64' });

    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(images(container)[0]?.getAttribute('alt')).toBe('');
  });

  // The animated element must be an ancestor of the blurred one: a `filter` is
  // expensive to rasterise and cheap to re-composite, so the blur has to sit
  // on something that never moves.
  it('drifts the wrapper, not the blurred image', () => {
    const { container } = render(Backdrop, { src: 'https://i/64' });
    const drift = container.querySelector('.drift');

    expect(drift).not.toBeNull();
    expect(drift?.querySelectorAll('img')).toHaveLength(1);
  });

  it('does not show the wash until it has decoded', async () => {
    const { container } = render(Backdrop, { src: 'https://i/64' });
    expect(showing(container)).toEqual([]);

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to load');
    await fireEvent.load(image);

    await waitFor(() => {
      expect(showing(container)).toEqual(['https://i/64']);
    });
  });

  it('holds the old wash while the new one loads, then keeps both for the fade', async () => {
    const { container, rerender } = render(Backdrop, { src: 'https://i/a' });
    const first = images(container)[0];
    if (first === undefined) throw new Error('nothing to load');
    await fireEvent.load(first);
    await waitFor(() => {
      expect(showing(container)).toEqual(['https://i/a']);
    });

    await rerender({ src: 'https://i/b' });
    expect(showing(container)).toEqual(['https://i/a']);

    const second = images(container)[1];
    if (second === undefined) throw new Error('nothing arriving');
    await fireEvent.load(second);
    await waitFor(() => {
      expect(showing(container)).toEqual(['https://i/a', 'https://i/b']);
    });

    await fireEvent.transitionEnd(second);
    expect(images(container)).toHaveLength(1);
  });

  // A wash with no album to derive from would be an invention, so there is
  // none: the panel is the flat surface tint.
  it('shows nothing at all for a track with no artwork', () => {
    const { container } = render(Backdrop, { src: null });

    expect(images(container)).toHaveLength(0);
    expect(container.querySelector('.drift')).not.toBeNull();
  });

  it('falls back to the flat surface when the image fails', async () => {
    const { container } = render(Backdrop, { src: 'https://i/gone' });

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to break');
    await fireEvent.error(image);

    expect(images(container)).toHaveLength(0);
  });

  it('treats bytes that will not decode as a broken image', async () => {
    const decode = (): Promise<void> => Promise.reject(new Error('undecodable'));
    const { container } = render(Backdrop, { src: 'https://i/64', decode });

    const image = images(container)[0];
    if (image === undefined) throw new Error('nothing to decode');
    await fireEvent.load(image);

    await waitFor(() => {
      expect(images(container)).toHaveLength(0);
    });
  });
});
