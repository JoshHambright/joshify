/**
 * The once-per-track artwork job, in one call.
 *
 * PRODUCT.md §8.1 is the whole argument: the UI is a renderer, so everything
 * expensive happens here — two small downloads, one decode, a theme, and a
 * pre-rendered backdrop — and the browser receives finished artefacts it can
 * composite. A track change costs a few hundred milliseconds on the server and
 * nothing per frame on the GPU.
 *
 * It never fails. A missing cover, a dead CDN and a corrupt JPEG all degrade to
 * "the parts that worked, plus the default theme", because the alternative is a
 * now-playing screen that shows an error where an album should be (§5.3 #5).
 * Anything that went wrong is reported in `problems` for the log, not for the
 * screen.
 */
import { selectArtwork, type Artwork, type JoshifyError } from '@joshify/core';
import { renderBackdrop, type BackdropOptions } from './blur.js';
import { HERO_IMAGE_WIDTH, SOURCE_IMAGE_WIDTH, type ArtworkCache } from './cache.js';
import { decodeArtwork } from './decode.js';
import { DEFAULT_THEME, extractTheme, type ThemeTokens } from './theme.js';

/** Cache suffix for the pre-rendered backdrop derived from a source image. */
export const BACKDROP_KIND = 'backdrop';

export interface PreparedImage {
  readonly key: string;
  readonly path: string;
}

export interface PreparedBackdrop extends PreparedImage {
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export interface PreparedArtwork {
  readonly theme: ThemeTokens;
  /** The large image the screen shows. Null when there is no artwork at all. */
  readonly hero: PreparedImage | null;
  readonly backdrop: PreparedBackdrop | null;
  /** For the log. The UI is never shown any of this. */
  readonly problems: readonly JoshifyError[];
}

export interface PrepareArtworkOptions {
  readonly cache: ArtworkCache;
  readonly backdrop?: BackdropOptions | undefined;
}

export const prepareArtwork = async (
  images: readonly Artwork[],
  options: PrepareArtworkOptions,
): Promise<PreparedArtwork> => {
  const source = selectArtwork(images, SOURCE_IMAGE_WIDTH);
  if (source === null) {
    return { theme: DEFAULT_THEME, hero: null, backdrop: null, problems: [] };
  }

  const problems: JoshifyError[] = [];
  const { cache } = options;

  // The hero is a separate, larger download and is deliberately not required
  // for the theme: a hero that 404s should still leave the device glowing the
  // right colour.
  const heroImage = selectArtwork(images, HERO_IMAGE_WIDTH);
  let hero: PreparedImage | null = null;
  if (heroImage !== null) {
    const loaded = await cache.load(heroImage.url);
    if (loaded.ok) hero = { key: loaded.value.key, path: loaded.value.path };
    else problems.push(loaded.error);
  }

  const loadedSource = await cache.load(source.url);
  if (!loadedSource.ok) {
    return {
      theme: DEFAULT_THEME,
      hero,
      backdrop: null,
      problems: [...problems, loadedSource.error],
    };
  }
  const { key, bytes } = loadedSource.value;

  const decoded = await decodeArtwork(bytes);
  const theme = decoded.ok ? extractTheme(decoded.value) : DEFAULT_THEME;
  if (!decoded.ok) problems.push(decoded.error);

  return {
    theme,
    hero,
    backdrop: await prepareBackdrop(key, bytes, options, problems),
    problems,
  };
};

/**
 * The written file exists so a static handler can serve the backdrop straight
 * off disk; it is not a way to skip the render. Re-rendering from a 64px source
 * is a resize, a blur over ~4k pixels and a tiny JPEG encode — cheaper than
 * reading the cached file back and decoding it to recover its dimensions, which
 * is the only way to answer with a complete descriptor.
 */
const prepareBackdrop = async (
  key: string,
  bytes: Buffer,
  options: PrepareArtworkOptions,
  problems: JoshifyError[],
): Promise<PreparedBackdrop | null> => {
  const rendered = await renderBackdrop(bytes, options.backdrop ?? {});
  if (!rendered.ok) {
    problems.push(rendered.error);
    return null;
  }

  const written = await options.cache.writeDerived(
    key,
    BACKDROP_KIND,
    rendered.value.bytes,
  );
  if (!written.ok) {
    problems.push(written.error);
    return null;
  }
  return {
    key,
    path: written.value,
    contentType: rendered.value.contentType,
    width: rendered.value.width,
    height: rendered.value.height,
  };
};
