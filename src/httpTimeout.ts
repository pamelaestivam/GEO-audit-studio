/**
 * Reads an optional "milliseconds" setting from the environment. Pure so the rule can be tested: an unset or empty value
 * is the default; a finite number of at least `min` is used as given; anything else (text, NaN, a negative number, 0, a
 * number below `min`, Infinity) is refused and the default is used, with a sentence the caller logs. Refusing matters
 * because a value the SDK reads as "no limit" (NaN, 0) would silently bring the blocked-queue defect back, and so is
 * one above the largest delay a Node timer holds (2147483647 ms, about 24.8 days): the timer clamps it to 1 ms, so every
 * request would be abandoned at once.
 */
const MAX_TIMER_MS = 2147483647;
export function parseMillisecondsSetting(
  name: string,
  raw: string | undefined,
  fallbackMs: number,
  minMs: number,
  maxMs = MAX_TIMER_MS
): { ms: number; warning?: string } {
  if (raw === undefined || raw.trim() === '') return { ms: fallbackMs };
  const n = Number(raw);
  if (Number.isFinite(n) && n >= minMs && n <= maxMs) return { ms: n };
  return { ms: fallbackMs, warning: `${name}=${JSON.stringify(raw)} is not a number of milliseconds between ${minMs} and ${maxMs}; using ${fallbackMs}.` };
}
