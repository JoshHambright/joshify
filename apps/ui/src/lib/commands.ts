/**
 * Sending a command from the panel.
 *
 * Two rules, both from D-028, and both the reason this is a separate module
 * rather than a `fetch` inside a click handler:
 *
 * 1. **The UI never waits for the answer.** The server replies 202 — Spotify
 *    accepted it, the proof arrives later on the socket. A control that
 *    disabled itself until the response landed would feel slower than the
 *    speaker it is driving.
 * 2. **A failure has to be visible.** Not as a dialog: the optimistic value
 *    rolls back on the next poll, and the caller is told so it can flash the
 *    control it belongs to.
 *
 * `fetch` is injected. Every test here then runs without a server, and the one
 * thing worth asserting — the exact body each command sends — is asserted
 * directly rather than through a round trip.
 */
import type { JoshifyError, ErrorKind, RepeatMode } from '@joshify/core';

/** Where a command is aimed. Absent means "whatever is active". */
export interface CommandTarget {
  readonly deviceId?: string | undefined;
}

export type Command =
  | { readonly kind: 'play'; readonly contextUri?: string | undefined }
  | { readonly kind: 'pause' }
  | { readonly kind: 'next' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'seek'; readonly positionMs: number }
  | { readonly kind: 'volume'; readonly volumePercent: number }
  | { readonly kind: 'shuffle'; readonly enabled: boolean }
  | { readonly kind: 'repeat'; readonly mode: RepeatMode }
  | { readonly kind: 'transfer'; readonly deviceId: string; readonly play?: boolean };

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CommandClientConfig {
  readonly fetch: FetchLike;
  /** Prefixed to every path. Empty for the device, where the UI is same-origin. */
  readonly baseUrl?: string | undefined;
  /** Called for every failure, so a caller that ignores the result still logs. */
  readonly onProblem?: ((error: JoshifyError) => void) | undefined;
}

/** The route name and JSON body for a command. Exported for the tests. */
export const commandRequest = (
  command: Command,
  target: CommandTarget,
): { path: string; body: Record<string, unknown> } => {
  const withDevice = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    target.deviceId === undefined ? extra : { ...extra, deviceId: target.deviceId };

  switch (command.kind) {
    case 'play':
      return {
        path: 'play',
        body: withDevice(
          command.contextUri === undefined ? {} : { contextUri: command.contextUri },
        ),
      };
    case 'pause':
    case 'next':
    case 'previous':
      return { path: command.kind, body: withDevice() };
    case 'seek':
      return { path: 'seek', body: withDevice({ positionMs: command.positionMs }) };
    case 'volume':
      return {
        path: 'volume',
        body: withDevice({ volumePercent: command.volumePercent }),
      };
    case 'shuffle':
      return { path: 'shuffle', body: withDevice({ enabled: command.enabled }) };
    case 'repeat':
      return { path: 'repeat', body: withDevice({ mode: command.mode }) };
    case 'transfer':
      return {
        path: 'transfer',
        body:
          command.play === undefined
            ? { deviceId: command.deviceId }
            : { deviceId: command.deviceId, play: command.play },
      };
  }
};

/**
 * The server's error envelope, or a stand-in.
 *
 * A command that failed because the browser could not reach loopback produces
 * no envelope at all, and the panel still has to say something true — so the
 * network case gets a real `network` error rather than a parse failure.
 */
const readError = async (
  response: { status: number; json: () => Promise<unknown> } | null,
): Promise<JoshifyError> => {
  if (response === null) {
    return {
      kind: 'network',
      message: 'the panel could not reach the Joshify server',
      retryable: true,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const envelope =
    typeof body === 'object' && body !== null
      ? (body as { error?: { kind?: unknown; message?: unknown; retryable?: unknown } })
          .error
      : undefined;
  const kind =
    typeof envelope?.kind === 'string' ? (envelope.kind as ErrorKind) : 'unexpected';
  return {
    kind,
    message:
      typeof envelope?.message === 'string'
        ? envelope.message
        : `the server answered ${String(response.status)}`,
    retryable: envelope?.retryable === true,
  };
};

export interface CommandClient {
  /** Resolves to `null` on success, or the error the panel should react to. */
  readonly send: (
    command: Command,
    target?: CommandTarget,
  ) => Promise<JoshifyError | null>;
}

export const createCommandClient = (config: CommandClientConfig): CommandClient => {
  const base = config.baseUrl ?? '';

  return {
    send: async (command, target = {}) => {
      const { path, body } = commandRequest(command, target);
      let response: Awaited<ReturnType<FetchLike>> | null = null;
      try {
        response = await config.fetch(`${base}/api/playback/${path}`, {
          method: 'POST',
          // JSON only: the server rejects form encodings precisely so a
          // cross-origin form cannot drive the speakers (D-034).
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        response = null;
      }
      if (response !== null && response.ok) return null;

      const error = await readError(response);
      config.onProblem?.(error);
      return error;
    },
  };
};
