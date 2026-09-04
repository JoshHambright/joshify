/**
 * The pre-rendered blurred backdrop (P3-05).
 *
 * Per D-004 the blur is not a filter, it is a *resolution*. A 32px image scaled
 * up to fill a 1280×720 screen is blurred by the GPU's own bilinear sampling —
 * work the display hardware does for free while compositing, with no shader, no
 * `backdrop-filter`, and no per-frame cost. That is the entire reason this runs
 * on the server: it buys back the fragment budget Phase 5's shader chain needs
 * (D-011), and the browser's job shrinks to drawing one small texture large.
 *
 * The small gaussian applied before encoding is not the blur — the upscale is.
 * It exists to soften the hard edges between the 32 source samples, which a
 * bilinear upscale otherwise stretches into visible diamond-shaped facets.
 *
 * ## Why the output is this small
 *
 * A 32px JPEG is well under 2KB, which means serving it costs nothing, caching
 * it costs nothing, and pushing a new one on every track change costs nothing.
 * Encoding it larger would only give the GPU more texels to throw away.
 */
import { Jimp, JimpMime } from 'jimp';
import { createError, err, ok, type JoshifyError, type Result } from '@joshify/core';

/**
 * Longest edge of the backdrop, in pixels.
 *
 * 32 is the point where the blur reads as an *out-of-focus photograph* rather
 * than as a grid: at 16 the facets of the upscale become visible as structure,
 * and at 64 the sleeve's composition starts to resolve and competes with the
 * hero image in front of it.
 */
export const BACKDROP_EDGE = 32;

/** In source pixels, so ~1/16th of the frame. Softens facets, not detail. */
export const BACKDROP_BLUR_RADIUS = 2;

/**
 * Aggressive, deliberately. Every JPEG artefact this introduces is smaller than
 * one source pixel and is smeared out by a 40× upscale before anyone sees it.
 */
export const BACKDROP_QUALITY = 60;

export interface BackdropOptions {
  readonly edge?: number | undefined;
  readonly blurRadius?: number | undefined;
  readonly quality?: number | undefined;
}

export interface Backdrop {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export const BACKDROP_CONTENT_TYPE = 'image/jpeg';

export const renderBackdrop = async (
  source: Buffer,
  options: BackdropOptions = {},
): Promise<Result<Backdrop, JoshifyError>> => {
  const edge = Math.max(1, Math.floor(options.edge ?? BACKDROP_EDGE));
  const blurRadius = Math.max(0, Math.floor(options.blurRadius ?? BACKDROP_BLUR_RADIUS));
  const quality = Math.min(
    100,
    Math.max(1, Math.floor(options.quality ?? BACKDROP_QUALITY)),
  );

  try {
    const image = await Jimp.fromBuffer(source);
    const { width, height } = image.bitmap;

    // Never scale *up*. Enlarging here would hand the GPU a bigger texture with
    // no more information in it, and cost real bytes on the wire to do it.
    const scale = Math.min(1, edge / Math.max(width, height));
    const target = {
      w: Math.max(1, Math.round(width * scale)),
      h: Math.max(1, Math.round(height * scale)),
    };
    image.resize(target);

    // jimp's blur is a stack-blur approximation and rejects a radius below 1;
    // at this size the difference from a true gaussian is invisible, and the
    // upscale is doing the real work anyway.
    if (blurRadius >= 1) image.blur(blurRadius);

    const bytes = await image.getBuffer(JimpMime.jpeg, { quality });
    return ok({
      bytes,
      contentType: BACKDROP_CONTENT_TYPE,
      width: target.w,
      height: target.h,
    });
  } catch (cause) {
    return err(
      createError('unexpected', 'artwork could not be rendered as a backdrop', { cause }),
    );
  }
};
