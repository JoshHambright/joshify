import { Jimp, JimpMime } from 'jimp';
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@joshify/core';
import { BACKDROP_EDGE, renderBackdrop } from './blur.js';
import { decodeArtwork } from './decode.js';

/** A 64px cover: exactly what the cache feeds this (PRODUCT.md §8.1). */
const coverOf = async (colour: number, width = 64, height = 64): Promise<Buffer> =>
  new Jimp({ width, height, color: colour }).getBuffer(JimpMime.png);

const splitCover = async (): Promise<Buffer> => {
  const image = new Jimp({ width: 64, height: 64, color: 0x000000ff });
  for (let x = 32; x < 64; x += 1) {
    for (let y = 0; y < 64; y += 1) image.setPixelColor(0xffffffff, x, y);
  }
  return image.getBuffer(JimpMime.png);
};

describe('renderBackdrop', () => {
  it('downscales to the backdrop edge and encodes a JPEG', async () => {
    const rendered = await renderBackdrop(await coverOf(0x2255ccff));

    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;
    expect(rendered.value.width).toBe(BACKDROP_EDGE);
    expect(rendered.value.height).toBe(BACKDROP_EDGE);
    expect(rendered.value.contentType).toBe('image/jpeg');
    // SOI marker. The content type has to be true, not merely declared.
    expect([...rendered.value.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('produces a payload small enough that serving it costs nothing', async () => {
    // The point of D-004: this is pushed on every track change and scaled up by
    // the GPU. If it were not tiny there would be no reason to prefer it over
    // a real blur filter.
    const rendered = await renderBackdrop(await splitCover());

    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;
    expect(rendered.value.bytes.byteLength).toBeLessThan(2048);
  });

  it('keeps the aspect ratio of a non-square cover', async () => {
    // Podcast and playlist art is not always square; a stretched backdrop
    // drifting behind a square hero reads as a bug.
    const rendered = await renderBackdrop(await coverOf(0x338844ff, 64, 32));

    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;
    expect(rendered.value.width).toBe(32);
    expect(rendered.value.height).toBe(16);
  });

  it('never enlarges a cover that is already smaller than the edge', async () => {
    // Upscaling here would cost real bytes on the wire to deliver no extra
    // information — the GPU is going to do the enlarging regardless.
    const rendered = await renderBackdrop(await coverOf(0x884422ff, 16, 16));

    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;
    expect(rendered.value.width).toBe(16);
  });

  it('softens the hard edge the downscale leaves behind', async () => {
    // The upscale is the blur (D-004); this small gaussian only stops the
    // boundary between source samples showing up as a visible facet.
    const rendered = await renderBackdrop(await splitCover(), {
      edge: 16,
      blurRadius: 3,
    });
    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;

    const decoded = await decodeArtwork(rendered.value.bytes);
    expect(isOk(decoded)).toBe(true);
    if (!isOk(decoded)) return;

    // The pixel on the seam should be a mid tone, not either extreme.
    const middle = (8 * 16 + 8) * 4;
    const red = decoded.value.data[middle] ?? 0;
    expect(red).toBeGreaterThan(40);
    expect(red).toBeLessThan(215);
  });

  it('accepts a zero blur radius, leaving the upscale to do all of it', async () => {
    const rendered = await renderBackdrop(await coverOf(0x123456ff), { blurRadius: 0 });

    expect(isOk(rendered)).toBe(true);
  });

  it('clamps nonsensical options rather than handing them to the encoder', async () => {
    // These come from a config file eventually, and jimp throws on a zero
    // dimension or an out-of-range quality.
    const rendered = await renderBackdrop(await coverOf(0x123456ff), {
      edge: 0,
      quality: 500,
    });

    expect(isOk(rendered)).toBe(true);
    if (!isOk(rendered)) return;
    expect(rendered.value.width).toBe(1);
  });

  it('fails as a Result when the source is not decodable', async () => {
    const rendered = await renderBackdrop(Buffer.from('not an image'));

    expect(isErr(rendered)).toBe(true);
    if (!isErr(rendered)) return;
    expect(rendered.error.kind).toBe('unexpected');
  });
});
