/**
 * `joshify serve` — the composition root.
 *
 * Every other module in this package refuses to construct its own
 * dependencies, which is what makes them testable. The consequence is that
 * *something* has to know how they fit together, and this is that something.
 * It is deliberately the only file in the server that reads the environment,
 * touches the real filesystem, and opens a socket.
 *
 * Read top to bottom it is the whole architecture in about a hundred lines:
 * disk → tokens → Spotify → engine → broadcaster → HTTP.
 */
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createError,
  err,
  ok,
  systemClock,
  type JoshifyError,
  type Result,
} from '@joshify/core';
import { createTokenStore } from '../auth/token-store.js';
import { createTokenSource } from '../auth/token-source.js';
import { createSpotifyClient } from '../spotify/client.js';
import { createSpotifyCommands } from '../spotify/commands.js';
import { createArtworkCache, SOURCE_KIND } from '../artwork/cache.js';
import { createLibraryBrowser } from '../library/browse.js';
import { createSearchSession } from '../library/search.js';
import { createBroadcaster } from '../http/broadcast.js';
import { startHttpServer, type PanelReads, type RunningServer } from '../http/server.js';
import { createPlaybackEngine } from '../engine/playback-engine.js';
import { createArtworkPresenter } from '../engine/artwork-presenter.js';
import { createProblemReporter } from '../observability/problem-reporter.js';
import { normaliseDeviceList, normaliseQueue } from '@joshify/core';

export const DEFAULT_SERVE_PORT = 4770;

export interface ServeOptions {
  readonly dataDir: string;
  readonly clientId: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /**
   * ISO country code. Without it Spotify lists tracks that are not licensed
   * where the device is, and tapping one fails at play time rather than simply
   * not being offered.
   */
  readonly market?: string | undefined;
  /** Every problem the running device hits. The CLI prints these to journald. */
  readonly onProblem?: ((error: JoshifyError) => void) | undefined;
  /**
   * Where Spotify is.
   *
   * The one seam in this file, and it exists for one reason: without it the
   * only test that proves the whole thing fits together would have to talk to
   * the real Spotify. Production never sets it. Every other module here takes
   * the same override for the same reason.
   */
  /**
   * Where the built UI is. Defaults to the bundle this package ships beside
   * itself, so a systemd unit does not have to know the layout.
   */
  readonly uiDir?: string | undefined;
  readonly spotify?:
    | {
        readonly baseUrl?: string | undefined;
        readonly tokenEndpoint?: string | undefined;
      }
    | undefined;
}

export interface RunningJoshify {
  readonly server: RunningServer;
  /** Null when no built UI was found; the API still serves without one. */
  readonly uiDir: string | null;
  readonly stop: () => Promise<void>;
}

/**
 * The built panel, if it is there.
 *
 * Looked up rather than assumed because the layout differs between a checkout
 * (`apps/ui/dist-web`) and an installed tree, and a unit file should not have
 * to know which it is looking at.
 */
const resolveUiDir = async (configured: string | undefined): Promise<string | null> => {
  const candidates =
    configured === undefined
      ? [
          // Installed beside the server's own build output.
          fileURLToPath(new URL('../../ui', import.meta.url)),
          // A workspace checkout.
          fileURLToPath(new URL('../../../ui/dist-web', import.meta.url)),
        ]
      : [configured];
  for (const candidate of candidates) {
    try {
      const entry = await stat(join(candidate, 'index.html'));
      if (entry.isFile()) return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
};

export const serve = async (
  options: ServeOptions,
): Promise<Result<RunningJoshify, JoshifyError>> => {
  const cacheDir = join(options.dataDir, 'artwork');
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch (cause) {
    return err(createError('unexpected', `could not create ${cacheDir}`, { cause }));
  }

  const store = createTokenStore({ dataDir: options.dataDir });
  // Refuse to start rather than come up and fail every request: a systemd unit
  // that exits is visible in `systemctl status`, while one that runs and
  // serves 401s looks healthy from the outside.
  const stored = await store.load();
  if (!stored.ok) return stored;
  if (stored.value === null) {
    return err(
      createError('auth', 'no Spotify account is connected — run `joshify auth`'),
    );
  }

  const tokenSource = createTokenSource({
    store,
    clientId: options.clientId,
    ...(options.spotify?.tokenEndpoint === undefined
      ? {}
      : { tokenEndpoint: options.spotify.tokenEndpoint }),
    ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
  });
  const client = createSpotifyClient({
    tokenSource,
    ...(options.spotify?.baseUrl === undefined
      ? {}
      : { baseUrl: options.spotify.baseUrl }),
  });
  const commands = createSpotifyCommands(client);

  const cache = createArtworkCache({ cacheDir });
  const presenter = createArtworkPresenter({ cache });

  const browserOptions = options.market === undefined ? {} : { market: options.market };
  const browser = createLibraryBrowser(client, browserOptions);
  // One session for the life of the process, which is what carries D-032's
  // generation fence across HTTP: a request overtaken by the next keystroke
  // resolves as `superseded` rather than as a stale answer.
  const searchSession = createSearchSession({ client, ...browserOptions });

  const reads: PanelReads = {
    devices: async () => {
      const raw = await client.getDevices();
      return raw.ok ? normaliseDeviceList(raw.value) : raw;
    },
    queue: async () => {
      const raw = await client.getQueue();
      return raw.ok ? normaliseQueue(raw.value) : raw;
    },
    search: (query) => searchSession.search(query),
    savedAlbums: (page) => browser.savedAlbums(page),
    playlists: (page) => browser.playlists(page),
    playlistTracks: (id, page) => browser.playlistTracks(id, page),
  };

  // Absent in a checkout that has not built the UI, and in the API-only
  // tests. Missing is a state, not a failure: the API still serves, and
  // `joshify serve` says so rather than refusing to start.
  const uiDir = await resolveUiDir(options.uiDir);

  const broadcaster = createBroadcaster();
  // A poll every couple of seconds, for weeks, on an SD card with a finite
  // number of writes in it. A run of the same failure is reported once and
  // then counted, and recovery says how long it lasted (D-060).
  const reporter = createProblemReporter({
    now: () => Date.now(),
    emit: (report) => {
      options.onProblem?.({
        kind: report.error?.kind ?? 'unexpected',
        message: report.message,
        retryable: report.error?.retryable ?? false,
      });
    },
  });

  const engine = createPlaybackEngine({
    client,
    commands,
    broadcaster,
    clock: systemClock,
    presenter,
    readProfile: async () => {
      const profile = await client.getProfile();
      return profile.ok ? ok({ isPremium: profile.value.isPremium }) : profile;
    },
    onProblem: reporter.problem,
    onRecovered: reporter.recovered,
  });

  const server = await startHttpServer({
    broadcaster,
    // `engine.commands`, not the raw `commands`. Both compile and both serve;
    // the raw ones quietly skip the optimistic layer, so every tap would wait
    // a full poll to show any effect (D-028).
    commands: engine.commands,
    reads,
    artwork: {
      // The source image is stored under its own kind, so both reads go
      // through the same gate — the route's key check is the outer one, and
      // the cache's `kind` check is the inner.
      read: (key) => cache.readDerived(key, SOURCE_KIND),
      readDerived: (key, kind) => cache.readDerived(key, kind),
    },
    ...(uiDir === null ? {} : { uiDir }),
    ...(options.host === undefined ? {} : { host: options.host }),
    port: options.port ?? DEFAULT_SERVE_PORT,
  });

  engine.start();

  return ok({
    uiDir,
    server,
    stop: async () => {
      engine.stop();
      await server.close();
    },
  });
};
