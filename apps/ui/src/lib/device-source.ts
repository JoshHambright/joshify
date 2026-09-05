/**
 * Where the Devices screen gets its list.
 *
 * Separate from the playback socket on purpose. The device list is not
 * playback truth — it changes when someone else's phone joins the network, not
 * when a track ends — and pushing it down the same channel would make every
 * poll of one a diff of the other.
 *
 * It is also only interesting while the screen is open. A wall panel showing
 * Now Playing has no use for a fresh device list, and polling one for hours
 * spends the request budget the transport commands need (D-025). So this polls
 * only between `open()` and `close()`.
 */
import type { PlaybackDevice, JoshifyError } from '@joshify/core';

export interface DeviceSourceState {
  readonly devices: readonly PlaybackDevice[];
  /** The last failure, or null. The screen keeps its rows either way. */
  readonly problem: JoshifyError | null;
  /** True until the first answer, so the screen can say "looking" once. */
  readonly pending: boolean;
}

export type FetchLike = (
  input: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type CancelScheduled = () => void;
export type Scheduler = (delayMs: number, run: () => void) => CancelScheduled;

const realScheduler: Scheduler = (delayMs, run) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Slow, because the list barely changes and the screen is open for seconds.
 * A speaker that appears five seconds after someone plugs it in is fine; a
 * request every second for a list of three rows is not.
 */
export const DEVICE_POLL_MS = 5_000;

export interface DeviceSourceConfig {
  readonly fetch: FetchLike;
  readonly baseUrl?: string | undefined;
  readonly scheduler?: Scheduler | undefined;
  readonly pollMs?: number | undefined;
}

export interface DeviceSource {
  readonly subscribe: (run: (value: DeviceSourceState) => void) => () => void;
  readonly open: () => void;
  readonly close: () => void;
  /** Fetch once, now — after a transfer, so the lamp moves without waiting. */
  readonly refresh: () => Promise<void>;
  readonly current: () => DeviceSourceState;
}

/**
 * Read a `{ devices: [...] }` body.
 *
 * Only the envelope is checked. The rows were built by `normaliseDeviceList`
 * on the server from a payload it already validated, and re-validating them
 * here would mean two definitions of a valid device that can drift apart —
 * the same reasoning the wire protocol applies to a snapshot's state.
 */
const readDevices = (body: unknown): readonly PlaybackDevice[] | null => {
  if (typeof body !== 'object' || body === null) return null;
  const rows = (body as { devices?: unknown }).devices;
  return Array.isArray(rows) ? (rows as readonly PlaybackDevice[]) : null;
};

const readProblem = (status: number, body: unknown): JoshifyError => {
  const envelope =
    typeof body === 'object' && body !== null
      ? (body as { error?: { kind?: unknown; message?: unknown } }).error
      : undefined;
  return {
    kind:
      typeof envelope?.kind === 'string'
        ? (envelope.kind as JoshifyError['kind'])
        : 'unexpected',
    message:
      typeof envelope?.message === 'string'
        ? envelope.message
        : `the server answered ${String(status)}`,
    retryable: true,
  };
};

export const createDeviceSource = (config: DeviceSourceConfig): DeviceSource => {
  const schedule = config.scheduler ?? realScheduler;
  const pollMs = config.pollMs ?? DEVICE_POLL_MS;
  const base = config.baseUrl ?? '';
  const subscribers = new Set<(value: DeviceSourceState) => void>();

  let value: DeviceSourceState = { devices: [], problem: null, pending: true };
  let open = false;
  let cancelNext: CancelScheduled | null = null;

  const publish = (next: DeviceSourceState): void => {
    value = next;
    for (const run of subscribers) run(value);
  };

  const load = async (): Promise<void> => {
    try {
      const response = await config.fetch(`${base}/api/devices`);
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        // Keep the rows we have. A failed refresh is not a reason to empty a
        // list someone is looking at.
        publish({
          ...value,
          problem: readProblem(response.status, body),
          pending: false,
        });
        return;
      }
      const devices = readDevices(body);
      if (devices === null) {
        publish({
          ...value,
          problem: readProblem(response.status, body),
          pending: false,
        });
        return;
      }
      publish({ devices, problem: null, pending: false });
    } catch {
      publish({
        ...value,
        problem: {
          kind: 'network',
          message: 'the panel could not reach the Joshify server',
          retryable: true,
        },
        pending: false,
      });
    }
  };

  const armNext = (): void => {
    if (!open) return;
    cancelNext?.();
    cancelNext = schedule(pollMs, () => {
      void cycle();
    });
  };

  const cycle = async (): Promise<void> => {
    await load();
    armNext();
  };

  return {
    subscribe: (run) => {
      subscribers.add(run);
      run(value);
      return () => {
        subscribers.delete(run);
      };
    },
    open: () => {
      if (open) return;
      open = true;
      void cycle();
    },
    close: () => {
      open = false;
      cancelNext?.();
      cancelNext = null;
    },
    refresh: load,
    current: () => value,
  };
};
