/**
 * The one place artwork bytes become pixels.
 *
 * `jimp` (D-027) is a pure-JS decoder, chosen because it cannot fail to install
 * on a Pi. It also throws on malformed input, and artwork bytes come off the
 * network — a captive portal's HTML, a truncated response, a JPEG whose tail
 * never arrived — so decoding is wrapped once here and every caller gets a
 * `Result` instead of an exception thrown from inside a render path.
 */
import { Jimp } from 'jimp';
import { createError, err, ok, type JoshifyError, type Result } from '@joshify/core';
import type { PixelData } from './theme.js';

export const decodeArtwork = async (
  bytes: Buffer,
): Promise<Result<PixelData, JoshifyError>> => {
  try {
    const image = await Jimp.fromBuffer(bytes);
    return ok({
      width: image.bitmap.width,
      height: image.bitmap.height,
      data: image.bitmap.data,
    });
  } catch (cause) {
    // `unexpected`, not `network`: the bytes arrived, they are simply not an
    // image we can read, and no amount of retrying changes that.
    return err(createError('unexpected', 'artwork could not be decoded', { cause }));
  }
};
