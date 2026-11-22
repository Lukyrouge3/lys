// Shared formatting for the `jobs:` log lines, so one click reads as a short
// story in `docker compose logs bot` and `grep jobs:` shows the whole pipeline.

const MAX_TITLE_CHARS = 60;

/** The first 8 characters of a job id: enough to match two lines by eye. */
export function shortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

/** One line, never longer than `max` (ellipsis included), so logs stay scannable. */
export function clip(text: string, max = MAX_TITLE_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
