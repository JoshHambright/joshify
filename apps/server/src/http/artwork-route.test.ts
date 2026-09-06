/**
 * Serving the device's own artwork cache (P3-05).
 *
 * The path-traversal tests are the reason this file exists. Everything else
 * here is a content type and a cache header; the key validation is the only
 * thing standing between a URL segment and the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err, ok, type JoshifyError, type Result } from '@joshify/core';
import { createSpotifyClient } from '../spotify/client.js';
import { createSpotifyCommands } from '../spotify/commands.js';
import { startFakeSpotify, type FakeSpotify } from '../testing/fake-spotify.js';
import { createBroadcaster, type Broadcaster } from './broadcast.js';
import {
  isArtworkKey,
  isDerivedKind,
  sniffImageType,
  startHttpServer,
  type ArtworkSource,
  type RunningServer,
} from './server.js';

const KEY = 'a'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

let spotify: FakeSpotify;
let broadcaster: Broadcaster;
const running: RunningServer[] = [];

/** Records every key the route asks for, so a traversal that got through shows. */
const recordingSource = (
  answer: Result<Buffer | null, JoshifyError> = ok(JPEG),
): { source: ArtworkSource; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    source: {
      read: (key) => {
        asked.push(key);
        return Promise.resolve(answer);
      },
      readDerived: (key, kind) => {
        asked.push(`${key}/${kind}`);
        return Promise.resolve(answer);
      },
    },
  };
};

const start = async (source: ArtworkSource): Promise<RunningServer> => {
  const client = createSpotifyClient({
    tokenSource: {
      getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
      refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
    },
    baseUrl: spotify.origin,
    sleep: () => Promise.resolve(),
  });
  const server = await startHttpServer({
    broadcaster,
    commands: createSpotifyCommands(client),
    port: 0,
    artwork: source,
  });
  running.push(server);
  return server;
};

beforeEach(async () => {
  spotify = await startFakeSpotify();
  broadcaster = createBroadcaster();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await spotify.close();
});

describe('serving a cached image', () => {
  it('answers the bytes with the type sniffed from them', async () => {
    const { source } = recordingSource();
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
  });

  // Content-addressed, so the bytes behind a key can never change. This is
  // what stops the panel re-fetching the same album on every render.
  it('marks it immutable, because the key is the content', async () => {
    const { source } = recordingSource();
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}`);

    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('cache-control')).toContain('max-age=31536000');
  });

  it('serves a derived image under its kind', async () => {
    const { source, asked } = recordingSource();
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}/backdrop`);

    expect(response.status).toBe(200);
    expect(asked).toEqual([`${KEY}/backdrop`]);
  });

  // The panel asked for art the cache has since evicted. Its own fallback is a
  // flat surface, so this is a 404 rather than a fault.
  it('answers 404 for a key the cache no longer holds', async () => {
    const { source } = recordingSource(ok(null));
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}`);

    expect(response.status).toBe(404);
  });

  it('reports a read failure as a failure rather than as a miss', async () => {
    const { source } = recordingSource(
      err({ kind: 'unexpected', message: 'disk fell over', retryable: false }),
    );
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}`);

    expect(response.status).toBe(400);
  });

  it('is not registered at all without an artwork source', async () => {
    const client = createSpotifyClient({
      tokenSource: {
        getAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
        refreshAccessToken: () => Promise.resolve(ok(spotify.validAccessToken)),
      },
      baseUrl: spotify.origin,
      sleep: () => Promise.resolve(),
    });
    const server = await startHttpServer({
      broadcaster,
      commands: createSpotifyCommands(client),
      port: 0,
    });
    running.push(server);

    expect((await fetch(`${server.origin}/api/artwork/${KEY}`)).status).toBe(404);
  });
});

/**
 * The whole point of the key pattern. Percent-encoded segments arrive here
 * already decoded, so a check for the literal `..` would be both too late and
 * too narrow — an allowlist of hex cannot express a traversal at all.
 */
describe('a key that is not a key', () => {
  it.each([
    ['traversal', '../../../etc/passwd'],
    ['encoded traversal', '..%2f..%2f..%2fetc%2fpasswd'],
    ['double-encoded traversal', '..%252f..%252fetc%252fpasswd'],
    ['an absolute path', '%2fetc%2fpasswd'],
    ['a null byte', `${'a'.repeat(31)}%00`],
    ['uppercase hex', 'A'.repeat(32)],
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(33)],
    ['not hex', 'z'.repeat(32)],
  ])('refuses %s, and never reaches the cache', async (_label, key) => {
    const { source, asked } = recordingSource();
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${key}`);

    expect(response.status).not.toBe(200);
    expect(asked).toEqual([]);
  });

  it.each([
    ['traversal', '..%2f..%2fetc'],
    ['a dot', '.'],
    ['digits', 'backdrop2'],
    ['empty-ish', '%20'],
  ])('refuses the derived kind %s', async (_label, kind) => {
    const { source, asked } = recordingSource();
    const server = await start(source);

    const response = await fetch(`${server.origin}/api/artwork/${KEY}/${kind}`);

    expect(response.status).not.toBe(200);
    expect(asked).toEqual([]);
  });
});

describe('the validators', () => {
  it('accepts exactly what keyFor produces', () => {
    expect(isArtworkKey('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isArtworkKey('0123456789abcdef0123456789abcde')).toBe(false);
    // Anchored: a valid key with anything appended is not a key.
    expect(isArtworkKey(`${'a'.repeat(32)}/../x`)).toBe(false);
    expect(isArtworkKey(`${'a'.repeat(32)}\n`)).toBe(false);
  });

  it('accepts a derived kind and nothing that could be a path', () => {
    expect(isDerivedKind('backdrop')).toBe(true);
    expect(isDerivedKind('back/drop')).toBe(false);
    expect(isDerivedKind('')).toBe(false);
    expect(isDerivedKind('a'.repeat(33))).toBe(false);
  });
});

describe('sniffing an image type', () => {
  it.each([
    ['jpeg', JPEG, 'image/jpeg'],
    ['png', PNG, 'image/png'],
    [
      'webp',
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
      'image/webp',
    ],
    ['gif', Buffer.from('GIF89a...'), 'image/gif'],
  ])('recognises %s', (_label, bytes, expected) => {
    expect(sniffImageType(bytes)).toBe(expected);
  });

  // A mislabelled image renders as nothing; an honest download is at least
  // diagnosable.
  it.each([
    ['something else', Buffer.from('not an image at all')],
    ['an empty buffer', Buffer.alloc(0)],
    ['a truncated header', Buffer.from([0xff, 0xd8])],
  ])('refuses to guess at %s', (_label, bytes) => {
    expect(sniffImageType(bytes)).toBe('application/octet-stream');
  });
});
