/** Shared formatting helpers for the goal extension (pure). */

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Human-friendly elapsed time for the footer. Seconds under a minute, minutes
 * under an hour ("4m 12s"), hours beyond ("1h 5m"). Negative / non-finite input
 * clamps to 0s — the footer must never show a negative or NaN timer.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}
