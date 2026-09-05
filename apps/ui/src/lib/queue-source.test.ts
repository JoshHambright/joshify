import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayingItem } from '@joshify/core';
import {
  createQueueSource,
  QUEUE_POLL_MS,
  type FetchLike,
  type QueueSourceState,
  type Scheduler,
} from './queue-source.js';

const xtal: PlayingItem = {
  kind: 'track',
  id: 'track-1',
  uri: 'spotify:track:track-1',
  title: 'Xtal',
  subtitle: 'Aphex Twin',
  durationMs: 293_000,
  images: [],
  isLocal: false,
};

const tha: PlayingItem = { ...xtal, id: 'track-2', title: 'Tha' };

type Answer = { ok: boolean; status: number; body?: unknown } | 'throws';

const fakeFetch = () => {
  const urls: string[] = [];
  let answers: Answer[] = [
    { ok: true, status: 200, body: { current: xtal, upcoming: [tha] } },
  ];
  let index = 0;
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const answer = answers[Math.min(index, answers.length - 1)] ?? answers[0];
    index += 1;
    if (answer === 'throws' || answer === undefined) {
      return Promise.reject(new Error('loopback refused'));
    }
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () =>
        answer.body === undefined
          ? Promise.reject(new Error('no body'))
          : Promise.resolve(answer.body),
    });
  };
  return {
    fetch,
    urls,
    answerWith: (...next: Answer[]) => {
      answers = next;
      index = 0;
    },
  };
};

const manualScheduler = () => {
  let pending: { delay: number; run: () => void } | null = null;
  const scheduler: Scheduler = (delay, run) => {
    pending = { delay, run };
    return () => {
      pending = null;
    };
  };
  return {
    scheduler,
    delay: () => pending?.delay ?? null,
    fire: () => {
      const p = pending;
      pending = null;
      p?.run();
    },
  };
};

let net: ReturnType<typeof fakeFetch>;
let sched: ReturnType<typeof manualScheduler>;

const build = () => createQueueSource({ fetch: net.fetch, scheduler: sched.scheduler });

/** Let the in-flight promise chain settle; nothing here waits on a real timer. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  net = fakeFetch();
  sched = manualScheduler();
});

describe('the queue source', () => {
  it('gives a subscriber the current value immediately', () => {
    const seen: QueueSourceState[] = [];
    build().subscribe((v) => seen.push(v));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.pending).toBe(true);
    expect(seen[0]?.queue.upcoming).toEqual([]);
  });

  it('fetches the queue on open and publishes it', async () => {
    const source = build();
    source.open();
    await settle();

    expect(net.urls).toEqual(['/api/queue']);
    expect(source.current().queue.current?.title).toBe('Xtal');
    expect(source.current().queue.upcoming).toEqual([tha]);
    expect(source.current().pending).toBe(false);
    source.close();
  });

  // The panel sits on Now Playing for hours. A fresh queue is worth nothing
  // there, and the requests come out of the budget the transport needs (D-025).
  it('polls only between open and close', async () => {
    const source = build();
    source.open();
    await settle();
    expect(sched.delay()).toBe(QUEUE_POLL_MS);

    source.close();
    expect(sched.delay()).toBeNull();

    sched.fire();
    await settle();
    expect(net.urls).toHaveLength(1);
  });

  it('keeps polling while it stays open', async () => {
    const source = build();
    source.open();
    await settle();
    sched.fire();
    await settle();

    expect(net.urls).toHaveLength(2);
    expect(sched.delay()).toBe(QUEUE_POLL_MS);
    source.close();
  });

  it('ignores a second open rather than running two loops', async () => {
    const source = build();
    source.open();
    source.open();
    await settle();

    expect(net.urls).toHaveLength(1);
    source.close();
  });

  // A track change moves the top row, and the socket knows about it long
  // before the next poll would.
  it('refreshes once on demand', async () => {
    const source = build();
    await source.refresh();
    await settle();

    expect(net.urls).toHaveLength(1);
    expect(source.current().queue.upcoming).toEqual([tha]);
    // A bare refresh arms nothing: it is not a subscription.
    expect(sched.delay()).toBeNull();
  });

  it('reads a queue with nothing playing as an ordinary empty queue', async () => {
    net.answerWith({ ok: true, status: 200, body: { current: null, upcoming: [] } });
    const source = build();
    source.open();
    await settle();

    expect(source.current().queue).toEqual({ current: null, upcoming: [] });
    expect(source.current().problem).toBeNull();
    source.close();
  });
});

// A failed refresh is not a reason to empty a list someone is looking at.
describe('when the fetch fails', () => {
  it('keeps the rows it already has and records the problem', async () => {
    const source = build();
    source.open();
    await settle();
    expect(source.current().queue.upcoming).toEqual([tha]);

    net.answerWith({ ok: false, status: 502, body: { error: { kind: 'network' } } });
    sched.fire();
    await settle();

    expect(source.current().queue.upcoming).toEqual([tha]);
    expect(source.current().problem?.kind).toBe('network');
    source.close();
  });

  it('reports a network error when the request never lands', async () => {
    net.answerWith('throws');
    const source = build();
    source.open();
    await settle();

    expect(source.current().problem?.kind).toBe('network');
    expect(source.current().pending).toBe(false);
    source.close();
  });

  // Pretending an unreadable body means "nothing is queued" would put a
  // confident lie on the screen instead of a caveat.
  it('treats a body that is not a queue as a problem, not as empty', async () => {
    net.answerWith({ ok: true, status: 200, body: { nonsense: true } });
    const source = build();
    source.open();
    await settle();

    expect(source.current().queue.upcoming).toEqual([]);
    expect(source.current().problem).not.toBeNull();
    source.close();
  });

  it('rejects a body whose current item is neither an item nor null', async () => {
    net.answerWith({ ok: true, status: 200, body: { current: 'Xtal', upcoming: [] } });
    const source = build();
    source.open();
    await settle();

    expect(source.current().problem).not.toBeNull();
    source.close();
  });

  it('rejects a body that is not an object at all', async () => {
    net.answerWith({ ok: true, status: 200, body: 'nothing queued' });
    const source = build();
    source.open();
    await settle();

    expect(source.current().problem).not.toBeNull();
    source.close();
  });

  it('falls back to the status when the error body is unreadable', async () => {
    net.answerWith({ ok: false, status: 500 });
    const source = build();
    source.open();
    await settle();

    expect(source.current().problem?.kind).toBe('unexpected');
    expect(source.current().problem?.message).toContain('500');
    source.close();
  });

  it('clears the problem once a fetch succeeds again', async () => {
    net.answerWith(
      { ok: false, status: 500 },
      { ok: true, status: 200, body: { current: null, upcoming: [] } },
    );
    const source = build();
    source.open();
    await settle();
    expect(source.current().problem).not.toBeNull();

    sched.fire();
    await settle();

    expect(source.current().problem).toBeNull();
    source.close();
  });

  it('stops calling a subscriber that has unsubscribed', async () => {
    const source = build();
    const seen: QueueSourceState[] = [];
    const off = source.subscribe((v) => seen.push(v));
    off();

    source.open();
    await settle();

    expect(seen).toHaveLength(1);
    source.close();
  });
});
