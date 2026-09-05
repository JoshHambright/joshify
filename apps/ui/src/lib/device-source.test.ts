import { beforeEach, describe, expect, it } from 'vitest';
import type { PlaybackDevice } from '@joshify/core';
import {
  createDeviceSource,
  DEVICE_POLL_MS,
  type DeviceSourceState,
  type FetchLike,
  type Scheduler,
} from './device-source.js';

const kitchen: PlaybackDevice = {
  id: 'dev-1',
  name: 'Kitchen',
  type: 'Speaker',
  isActive: true,
  volumePercent: 55,
  supportsVolume: true,
};

type Answer = { ok: boolean; status: number; body?: unknown } | 'throws';

const fakeFetch = () => {
  const urls: string[] = [];
  let answers: Answer[] = [{ ok: true, status: 200, body: { devices: [kitchen] } }];
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

const build = () => createDeviceSource({ fetch: net.fetch, scheduler: sched.scheduler });

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

describe('the device source', () => {
  it('gives a subscriber the current value immediately', () => {
    const seen: DeviceSourceState[] = [];
    build().subscribe((v) => seen.push(v));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.pending).toBe(true);
    expect(seen[0]?.devices).toEqual([]);
  });

  it('fetches the list on open and publishes it', async () => {
    const source = build();
    source.open();
    await settle();

    expect(net.urls).toEqual(['/api/devices']);
    expect(source.current().devices).toEqual([kitchen]);
    expect(source.current().pending).toBe(false);
  });

  // Only interesting while the screen is open: a wall panel showing Now
  // Playing has no use for a fresh device list, and polling one for hours
  // spends the budget the transport commands need.
  it('polls only between open and close', async () => {
    const source = build();
    source.open();
    await settle();
    expect(sched.delay()).toBe(DEVICE_POLL_MS);

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
    expect(sched.delay()).toBe(DEVICE_POLL_MS);
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

  // A transfer should move the lamp without waiting out a five-second poll.
  it('refreshes once on demand', async () => {
    const source = build();
    await source.refresh();
    await settle();

    expect(net.urls).toHaveLength(1);
    expect(source.current().devices).toEqual([kitchen]);
    // A bare refresh arms nothing: it is not a subscription.
    expect(sched.delay()).toBeNull();
  });
});

// A failed refresh is not a reason to empty a list someone is looking at.
describe('when the fetch fails', () => {
  it('keeps the rows it already has and records the problem', async () => {
    const source = build();
    source.open();
    await settle();
    expect(source.current().devices).toEqual([kitchen]);

    net.answerWith({ ok: false, status: 502, body: { error: { kind: 'network' } } });
    sched.fire();
    await settle();

    expect(source.current().devices).toEqual([kitchen]);
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

  it('treats a body that is not a device list as a problem, not as empty', async () => {
    net.answerWith({ ok: true, status: 200, body: { nonsense: true } });
    const source = build();
    source.open();
    await settle();

    expect(source.current().devices).toEqual([]);
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
      { ok: true, status: 200, body: { devices: [] } },
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
    const seen: DeviceSourceState[] = [];
    const off = source.subscribe((v) => seen.push(v));
    off();

    source.open();
    await settle();

    expect(seen).toHaveLength(1);
    source.close();
  });
});
