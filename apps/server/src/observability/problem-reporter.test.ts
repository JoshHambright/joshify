import { beforeEach, describe, expect, it } from 'vitest';
import type { JoshifyError } from '@joshify/core';
import {
  createProblemReporter,
  DEFAULT_REMINDER_MS,
  type ProblemReport,
} from './problem-reporter.js';

const offline = (): JoshifyError => ({
  kind: 'network',
  message: 'could not reach Spotify',
  retryable: true,
});

const rateLimited = (): JoshifyError => ({
  kind: 'rate-limited',
  message: 'slow down',
  retryable: true,
});

let clock: number;
let reports: ProblemReport[];

const build = (reminderMs?: number) =>
  createProblemReporter({
    emit: (report) => reports.push(report),
    now: () => clock,
    ...(reminderMs === undefined ? {} : { reminderMs }),
  });

beforeEach(() => {
  clock = 1_000;
  reports = [];
});

describe('a run of the same problem', () => {
  it('says it once', () => {
    const reporter = build();

    reporter.problem(offline());

    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('started');
    expect(reports[0]?.message).toContain('could not reach Spotify');
  });

  // A poll every two seconds, overnight, is about thirty thousand identical
  // lines on an SD card with a finite number of writes in it.
  it('stays quiet through a long outage', () => {
    const reporter = build();

    // Eight hours at one failure every two seconds.
    for (let elapsed = 0; elapsed < 8 * 60 * 60_000; elapsed += 2_000) {
      clock = 1_000 + elapsed;
      reporter.problem(offline());
    }

    // One line to open it, plus a reminder every five minutes: about a hundred
    // lines for eight hours, rather than fourteen thousand.
    expect(reports.length).toBeLessThan(120);
    expect(reports.filter((r) => r.kind === 'started')).toHaveLength(1);
  });

  it('mentions it again once the reminder interval has passed', () => {
    const reporter = build(60_000);

    reporter.problem(offline());
    clock += 30_000;
    reporter.problem(offline());
    expect(reports).toHaveLength(1); // too soon

    clock += 31_000;
    reporter.problem(offline());

    expect(reports).toHaveLength(2);
    expect(reports[1]?.kind).toBe('continuing');
    expect(reports[1]?.occurrences).toBe(3);
    expect(reports[1]?.message).toContain('still failing');
  });

  // Comparing objects would make every repeat look new, which is the entire
  // failure this exists to prevent — each poll builds a fresh error.
  it('recognises a repeat built as a fresh object', () => {
    const reporter = build();

    reporter.problem(offline());
    reporter.problem(offline());
    reporter.problem(offline());

    expect(reports).toHaveLength(1);
  });
});

describe('a different problem', () => {
  // Reporting "network down for 3h" while the real fault has become an expired
  // token would be actively misleading.
  it('gets through immediately and replaces the run', () => {
    const reporter = build();
    reporter.problem(offline());
    clock += 10_000;

    reporter.problem(rateLimited());

    expect(reports).toHaveLength(2);
    expect(reports[1]?.kind).toBe('started');
    expect(reports[1]?.error?.kind).toBe('rate-limited');
  });

  it('treats the same kind with a different message as different', () => {
    const reporter = build();
    reporter.problem(offline());

    reporter.problem({ ...offline(), message: 'DNS failed' });

    expect(reports).toHaveLength(2);
  });

  // The point of not being a rate limiter: a storm of one problem must not
  // hide the arrival of another.
  it('is not silenced by a storm of something else', () => {
    const reporter = build();
    for (let i = 0; i < 500; i += 1) {
      clock += 2_000;
      reporter.problem(offline());
    }
    const before = reports.length;

    reporter.problem(rateLimited());

    expect(reports).toHaveLength(before + 1);
  });
});

describe('recovering', () => {
  // "The network was down from 02:14 to 06:31" is the sentence somebody
  // actually needs.
  it('says how long it lasted and how many attempts it took', () => {
    const reporter = build();
    reporter.problem(offline());
    clock += 60_000;
    reporter.problem(offline());
    clock += 60_000;

    reporter.recovered();

    const last = reports.at(-1);
    expect(last?.kind).toBe('recovered');
    expect(last?.occurrences).toBe(2);
    expect(last?.message).toContain('recovered after 2m');
  });

  // Without this a healthy device logs a recovery on every successful poll.
  it('says nothing when nothing was wrong', () => {
    const reporter = build();

    reporter.recovered();
    reporter.recovered();

    expect(reports).toEqual([]);
  });

  it('does not repeat itself after recovering', () => {
    const reporter = build();
    reporter.problem(offline());
    reporter.recovered();
    const after = reports.length;

    reporter.recovered();

    expect(reports).toHaveLength(after);
  });

  it('starts a fresh run when the problem comes back', () => {
    const reporter = build();
    reporter.problem(offline());
    clock += 60_000;
    reporter.recovered();
    clock += 60_000;

    reporter.problem(offline());

    expect(reports.at(-1)?.kind).toBe('started');
    expect(reports.at(-1)?.occurrences).toBe(1);
  });
});

describe('the duration it prints', () => {
  it.each([
    [500, '500ms'],
    [4_000, '4s'],
    [90_000, '2m'],
    [3 * 60 * 60_000 + 14 * 60_000, '3h14m'],
  ])('renders %ims as %s', (ms, expected) => {
    const reporter = build();
    reporter.problem(offline());
    clock += ms;
    reporter.recovered();

    expect(reports.at(-1)?.message).toContain(expected);
  });

  it('defaults to a five-minute reminder', () => {
    expect(DEFAULT_REMINDER_MS).toBe(300_000);
  });
});
