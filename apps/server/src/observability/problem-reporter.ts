/**
 * What a long outage should look like in the log.
 *
 * The device polls every couple of seconds and runs for weeks. When the wifi
 * drops overnight, the naive path writes the same line about thirty thousand
 * times, and the one interesting fact — *when it started and when it came
 * back* — is buried in it. Worse, the log is on an SD card with a finite
 * number of writes in it.
 *
 * So a repeated problem is reported once, then counted. Recovery is reported
 * too, with how long it lasted and how many attempts it took, because "the
 * network was down from 02:14 to 06:31" is the sentence somebody actually
 * needs at 1am.
 *
 * Deliberately *not* a rate limiter. A limiter drops messages by clock, and
 * would hide a genuinely new problem that happened to arrive during a storm of
 * old ones. This drops only *repeats*; anything different gets through
 * immediately.
 */
import type { JoshifyError } from '@joshify/core';

/** What a reporter emits: a line, and the facts behind it. */
export interface ProblemReport {
  readonly kind: 'started' | 'continuing' | 'recovered';
  readonly error: JoshifyError | null;
  /** How many consecutive occurrences this report covers. */
  readonly occurrences: number;
  /** How long the run has lasted so far, in ms. */
  readonly forMs: number;
  readonly message: string;
}

export interface ProblemReporterConfig {
  readonly emit: (report: ProblemReport) => void;
  /** Injected, like everything else with a clock in it (D-023). */
  readonly now: () => number;
  /**
   * How long a run must go on before it is worth mentioning again.
   *
   * Five minutes: long enough that an overnight outage is a handful of lines
   * rather than thousands, short enough that somebody watching a live journal
   * can tell "still broken" from "the process died".
   */
  readonly reminderMs?: number | undefined;
}

export const DEFAULT_REMINDER_MS = 5 * 60_000;

/**
 * Two problems are "the same" when they would produce the same line.
 *
 * Keyed on kind and message rather than on the object, because every failed
 * poll builds a fresh error — comparing references would make every repeat
 * look new, which is the entire failure this module exists to prevent.
 */
const sameProblem = (a: JoshifyError, b: JoshifyError): boolean =>
  a.kind === b.kind && a.message === b.message;

const humanDuration = (ms: number): string => {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60).padStart(2, '0')}m`;
};

export interface ProblemReporter {
  /** Report one failure. Most of the time this emits nothing. */
  readonly problem: (error: JoshifyError) => void;
  /** Report that whatever was failing is working again. */
  readonly recovered: () => void;
}

export const createProblemReporter = (config: ProblemReporterConfig): ProblemReporter => {
  const reminderMs = config.reminderMs ?? DEFAULT_REMINDER_MS;

  let current: JoshifyError | null = null;
  let occurrences = 0;
  let startedAt = 0;
  let lastMentionedAt = 0;

  return {
    problem: (error) => {
      const at = config.now();

      // A different problem is news, whatever is already happening. It also
      // *replaces* the run: reporting "network down for 3h" while the real
      // fault has become an expired token would be actively misleading.
      if (current === null || !sameProblem(current, error)) {
        current = error;
        occurrences = 1;
        startedAt = at;
        lastMentionedAt = at;
        config.emit({
          kind: 'started',
          error,
          occurrences: 1,
          forMs: 0,
          message: `[${error.kind}] ${error.message}`,
        });
        return;
      }

      occurrences += 1;
      if (at - lastMentionedAt < reminderMs) return;

      lastMentionedAt = at;
      const forMs = at - startedAt;
      config.emit({
        kind: 'continuing',
        error,
        occurrences,
        forMs,
        message: `[${error.kind}] still failing after ${humanDuration(forMs)} (${String(occurrences)} attempts): ${error.message}`,
      });
    },

    recovered: () => {
      // Nothing was wrong, so there is nothing to announce. Without this a
      // healthy device would log a recovery on every successful poll.
      if (current === null) return;

      const forMs = config.now() - startedAt;
      const error = current;
      const total = occurrences;
      current = null;
      occurrences = 0;

      config.emit({
        kind: 'recovered',
        error: null,
        occurrences: total,
        forMs,
        message: `[${error.kind}] recovered after ${humanDuration(forMs)} (${String(total)} failed attempts)`,
      });
    },
  };
};
