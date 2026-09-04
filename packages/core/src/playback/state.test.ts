import { describe, expect, it } from 'vitest';
import { isOk } from '../result.js';
import {
  IDLE_PLAYBACK,
  normalisePlaybackState,
  selectArtwork,
  type PlaybackState,
} from './state.js';

const parseOrThrow = (body: unknown): PlaybackState => {
  const result = normalisePlaybackState(body);
  if (!isOk(result)) throw new Error(result.error.message);
  return result.value;
};

const speaker = {
  id: '5fbb3ba6aa454b5534c4ba43a8c7e8e45a63ad0e',
  is_active: true,
  is_private_session: false,
  is_restricted: false,
  name: 'Kitchen',
  type: 'Speaker',
  volume_percent: 62,
  supports_volume: true,
};

/** A normal track on a phone, trimmed to the fields we actually read. */
const trackPayload = {
  device: speaker,
  repeat_state: 'context',
  shuffle_state: true,
  timestamp: 1_700_000_000_000,
  progress_ms: 74_123,
  is_playing: true,
  item: {
    album: {
      album_type: 'album',
      images: [
        { url: 'https://i.scdn.co/image/ab-300', height: 300, width: 300 },
        { url: 'https://i.scdn.co/image/ab-640', height: 640, width: 640 },
        { url: 'https://i.scdn.co/image/ab-64', height: 64, width: 64 },
      ],
      name: 'Homework',
      uri: 'spotify:album:1A2GTWGtFfWp7KSQTwWOyo',
    },
    artists: [
      { name: 'Daft Punk', uri: 'spotify:artist:4tZwfgrHOc3mvqYlEYSvVi' },
      { name: 'Todd Edwards', uri: 'spotify:artist:0000000000000000000001' },
    ],
    duration_ms: 428_000,
    id: '2cGxRwrMyEAp8dEbuZaVv6',
    is_local: false,
    name: 'Around the World',
    type: 'track',
    uri: 'spotify:track:2cGxRwrMyEAp8dEbuZaVv6',
  },
  currently_playing_type: 'track',
};

/**
 * A podcast episode. Note what is *missing*: no `artists`, no `album`. The
 * show sits under `show`, and the episode has its own `images` as well.
 */
const episodePayload = {
  device: { ...speaker, name: 'Living Room', type: 'Computer' },
  repeat_state: 'off',
  shuffle_state: false,
  progress_ms: 1_800_000,
  is_playing: true,
  item: {
    description: 'A conversation about nothing in particular.',
    duration_ms: 3_600_000,
    id: '512ojhOuo1ktJprKbVcKyQ',
    images: [
      { url: 'https://i.scdn.co/image/ep-640', height: 640, width: 640 },
      { url: 'https://i.scdn.co/image/ep-64', height: 64, width: 64 },
    ],
    name: 'Episode 214: The Long Way Round',
    release_date: '2024-03-11',
    show: {
      description: 'Weekly.',
      images: [{ url: 'https://i.scdn.co/image/show-640', height: 640, width: 640 }],
      name: 'The Long Way Round',
      publisher: 'Someone',
      uri: 'spotify:show:0000000000000000000002',
    },
    type: 'episode',
    uri: 'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
  },
  currently_playing_type: 'episode',
};

/** A file that lives on the playing machine: no id, no artwork, no album art. */
const localFilePayload = {
  device: speaker,
  repeat_state: 'off',
  shuffle_state: false,
  progress_ms: 12_000,
  is_playing: true,
  item: {
    album: { album_type: 'compilation', images: [], name: '', uri: '' },
    artists: [{ name: '', uri: '' }],
    duration_ms: 205_000,
    id: null,
    is_local: true,
    name: 'unmastered_mix_v3',
    type: 'track',
    uri: 'spotify:local:::unmastered_mix_v3:205',
  },
  currently_playing_type: 'track',
};

describe('normalisePlaybackState', () => {
  it('flattens a normal track', () => {
    const state = parseOrThrow(trackPayload);
    expect(state.isPlaying).toBe(true);
    expect(state.progressMs).toBe(74_123);
    expect(state.shuffle).toBe(true);
    expect(state.repeat).toBe('context');
    expect(state.item).toEqual({
      kind: 'track',
      id: '2cGxRwrMyEAp8dEbuZaVv6',
      uri: 'spotify:track:2cGxRwrMyEAp8dEbuZaVv6',
      title: 'Around the World',
      subtitle: 'Daft Punk, Todd Edwards',
      durationMs: 428_000,
      images: [
        { url: 'https://i.scdn.co/image/ab-640', width: 640, height: 640 },
        { url: 'https://i.scdn.co/image/ab-300', width: 300, height: 300 },
        { url: 'https://i.scdn.co/image/ab-64', width: 64, height: 64 },
      ],
      isLocal: false,
    });
    expect(state.device).toEqual({
      id: '5fbb3ba6aa454b5534c4ba43a8c7e8e45a63ad0e',
      name: 'Kitchen',
      type: 'Speaker',
      isActive: true,
      volumePercent: 62,
      supportsVolume: true,
    });
  });

  // Spotify does not promise the album images are ordered, and the widest is
  // not reliably first. Both consumers (64px for colour, largest for display)
  // depend on the order, so it is imposed here.
  it('sorts artwork widest first regardless of payload order', () => {
    const state = parseOrThrow(trackPayload);
    expect(state.item?.images.map((image) => image.width)).toEqual([640, 300, 64]);
  });

  // The podcast shape is the classic crash: no artists, no album, images under
  // the episode and the show. Reading item.album.images throws on every one.
  it('reads an episode from show/images rather than album/artists', () => {
    const state = parseOrThrow(episodePayload);
    expect(state.item?.kind).toBe('episode');
    expect(state.item?.title).toBe('Episode 214: The Long Way Round');
    expect(state.item?.subtitle).toBe('The Long Way Round');
    expect(state.item?.durationMs).toBe(3_600_000);
    expect(state.item?.images).toEqual([
      { url: 'https://i.scdn.co/image/ep-640', width: 640, height: 640 },
      { url: 'https://i.scdn.co/image/ep-64', width: 64, height: 64 },
    ]);
  });

  it('falls back to the show artwork when the episode carries none', () => {
    const state = parseOrThrow({
      ...episodePayload,
      item: {
        duration_ms: 3_600_000,
        id: '512ojhOuo1ktJprKbVcKyQ',
        name: 'Episode 214: The Long Way Round',
        show: episodePayload.item.show,
        type: 'episode',
        uri: 'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
      },
    });
    expect(state.item?.images).toEqual([
      { url: 'https://i.scdn.co/image/show-640', width: 640, height: 640 },
    ]);
  });

  // Without `additional_types=episode` Spotify has returned episode-shaped
  // objects that do not say `episode`. The `show` field is the real tell.
  it('treats an item with a show as an episode whatever its type says', () => {
    const state = parseOrThrow({
      ...episodePayload,
      item: { ...episodePayload.item, type: 'track' },
    });
    expect(state.item?.kind).toBe('episode');
    expect(state.item?.subtitle).toBe('The Long Way Round');
  });

  // 204 No Content. Nobody is playing anything — a state, not a failure.
  it('treats an empty body as idle rather than an error', () => {
    expect(parseOrThrow(null)).toEqual(IDLE_PLAYBACK);
    expect(parseOrThrow(undefined)).toEqual(IDLE_PLAYBACK);
  });

  // A device can be awake with nothing loaded — just after a transfer, or
  // when the queue has run out.
  it('accepts an active device with no item', () => {
    const state = parseOrThrow({
      device: { ...speaker, volume_percent: 100 },
      repeat_state: 'off',
      shuffle_state: false,
      progress_ms: null,
      is_playing: false,
      item: null,
      currently_playing_type: 'unknown',
    });
    expect(state.item).toBeNull();
    expect(state.device?.name).toBe('Kitchen');
    expect(state.progressMs).toBe(0);
  });

  it('accepts an item with no device', () => {
    const state = parseOrThrow({ ...trackPayload, device: null });
    expect(state.device).toBeNull();
    expect(state.item?.title).toBe('Around the World');
  });

  // Local files have no id, no usable artwork, and an artists array of empty
  // names. Every one of those is legal; none of them is an error.
  it('keeps a local file playable with a null id and no artwork', () => {
    const state = parseOrThrow(localFilePayload);
    expect(state.item?.id).toBeNull();
    expect(state.item?.isLocal).toBe(true);
    expect(state.item?.title).toBe('unmastered_mix_v3');
    expect(state.item?.subtitle).toBe('');
    expect(state.item?.images).toEqual([]);
    expect(state.item?.uri).toBe('spotify:local:::unmastered_mix_v3:205');
  });

  // TVs, receivers and cast targets report no volume. Defaulting to 0 would
  // draw a muted slider for a device playing loudly.
  it('models an unreported volume as null, not zero', () => {
    const state = parseOrThrow({
      ...trackPayload,
      device: {
        ...speaker,
        name: 'Living Room TV',
        type: 'TV',
        volume_percent: null,
        supports_volume: false,
      },
    });
    expect(state.device?.volumePercent).toBeNull();
    expect(state.device?.supportsVolume).toBe(false);
  });

  // Older Connect clients predate `supports_volume`; a reported volume is the
  // only evidence available.
  it('infers volume support from a reported volume when the flag is absent', () => {
    const older = {
      id: '0000000000000000000000000000000000000003',
      is_active: true,
      is_restricted: false,
      name: 'Study',
      type: 'Computer',
      volume_percent: 30,
    };
    const withVolume = parseOrThrow({ ...trackPayload, device: older });
    expect(withVolume.device?.supportsVolume).toBe(true);

    const withoutVolume = parseOrThrow({
      ...trackPayload,
      device: { ...older, volume_percent: null },
    });
    expect(withoutVolume.device?.supportsVolume).toBe(false);
  });

  it('tolerates a restricted device with no id or name', () => {
    const state = parseOrThrow({
      ...trackPayload,
      device: { id: null, is_active: true, is_restricted: true, volume_percent: 40 },
    });
    expect(state.device?.id).toBeNull();
    expect(state.device?.name).toBe('Unknown device');
    expect(state.device?.type).toBe('Unknown');
  });

  it('drops artwork entries that are unusable and keeps sizeless ones', () => {
    const state = parseOrThrow({
      ...trackPayload,
      item: {
        ...trackPayload.item,
        album: {
          ...trackPayload.item.album,
          images: [
            { url: 'https://i.scdn.co/image/mosaic', height: null, width: null },
            { url: '', height: 64, width: 64 },
            'not-an-image',
            { height: 300, width: 300 },
          ],
        },
      },
    });
    expect(state.item?.images).toEqual([
      { url: 'https://i.scdn.co/image/mosaic', width: null, height: null },
    ]);
  });

  it('falls back to off for a repeat mode it does not know', () => {
    expect(parseOrThrow({ ...trackPayload, repeat_state: 'sometimes' }).repeat).toBe(
      'off',
    );
    expect(parseOrThrow({ ...trackPayload, repeat_state: undefined }).repeat).toBe('off');
    expect(parseOrThrow({ ...trackPayload, shuffle_state: null }).shuffle).toBe(false);
  });

  it('clamps a negative or nonsense progress to zero', () => {
    expect(parseOrThrow({ ...trackPayload, progress_ms: -1 }).progressMs).toBe(0);
    expect(parseOrThrow({ ...trackPayload, progress_ms: 'soon' }).progressMs).toBe(0);
    expect(
      parseOrThrow({
        ...trackPayload,
        item: { ...trackPayload.item, duration_ms: null },
      }).item?.durationMs,
    ).toBe(0);
  });

  describe('rejects what it cannot recognise', () => {
    const expectUnexpected = (body: unknown, matching: RegExp): void => {
      const result = normalisePlaybackState(body);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unexpected');
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toMatch(matching);
    };

    it('errors on a body that is not an object', () => {
      expectUnexpected('OK', /not an object/);
      expectUnexpected(42, /not an object/);
    });

    // An error body or an unrelated endpoint's payload reaching here is a bug
    // worth surfacing, not something to guess a playback state from.
    it('errors on an object that is not a player payload', () => {
      expectUnexpected({}, /is_playing/);
      expectUnexpected([trackPayload], /is_playing/);
      expectUnexpected({ error: { status: 502, message: 'Bad gateway' } }, /is_playing/);
    });

    it('errors on an item that is not an object or has no name', () => {
      expectUnexpected({ ...trackPayload, item: 'Around the World' }, /item/);
      expectUnexpected(
        { ...trackPayload, item: { ...trackPayload.item, name: null } },
        /no name/,
      );
    });

    it('errors on a device that is not an object', () => {
      expectUnexpected({ ...trackPayload, device: 'Kitchen' }, /device/);
    });
  });
});

describe('selectArtwork', () => {
  // The theme extractor fetches the 64px variant: cheap over the Pi's network
  // and enough pixels for an average colour.
  it('picks the smallest image that still meets the requested width', () => {
    const state = parseOrThrow(trackPayload);
    const images = state.item?.images ?? [];
    expect(selectArtwork(images, 64)?.width).toBe(64);
    expect(selectArtwork(images, 200)?.width).toBe(300);
    expect(selectArtwork(images, 640)?.width).toBe(640);
  });

  it('falls back to the largest available when nothing is big enough', () => {
    const state = parseOrThrow(trackPayload);
    expect(selectArtwork(state.item?.images ?? [], 2_000)?.width).toBe(640);
  });

  it('returns null when there is no artwork at all', () => {
    expect(selectArtwork([], 64)).toBeNull();
  });

  it('accepts a sizeless image only as a last resort', () => {
    const mosaic = { url: 'https://i.scdn.co/image/mosaic', width: null, height: null };
    expect(selectArtwork([mosaic], 64)).toBe(mosaic);
  });
});
