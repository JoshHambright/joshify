/**
 * Where the Queue screen gets its list.
 *
 * Deliberately the same shape as `device-source.ts`, for the same reasons
 * (D-049): the queue is not playback truth, it is a second read that only
 * matters while somebody is looking at it, and one pattern for "a screen that
 * polls a list" is worth more than two clever ones. So: injected `fetch` and
 * scheduler, polling only between `open()` and `close()`, a failed refresh
 * keeps the rows it has, and a body we cannot read is a problem rather than an
 * empty queue.
 *
 * **Why not on the playback socket.** The queue would have to be diffed on
 * every poll of the player for a list nobody has open, and it is a separate
 * Spotify request either way — pushing it down the same channel would spend the
 * budget the transport commands need (D-025) to keep a screen fresh that is not
 * on screen.
 *
 * **Why a track change does not need a faster poll.** It needs a `refresh()`,
 * which the panel already knows to call the moment the socket reports a new
 * item — the same trick a transfer uses to move the device lamp without waiting
 * out an interval.
 */
import { EMPTY_QUEUE } from '@joshify/core';
import type { JoshifyError, PlaybackQueue, PlayingItem } from '@joshify/core';

export interface QueueSourceState {
  readonly queue: PlaybackQueue;
  /** The last failure, or null. The screen keeps its rows either way. */
  readonly problem: JoshifyError | null;
  /** True until the first answer, so the screen can say "reading" once. */
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
 * Slow, because the queue changes when a track ends or somebody adds one, and
 * both of those have a better signal than a poll — the socket reports the first
 * and the panel makes the second. Five seconds is the ceiling on how stale the
 * list can be while a finger is on the screen, not how it normally keeps up.
 */
export const QUEUE_POLL_MS = 5_000;

export interface QueueSourceConfig {
  readonly fetch: FetchLike;
  readonly baseUrl?: string | undefined;
  readonly scheduler?: Scheduler | undefined;
  readonly pollMs?: number | undefined;
}

export interface QueueSource {
  readonly subscribe: (run: (value: QueueSourceState) => void) => () => void;
  readonly open: () => void;
  readonly close: () => void;
  /** Fetch once, now — after a track change, so the top row moves with it. */
  readonly refresh: () => Promise<void>;
  readonly current: () => QueueSourceState;
}

/**
 * Read a `{ current, upcoming }` body.
 *
 * Only the envelope is checked. The rows were built by `normaliseQueue` on the
 * server from a payload it already validated, and re-validating them here would
 * mean two definitions of a valid queue item that can drift apart — the same
 * reasoning the device list and the wire protocol both apply.
 *
 * `current: null` is an ordinary state (nothing is playing). A `current` that
 * is neither null nor an object, or a missing `upcoming` array, is a body we do
 * not understand, and pretending it means "the queue is empty" would put a
 * confident lie on the screen.
 */
const readQueue = (body: unknown): PlaybackQueue | null => {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { current?: unknown; upcoming?: unknown };
  if (!Array.isArray(envelope.upcoming)) return null;
  if (envelope.current !== null && typeof envelope.current !== 'object') return null;
  return {
    current: envelope.current as PlayingItem | null,
    upcoming: envelope.upcoming as readonly PlayingItem[],
  };
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

export const createQueueSource = (config: QueueSourceConfig): QueueSource => {
  const schedule = config.scheduler ?? realScheduler;
  const pollMs = config.pollMs ?? QUEUE_POLL_MS;
  const base = config.baseUrl ?? '';
  const subscribers = new Set<(value: QueueSourceState) => void>();

  let value: QueueSourceState = { queue: EMPTY_QUEUE, problem: null, pending: true };
  let open = false;
  let cancelNext: CancelScheduled | null = null;

  const publish = (next: QueueSourceState): void => {
    value = next;
    for (const run of subscribers) run(value);
  };

  const load = async (): Promise<void> => {
    try {
      const response = await config.fetch(`${base}/api/queue`);
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
      const queue = readQueue(body);
      if (queue === null) {
        publish({
          ...value,
          problem: readProblem(response.status, body),
          pending: false,
        });
        return;
      }
      publish({ queue, problem: null, pending: false });
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
