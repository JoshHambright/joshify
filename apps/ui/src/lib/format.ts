/**
 * The few things the UI does compute — all of them about presentation, none
 * of them about truth.
 */

/**
 * `m:ss`, or `h:mm:ss` past an hour. Never negative: a progress value ahead of
 * the duration is a clock disagreement, not a reason to render `-0:03`.
 */
export const formatTime = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${String(minutes)}:${pad(seconds)}`;
};

/** Time left, as the panel shows it: `-2:27`. */
export const formatRemaining = (
  progressMs: number | null,
  durationMs: number | null,
): string => {
  if (progressMs === null || durationMs === null) return '--:--';
  return `-${formatTime(Math.max(0, durationMs - progressMs))}`;
};

/**
 * How far through, 0–1.
 *
 * A zero duration yields 0 rather than `NaN`. `NaN` in a CSS `width` is not an
 * error — it is a silently unstyled bar, which is the failure mode that
 * actually reaches a screen.
 */
export const progressFraction = (
  progressMs: number | null,
  durationMs: number | null,
): number => {
  if (progressMs === null || durationMs === null || durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, progressMs / durationMs));
};
