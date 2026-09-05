import { describe, expect, it } from 'vitest';
import type { JoshifyError } from '@joshify/core';
import {
  commandRequest,
  createCommandClient,
  type Command,
  type FetchLike,
} from './commands.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const fakeFetch = (
  answer: { ok: boolean; status: number; body?: unknown } | 'throws' = {
    ok: true,
    status: 202,
  },
) => {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
    });
    if (answer === 'throws') return Promise.reject(new Error('loopback refused'));
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () =>
        answer.body === undefined
          ? Promise.reject(new Error('no body'))
          : Promise.resolve(answer.body),
    });
  };
  return { fetch, calls };
};

describe('what each command sends', () => {
  it.each<[Command, string, Record<string, unknown>]>([
    [{ kind: 'play' }, 'play', {}],
    [
      { kind: 'play', contextUri: 'spotify:album:a' },
      'play',
      { contextUri: 'spotify:album:a' },
    ],
    [{ kind: 'pause' }, 'pause', {}],
    [{ kind: 'next' }, 'next', {}],
    [{ kind: 'previous' }, 'previous', {}],
    [{ kind: 'seek', positionMs: 42_000 }, 'seek', { positionMs: 42_000 }],
    [{ kind: 'volume', volumePercent: 30 }, 'volume', { volumePercent: 30 }],
    [{ kind: 'shuffle', enabled: true }, 'shuffle', { enabled: true }],
    [{ kind: 'repeat', mode: 'track' }, 'repeat', { mode: 'track' }],
    [{ kind: 'transfer', deviceId: 'dev-9' }, 'transfer', { deviceId: 'dev-9' }],
    [
      { kind: 'transfer', deviceId: 'dev-9', play: false },
      'transfer',
      { deviceId: 'dev-9', play: false },
    ],
  ])('%o becomes a POST to %s', (command, path, body) => {
    expect(commandRequest(command, {})).toEqual({ path, body });
  });

  it('adds the device id to every targetable command', () => {
    expect(commandRequest({ kind: 'pause' }, { deviceId: 'dev-9' }).body).toEqual({
      deviceId: 'dev-9',
    });
    expect(
      commandRequest({ kind: 'volume', volumePercent: 10 }, { deviceId: 'dev-9' }).body,
    ).toEqual({ volumePercent: 10, deviceId: 'dev-9' });
  });

  // Transfer names its own device; a target would be a second, contradictory
  // answer to the same question.
  it('does not let a target override a transfer’s device', () => {
    expect(
      commandRequest({ kind: 'transfer', deviceId: 'dev-9' }, { deviceId: 'dev-1' }).body,
    ).toEqual({ deviceId: 'dev-9' });
  });

  it('posts JSON, because the server rejects form encodings on purpose', async () => {
    const { fetch, calls } = fakeFetch();
    await createCommandClient({ fetch }).send({ kind: 'pause' });

    expect(calls[0]?.url).toBe('/api/playback/pause');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('prefixes a base url when one is given', async () => {
    const { fetch, calls } = fakeFetch();
    await createCommandClient({ fetch, baseUrl: 'http://127.0.0.1:8080' }).send({
      kind: 'next',
    });

    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/api/playback/next');
  });
});

describe('when a command fails', () => {
  it('resolves null on the server’s 202', async () => {
    const { fetch } = fakeFetch({ ok: true, status: 202 });
    expect(await createCommandClient({ fetch }).send({ kind: 'pause' })).toBeNull();
  });

  it('passes the server’s error envelope through', async () => {
    const problems: JoshifyError[] = [];
    const { fetch } = fakeFetch({
      ok: false,
      status: 403,
      body: {
        error: { kind: 'not-premium', message: 'Premium required', retryable: false },
      },
    });

    const error = await createCommandClient({
      fetch,
      onProblem: (e) => problems.push(e),
    }).send({ kind: 'pause' });

    expect(error?.kind).toBe('not-premium');
    expect(error?.message).toBe('Premium required');
    expect(problems).toHaveLength(1);
  });

  // A body we cannot read still has to produce something true to show.
  it('falls back to the status when there is no envelope', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 500 });
    const error = await createCommandClient({ fetch }).send({ kind: 'next' });

    expect(error?.kind).toBe('unexpected');
    expect(error?.message).toContain('500');
    expect(error?.retryable).toBe(false);
  });

  it('reads a malformed envelope as unexpected rather than trusting it', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 400, body: { error: { kind: 7 } } });
    const error = await createCommandClient({ fetch }).send({ kind: 'next' });

    expect(error?.kind).toBe('unexpected');
  });

  // The browser could not reach loopback: there is no envelope at all, and
  // "network" is the honest answer rather than a parse failure.
  it('reports a network error when the request never lands', async () => {
    const { fetch } = fakeFetch('throws');
    const error = await createCommandClient({ fetch }).send({ kind: 'pause' });

    expect(error?.kind).toBe('network');
    expect(error?.retryable).toBe(true);
  });
});
