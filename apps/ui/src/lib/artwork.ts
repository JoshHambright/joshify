/**
 * Which image to show, and when it is safe to show it.
 *
 * The crossfade lives here rather than inside the components because the
 * interesting part is a *decision* — hold the frame that is on screen until
 * the next one has pixels — and a decision is worth asserting in Node. jsdom
 * has no decoder and no network, so a DOM test can only ever prove that the
 * component reacts to the events; whether it reacts *correctly* is proved
 * below (D-043's consequence: the default environment is Node, and a component
 * test opts into jsdom).
 *
 * Nothing here computes a colour or a size — the server already did (D-003).
 * It only picks between URLs Spotify supplied and sequences the swap.
 */
import { playingItemKey, selectArtwork, type PlayingItem } from '@joshify/core';

/** The panel is 720 CSS pixels wide (D-039), so the hero wants at least that. */
export const HERO_MIN_WIDTH = 720;

/**
 * The backdrop is blurred past recognition, so the *small* variant is the
 * right source: a heavily downscaled image scaled back up is a free blur, and
 * a 64px download is nothing (PRODUCT §8.1). Fetching 640px to throw the
 * detail away would cost bandwidth and a decode to look identical.
 */
export const BACKDROP_MIN_WIDTH = 64;

/** Everything the two artwork layers need for one playing item. */
export interface ArtworkSources {
  /** Full-bleed source for `Hero`. */
  readonly hero: string | null;
  /** Small source for `Backdrop`, blurred and scaled up. */
  readonly backdrop: string | null;
  /**
   * The item's identity (`playingItemKey`). The artwork components do *not*
   * key on it — see `requestLayer` — but anything keyed by track rather than
   * by image, such as the plate's text, should.
   */
  readonly key: string | null;
}

const EMPTY_SOURCES: ArtworkSources = { hero: null, backdrop: null, key: null };

/**
 * A track with no images — a local file, some podcasts — yields nulls rather
 * than a placeholder URL. Absence is a state the components render as a flat
 * surface, and inventing an image for it would be the one thing the artwork
 * pipeline refuses to do (D-037).
 */
export const artworkSources = (item: PlayingItem | null): ArtworkSources => {
  if (item === null) return EMPTY_SOURCES;
  return {
    hero: selectArtwork(item.images, HERO_MIN_WIDTH)?.url ?? null,
    backdrop: selectArtwork(item.images, BACKDROP_MIN_WIDTH)?.url ?? null,
    key: playingItemKey(item),
  };
};

/** One image on screen, or on its way there. */
export interface ArtworkLayer {
  /** Supplied by the caller: a pure function must not own a counter. */
  readonly id: number;
  readonly src: string;
  /** Decoded and safe to show — not merely "the request finished". */
  readonly ready: boolean;
}

/** The layer nearest the viewer: the one being faded in, or the only one. */
export const topLayer = (layers: readonly ArtworkLayer[]): ArtworkLayer | null =>
  layers[layers.length - 1] ?? null;

/**
 * Ask for `src`, keeping whatever is already visible underneath it.
 *
 * **Keyed on the URL, not on the track.** Two tracks from one album share a
 * cover, and crossfading an image into an identical copy of itself is a
 * 420ms period where the panel does nothing except cost a decode. Conversely
 * a re-poll of the same track re-renders with the same URL and must not
 * restart a fade — which is why an unchanged request returns the array it was
 * given, identity included.
 *
 * At most two layers survive: the one the eye can see and the one arriving.
 * Skipping four tracks in two seconds should leave three abandoned decodes
 * behind, not three composited images.
 */
export const requestLayer = (
  layers: readonly ArtworkLayer[],
  src: string | null,
  id: number,
): readonly ArtworkLayer[] => {
  const top = topLayer(layers);
  if (src === null) return layers.length === 0 ? layers : [];
  if (top !== null && top.src === src) return layers;

  const arriving: ArtworkLayer = { id, src, ready: false };
  const shown = layers.findLast((layer) => layer.ready);
  return shown === undefined ? [arriving] : [shown, arriving];
};

/**
 * The image decoded: it may now be faded in. The layer below stays put, which
 * is the whole point — a swap that removes the old frame first shows a flash
 * of empty surface on every track change.
 */
export const settleLayer = (
  layers: readonly ArtworkLayer[],
  id: number,
): readonly ArtworkLayer[] => {
  const target = layers.find((layer) => layer.id === id);
  if (target === undefined || target.ready) return layers;
  return layers.map((layer) => (layer.id === id ? { ...layer, ready: true } : layer));
};

/**
 * The fade finished, so everything under `id` is now invisible and can go.
 *
 * Pruning here rather than on a timer keeps the component free of clocks, and
 * `requestLayer` prunes as well — so if the transition never reports (a
 * zero-duration fade under `prefers-reduced-motion` fires no event) the worst
 * case is one covered image lingering until the next track.
 */
export const retireLayers = (
  layers: readonly ArtworkLayer[],
  id: number,
): readonly ArtworkLayer[] => {
  const index = layers.findIndex((layer) => layer.id === id);
  const layer = index < 0 ? undefined : layers[index];
  if (index <= 0 || layer === undefined || !layer.ready) return layers;
  return layers.slice(index);
};

/**
 * The image will not load, or will not decode.
 *
 * A failed *top* layer clears the stage to the flat surface rather than
 * leaving the previous album up. Holding the last cover under a track that
 * has none is the more attractive failure and the dishonest one: the panel
 * would be confidently showing the wrong record (D-037). A failed layer
 * further down was already on its way out and just leaves quietly.
 */
export const failLayer = (
  layers: readonly ArtworkLayer[],
  id: number,
): readonly ArtworkLayer[] => {
  const top = topLayer(layers);
  if (top !== null && top.id === id) return [];
  if (!layers.some((layer) => layer.id === id)) return layers;
  return layers.filter((layer) => layer.id !== id);
};

/** The subset of an `<img>` the decode step touches. Narrow enough to fake. */
export interface DecodableImage {
  readonly decode?: (() => Promise<void>) | undefined;
}

/**
 * `load` promises bytes; `decode` promises pixels. On a Pi the gap between
 * them is a real hitch — the first paint of a 640px JPEG decodes on the frame
 * that shows it — so the fade starts only after `decode()` settles.
 *
 * Optional because it is not universal, and because jsdom does not implement
 * it: where it is missing, `load` is the best signal available and the
 * component behaves as it always did.
 */
export const decodeImage = async (image: DecodableImage): Promise<void> => {
  if (typeof image.decode === 'function') await image.decode();
};
