/**
 * A hand-controlled stand-in for the Spotify client, plus a hand-controlled
 * clock for the search debounce.
 *
 * The shared fake in `../../testing/fake-spotify.ts` is a real HTTP server, and
 * that is the right tool for the transport layer. It is the wrong tool here:
 * the behaviour these modules have to prove is that a *slow* response cannot
 * beat a fast one, which means the test has to decide the order two in-flight
 * requests come back in. Over a socket that is a race with a sleep in it; here
 * it is two function calls in the order the test writes them.
 *
 * `Pick<SpotifyClient, 'request'>` is the same narrow seam the player commands
 * take, so nothing under test can tell the difference.
 */
import type { JoshifyError, Result } from '@joshify/core';
import { err, ok } from '@joshify/core';
import type { ScheduleDelay } from '../search.js';

/** A request that has been made and is waiting for the test to answer it. */
export interface PendingRequest {
  readonly path: string;
  readonly succeed: (body: unknown) => void;
  readonly fail: (error: JoshifyError) => void;
}

export interface FakeSpotifyClient {
  readonly request: (
    path: string,
    init?: RequestInit,
  ) => Promise<Result<unknown, JoshifyError>>;
  /** Every path requested, in order, so a test can assert the query string. */
  readonly paths: readonly string[];
  /** Requests still unanswered, oldest first. */
  readonly pending: readonly PendingRequest[];
  /** Answer the next request the moment it is made. */
  readonly queue: (body: unknown) => void;
  readonly queueFailure: (error: JoshifyError) => void;
  /** Answer the oldest unanswered request whose path contains `match`. */
  readonly settle: (match: string, body: unknown) => void;
  readonly settleFailure: (match: string, error: JoshifyError) => void;
}

type Answer = Result<unknown, JoshifyError>;

export const createFakeClient = (): FakeSpotifyClient => {
  const paths: string[] = [];
  const pending: PendingRequest[] = [];
  const queued: Answer[] = [];

  const take = (match: string): ((answer: Answer) => void) => {
    const index = pending.findIndex((entry) => entry.path.includes(match));
    // Loud, because a test that answers a request nobody made is asserting
    // nothing at all.
    if (index === -1) {
      throw new Error(
        `no pending request matching ${match}; saw: ${paths.join(', ') || '(none)'}`,
      );
    }
    const [entry] = pending.splice(index, 1);
    if (entry === undefined) throw new Error('unreachable: findIndex found nothing');
    return (answer) => {
      if (answer.ok) entry.succeed(answer.value);
      else entry.fail(answer.error);
    };
  };

  return {
    paths,
    pending,
    queue: (body) => queued.push(ok(body)),
    queueFailure: (error) => queued.push(err(error)),
    settle: (match, body) => {
      take(match)(ok(body));
    },
    settleFailure: (match, error) => {
      take(match)(err(error));
    },
    request: (path) => {
      paths.push(path);
      const ready = queued.shift();
      if (ready !== undefined) return Promise.resolve(ready);

      return new Promise<Result<unknown, JoshifyError>>((resolve) => {
        pending.push({
          path,
          succeed: (body) => {
            resolve(ok(body));
          },
          fail: (error) => {
            resolve(err(error));
          },
        });
      });
    },
  };
};

export interface ManualScheduler {
  readonly schedule: ScheduleDelay;
  /** Every delay asked for, in order. */
  readonly delays: readonly number[];
  /** Timers still waiting; a cancelled one is gone. */
  readonly pendingCount: () => number;
  /** Fire every waiting timer, oldest first. */
  readonly runAll: () => void;
}

export const createManualScheduler = (): ManualScheduler => {
  const delays: number[] = [];
  let timers: (() => void)[] = [];

  return {
    delays,
    pendingCount: () => timers.length,
    runAll: () => {
      const due = timers;
      timers = [];
      for (const run of due) run();
    },
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      timers.push(run);
      return () => {
        timers = timers.filter((entry) => entry !== run);
      };
    },
  };
};

/**
 * Let queued microtasks drain. A real zero-delay timer, not `Promise.resolve()`
 * chains: it clears the whole microtask queue however many `await`s deep the
 * code under test happens to be, so a test never depends on counting them.
 */
export const settleMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
