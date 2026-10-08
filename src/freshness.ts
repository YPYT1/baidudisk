/** Only a recent successful result is reusable; future/invalid timestamps never qualify. */
export function isRecent(timestamp: string | undefined, maxAgeMs: number, now = Date.now()): boolean {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  const age = now - time;
  return Number.isFinite(time) && age >= 0 && age < maxAgeMs;
}
export const LIST_MAX_AGE_MS = 60_000;
export const SUMMARY_MAX_AGE_MS = 5 * 60_000;
