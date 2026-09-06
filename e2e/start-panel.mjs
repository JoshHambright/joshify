/**
 * Boots the whole panel for the end-to-end suite: a real `joshify serve`, the
 * real built UI, and the fake Spotify behind it.
 *
 * Runs against `dist/` rather than source on purpose. Every other suite in this
 * repo tests one seam with the rest faked, which is what makes them fast — and
 * also what makes it possible for all of them to pass while the shipped
 * artefact is broken. The bug that prompted this file was exactly that: the
 * server had no route at `/`, so the panel loaded from nowhere, and 1,183
 * passing tests said nothing about it.
 *
 * Plain `.mjs` because Playwright starts it as a process, and adding a TS
 * loader to do it would put a second build path between the test and the thing
 * being tested.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { startFakeSpotify } = await import('../apps/server/dist/testing/fake-spotify.js');
const { createTokenStore } = await import('../apps/server/dist/auth/token-store.js');
const { serve } = await import('../apps/server/dist/cli/serve.js');

const PORT = Number(process.env.JOSHIFY_E2E_PORT ?? 4771);

/** One track, one queue, three devices — enough to exercise every surface. */
const TRACK = {
  type: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  name: 'Velocity Division',
  duration_ms: 211_000,
  artists: [{ name: 'Nitrous Cartel' }],
  album: { name: 'Velocity Division', images: [] },
};

const spotify = await startFakeSpotify();
spotify.playbackState = {
  is_playing: true,
  progress_ms: 64_000,
  shuffle_state: false,
  repeat_state: 'off',
  device: {
    id: 'dev-1',
    name: 'Kitchen',
    type: 'Speaker',
    is_active: true,
    volume_percent: 55,
  },
  item: TRACK,
};
spotify.devices = {
  devices: [
    {
      id: 'dev-1',
      name: 'Kitchen',
      type: 'Speaker',
      is_active: true,
      volume_percent: 55,
    },
    {
      id: 'dev-2',
      name: 'Study',
      type: 'Computer',
      is_active: false,
      volume_percent: 40,
    },
    // Reports no volume: the row must show no slider at all (D-022, D-047).
    {
      id: 'dev-3',
      name: 'Living Room TV',
      type: 'TV',
      is_active: false,
      supports_volume: false,
    },
  ],
};
spotify.queue = {
  currently_playing: TRACK,
  queue: [{ ...TRACK, id: 'track-2', name: 'Coolant' }],
};

const dataDir = await mkdtemp(join(tmpdir(), 'joshify-e2e-'));
const store = createTokenStore({ dataDir });
await store.save({
  accessToken: spotify.validAccessToken,
  refreshToken: 'refresh-seed',
  expiresAt: Date.now() + 3_600_000,
  refreshAt: Date.now() + 2_880_000,
  scopes: ['user-read-playback-state'],
});

const running = await serve({
  dataDir,
  clientId: 'e2e-client-id',
  port: PORT,
  uiDir: fileURLToPath(new URL('../apps/ui/dist-web', import.meta.url)),
  spotify: { baseUrl: spotify.origin, tokenEndpoint: spotify.tokenEndpoint },
  onProblem: (problem) => {
    process.stderr.write(`[${problem.kind}] ${problem.message}\n`);
  },
});

if (!running.ok) {
  process.stderr.write(`could not start: ${running.error.message}\n`);
  process.exit(1);
}
if (running.value.uiDir === null) {
  process.stderr.write('no built UI — run `pnpm build` before the e2e suite\n');
  process.exit(1);
}

process.stdout.write(`panel ready on ${running.value.server.origin}\n`);

const shutdown = () => {
  void running.value
    .stop()
    .then(() => spotify.close())
    .then(() => rm(dataDir, { recursive: true, force: true }))
    .then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
