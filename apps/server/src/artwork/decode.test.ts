import { Jimp, JimpMime } from 'jimp';
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@joshify/core';
import { decodeArtwork } from './decode.js';

const pngOf = async (width: number, height: number, colour: number): Promise<Buffer> =>
  new Jimp({ width, height, color: colour }).getBuffer(JimpMime.png);

describe('decodeArtwork', () => {
  it('returns pixels with four bytes each, the shape the extractor expects', async () => {
    const decoded = await decodeArtwork(await pngOf(8, 4, 0xff8800ff));

    expect(isOk(decoded)).toBe(true);
    if (!isOk(decoded)) return;
    expect(decoded.value.width).toBe(8);
    expect(decoded.value.height).toBe(4);
    expect(decoded.value.data.length).toBe(8 * 4 * 4);
    expect([...decoded.value.data.slice(0, 4)]).toEqual([255, 136, 0, 255]);
  });

  it('returns an error rather than throwing when the bytes are not an image', async () => {
    // Artwork bytes come off a network the device does not control; a captive
    // portal's HTML must not throw out of a track-change handler.
    const decoded = await decodeArtwork(Buffer.from('<html>sign in to wifi</html>'));

    expect(isErr(decoded)).toBe(true);
    if (!isErr(decoded)) return;
    expect(decoded.error.kind).toBe('unexpected');
    expect(decoded.error.retryable).toBe(false);
  });
});
