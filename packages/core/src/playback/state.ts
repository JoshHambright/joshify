/**
 * One clean internal shape for `GET /me/player`.
 *
 * The UI is a dumb renderer (D-003): it gets a flat, already-decided object
 * and never reaches into a Spotify payload itself. That means every quirk of
 * that payload has to be absorbed here, and there are a lot of them — the
 * response models tracks, podcast episodes, local files and a dozen kinds of
 * Connect device through one loosely-typed JSON shape, and half its fields are
 * legitimately null. This is defensive parsing of something we do not control:
 * anything recognisable becomes a state, and only genuine nonsense becomes an
 * error.
 */
import { createError, type JoshifyError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export type PlayingItemKind = 'track' | 'episode';

export type RepeatMode = 'off' | 'track' | 'context';

export interface Artwork {
  readonly url: string;
  /**
   * Nullable because Spotify says so: generated art (playlist mosaics, some
   * podcast covers) arrives with `width` and `height` set to null.
   */
  readonly width: number | null;
  readonly height: number | null;
}

export interface PlayingItem {
  /** Which half of the union this came from; the two have different shapes. */
  readonly kind: PlayingItemKind;
  /** Null for local files, which exist only on the playing device. */
  readonly id: string | null;
  readonly uri: string | null;
  readonly title: string;
  /** Artists joined for a track, the show name for an episode. May be empty. */
  readonly subtitle: string;
  readonly durationMs: number;
  /**
   * Every size Spotify offered, widest first.
   *
   * Deliberately not reduced to a single URL: the theme extractor wants the
   * 64px variant (cheap to fetch, and downscaling for an average colour is
   * wasted work) while the now-playing screen wants the largest. Picking one
   * here would force the other consumer to refetch.
   */
  readonly images: readonly Artwork[];
  /** A file on the playing device. Has no id, usually no artwork. */
  readonly isLocal: boolean;
}

export interface PlaybackDevice {
  /** Null for a restricted device that will not accept transfer targets. */
  readonly id: string | null;
  readonly name: string;
  readonly type: string;
  readonly isActive: boolean;
  /**
   * Null when the device does not report a volume — common for TVs, receivers
   * and cast targets whose volume lives outside Spotify. Defaulting it to 0
   * would tell the UI to draw a muted slider for a device playing at full
   * blast, so the absence is modelled instead of papered over.
   */
  readonly volumePercent: number | null;
  /** Whether a volume command has any chance of working on this device. */
  readonly supportsVolume: boolean;
}

export interface PlaybackState {
  readonly isPlaying: boolean;
  readonly item: PlayingItem | null;
  readonly device: PlaybackDevice | null;
  readonly progressMs: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
}

/**
 * Nothing playing anywhere.
 *
 * Spotify answers `204 No Content` when no device has a session, so the caller
 * has no body to hand us. That is an ordinary state — the screen shows an idle
 * view — and never an error.
 */
export const IDLE_PLAYBACK: PlaybackState = {
  isPlaying: false,
  item: null,
  device: null,
  progressMs: 0,
  shuffle: false,
  repeat: 'off',
};

/*
 * The raw shapes, with every field left `unknown`. Naming them keeps the
 * narrowing below readable without ever asserting a *value* type we have not
 * actually checked.
 */
interface RawPlayback {
  is_playing?: unknown;
  item?: unknown;
  device?: unknown;
  progress_ms?: unknown;
  shuffle_state?: unknown;
  repeat_state?: unknown;
}

interface RawItem {
  type?: unknown;
  id?: unknown;
  uri?: unknown;
  name?: unknown;
  duration_ms?: unknown;
  is_local?: unknown;
  artists?: unknown;
  album?: unknown;
  show?: unknown;
  images?: unknown;
}

interface RawNamed {
  name?: unknown;
}

interface RawWithImages {
  name?: unknown;
  images?: unknown;
}

interface RawImage {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

interface RawDevice {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  is_active?: unknown;
  volume_percent?: unknown;
  supports_volume?: unknown;
}

const asRaw = <T>(value: unknown): T | null =>
  typeof value === 'object' && value !== null ? (value as T) : null;

const asArray = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? (value as readonly unknown[]) : null;

/** Empty strings are treated as absent: Spotify sends them for missing text. */
const asText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asFlag = (value: unknown): boolean => typeof value === 'boolean' && value;

const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'context'];

const normaliseRepeat = (value: unknown): RepeatMode => {
  const mode = asText(value);
  return REPEAT_MODES.find((candidate) => candidate === mode) ?? 'off';
};

/**
 * Sorted widest first, because the documented order is "the source order",
 * which in practice means whatever the ingest pipeline produced. Consumers
 * that want a specific size should not have to discover that per endpoint.
 */
const normaliseImages = (value: unknown): readonly Artwork[] => {
  const list = asArray(value);
  if (list === null) return [];

  const images: Artwork[] = [];
  for (const entry of list) {
    const raw = asRaw<RawImage>(entry);
    if (raw === null) continue;
    const url = asText(raw.url);
    if (url === null) continue;
    images.push({ url, width: asNumber(raw.width), height: asNumber(raw.height) });
  }
  return images.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
};

/**
 * The smallest artwork at least `minWidth` across, falling back to the largest
 * available. Sizeless images (width null) only ever win by default, since
 * there is no way to know whether they are big enough.
 */
export const selectArtwork = (
  images: readonly Artwork[],
  minWidth: number,
): Artwork | null => {
  let best: Artwork | null = null;
  for (const image of images) {
    if (image.width !== null && image.width >= minWidth) best = image;
  }
  return best ?? images[0] ?? null;
};

const artistNames = (value: unknown): readonly string[] => {
  const list = asArray(value);
  if (list === null) return [];

  const names: string[] = [];
  for (const entry of list) {
    const name = asText(asRaw<RawNamed>(entry)?.name);
    if (name !== null) names.push(name);
  }
  return names;
};

/**
 * Tracks and episodes share a field name and almost nothing else: an episode
 * has no `artists` and no `album`, and belongs to a `show` instead. Reading
 * `item.album.images` — the obvious thing — throws on every podcast.
 *
 * `type` is trusted when present, but a `show` is treated as proof on its own:
 * without `additional_types=episode` on the request Spotify has historically
 * returned episode-shaped objects with a track-ish type, and rendering one as
 * a track loses the artwork entirely.
 */
const normaliseItem = (value: unknown): Result<PlayingItem, JoshifyError> => {
  const raw = asRaw<RawItem>(value);
  if (raw === null) {
    return err(createError('unexpected', 'player item was not an object'));
  }

  const title = asText(raw.name);
  if (title === null) {
    return err(createError('unexpected', 'player item had no name'));
  }

  const show = asRaw<RawWithImages>(raw.show);
  const kind: PlayingItemKind =
    asText(raw.type) === 'episode' || show !== null ? 'episode' : 'track';

  // An episode carries its own images *and* the show's; a local file carries
  // neither, and its artists array is frequently present but empty.
  const images =
    kind === 'episode'
      ? normaliseImages(raw.images ?? show?.images)
      : normaliseImages(asRaw<RawWithImages>(raw.album)?.images);

  const subtitle =
    kind === 'episode'
      ? (asText(show?.name) ?? '')
      : artistNames(raw.artists).join(', ');

  return ok({
    kind,
    id: asText(raw.id),
    uri: asText(raw.uri),
    title,
    subtitle,
    durationMs: Math.max(0, asNumber(raw.duration_ms) ?? 0),
    images,
    isLocal: asFlag(raw.is_local),
  });
};

const normaliseDevice = (value: unknown): Result<PlaybackDevice, JoshifyError> => {
  const raw = asRaw<RawDevice>(value);
  if (raw === null) {
    return err(createError('unexpected', 'player device was not an object'));
  }

  const volumePercent = asNumber(raw.volume_percent);

  return ok({
    id: asText(raw.id),
    name: asText(raw.name) ?? 'Unknown device',
    type: asText(raw.type) ?? 'Unknown',
    isActive: asFlag(raw.is_active),
    volumePercent,
    // `supports_volume` is a relatively recent addition and older Connect
    // clients omit it; a reported volume is the next best evidence.
    supportsVolume:
      typeof raw.supports_volume === 'boolean'
        ? raw.supports_volume
        : volumePercent !== null,
  });
};

/**
 * Normalise a `/me/player` body. Pass `null` or `undefined` for a 204.
 *
 * Errors are reserved for payloads we cannot recognise at all, because an
 * `Err` puts a fault on screen. A missing item, a missing device and a missing
 * volume are all *states*, and each has a sensible thing to draw.
 */
export const normalisePlaybackState = (
  body: unknown,
): Result<PlaybackState, JoshifyError> => {
  if (body === null || body === undefined) return ok(IDLE_PLAYBACK);

  const raw = asRaw<RawPlayback>(body);
  if (raw === null) {
    return err(createError('unexpected', 'player response was not an object'));
  }
  // The one field every real player payload has, whatever else is null. Its
  // absence means this is not a player payload — an array, `{}`, an error body
  // that slipped through — and guessing at that would hide a real bug.
  if (typeof raw.is_playing !== 'boolean') {
    return err(createError('unexpected', 'player response had no is_playing flag'));
  }

  let item: PlayingItem | null = null;
  if (raw.item !== null && raw.item !== undefined) {
    const parsed = normaliseItem(raw.item);
    if (!parsed.ok) return parsed;
    item = parsed.value;
  }

  let device: PlaybackDevice | null = null;
  if (raw.device !== null && raw.device !== undefined) {
    const parsed = normaliseDevice(raw.device);
    if (!parsed.ok) return parsed;
    device = parsed.value;
  }

  return ok({
    isPlaying: raw.is_playing,
    item,
    device,
    // Null while a device is starting or between items. Zero is the only
    // honest thing to draw, and interpolation (P2-04) starts from it anyway.
    progressMs: Math.max(0, asNumber(raw.progress_ms) ?? 0),
    shuffle: asFlag(raw.shuffle_state),
    repeat: normaliseRepeat(raw.repeat_state),
  });
};
