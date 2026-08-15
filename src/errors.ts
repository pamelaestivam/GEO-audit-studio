/**
 * Turns raw provider errors into something a client can read and act on.
 *
 * Provider SDKs throw stringified JSON blobs. Rendering those verbatim in the
 * product tells the user nothing about what to do next, so every user-visible
 * failure path goes through here.
 */

export interface ReadableError {
  /** One sentence, no JSON, safe to render. */
  message: string;
  /** Machine-readable cause for tests and conditional UI. */
  kind: 'quota' | 'auth' | 'timeout' | 'rate_limit' | 'network' | 'unknown';
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfterSeconds?: number;
  /** True when the quota exhausted is a daily cap rather than a per-minute one. */
  isDailyQuota?: boolean;
}

/**
 * Fragments that appear only in messages this module writes, used to
 * recognise our own prose when it is round-tripped back through
 * `describeProviderError` as a plain string (a job error field, say) and the
 * `QuotaExhaustedError` class identity has been lost.
 *
 * Deliberately shared constants rather than string literals duplicated
 * between the message templates and the detection: the previous version
 * matched on hand-copied phrases, so any reword silently reclassified our own
 * messages as 'unknown' and the user got the generic "unexpected error" text
 * instead of the actionable one.
 */
export const RATE_LIMIT_MARKER = 'too many requests in a short window';
export const DAILY_QUOTA_MARKER = 'daily request quota for this API key is used up';

// Detection runs against a lowercased haystack, so the markers have to be
// lowercased too - "API key" in the constant above would otherwise never
// match its own message.
const RATE_LIMIT_MARKER_LC = RATE_LIMIT_MARKER.toLowerCase();
const DAILY_QUOTA_MARKER_LC = DAILY_QUOTA_MARKER.toLowerCase();

/** Pull `"retryDelay":"36s"` out of a provider error payload. */
export function parseRetryDelaySeconds(raw: string): number | undefined {
  const match = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (match) return Math.ceil(Number(match[1]));
  return undefined;
}

/**
 * Google's daily-quota errors don't always say the word "daily" in prose -
 * the tell is usually the quota metric/id, e.g.
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier". Checking for "day"
 * next to "per" catches both the prose and the identifier form.
 */
export function isDailyQuotaError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return /per[\s-]?day|daily|perdayper/.test(lower);
}

/**
 * Google resets free-tier daily quotas at midnight **Pacific**, not UTC
 * (https://ai.google.dev/gemini-api/docs/rate-limits). This used to compute
 * time-to-next-UTC-midnight, which is wrong by the Pacific offset in both
 * directions: for most of the day it holds the circuit breaker shut for up to
 * eight hours *after* the quota has actually reset, so the product keeps
 * refusing to run audits against a quota that is already available again.
 */
const QUOTA_RESET_TIMEZONE = 'America/Los_Angeles';

/**
 * Named-timezone formatting needs a full-ICU build. Node ships one by
 * default, but a stripped runtime would make this constructor throw - at
 * module load, taking the whole server down over a cooldown calculation. Fall
 * back to standard Pacific time instead: an hour out during daylight saving,
 * which is still far closer than the UTC midnight this replaced.
 */
const pacificParts = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: QUOTA_RESET_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    console.warn(
      `[errors] this runtime cannot resolve ${QUOTA_RESET_TIMEZONE}; quota reset times will assume a fixed UTC-8.`
    );
    return null;
  }
})();

const FALLBACK_PACIFIC_OFFSET_MS = -8 * 3600_000;

/** The wall-clock reading in the reset timezone at instant `at`. */
function pacificWallClock(at: number) {
  if (!pacificParts) {
    const shifted = new Date(at + FALLBACK_PACIFIC_OFFSET_MS);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }
  const parts: Record<string, string> = {};
  for (const p of pacificParts.formatToParts(new Date(at))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far the reset timezone is from UTC at instant `at`, in ms. */
function pacificOffsetMs(at: number): number {
  const w = pacificWallClock(at);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // `at` may carry sub-second precision the formatter dropped; compare on whole seconds.
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Milliseconds until the next midnight in the quota reset timezone.
 *
 * Two-pass so the daylight-saving transitions are handled: the offset in
 * effect *now* is not necessarily the offset in effect at the next midnight,
 * and a naive "86,400,000 minus time-into-day" is an hour wrong twice a year.
 */
export function msUntilNextQuotaReset(now = Date.now()): number {
  const w = pacificWallClock(now);
  const nextMidnightWallClock = Date.UTC(w.year, w.month - 1, w.day + 1, 0, 0, 0);
  const firstGuess = nextMidnightWallClock - pacificOffsetMs(now);
  const refined = nextMidnightWallClock - pacificOffsetMs(firstGuess);
  return Math.max(0, refined - now);
}

/** "4h 12m", "38s" - for telling a user precisely when to come back. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * How long to stop trying after a quota error. A daily cap needs waiting
 * until the provider's daily reset; a per-minute cap needs whatever the
 * provider asked for, with a floor so a missing retryDelay doesn't collapse
 * to an instant retry.
 */
export function computeQuotaCooldownMs(raw: string, now = Date.now()): number {
  if (isDailyQuotaError(raw)) return msUntilNextQuotaReset(now);
  const suggested = parseRetryDelaySeconds(raw);
  const floorMs = 30000;
  return Math.max(floorMs, (suggested ?? 60) * 1000);
}

/** Does this raw provider text look like a 429 / exhausted-resource refusal? */
function looksLikeRateLimit(lower: string): boolean {
  // `includes('429')` matched any string with those three digits anywhere -
  // a request id, a token count, a byte offset - and silently relabelled
  // unrelated failures as quota problems. Require 429 to stand alone.
  return (
    /(^|[^\d])429([^\d]|$)/.test(lower) ||
    lower.includes('resource_exhausted') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('quota exceeded') ||
    lower.includes('too many requests')
  );
}

export function describeProviderError(err: unknown, provider = 'The answer engine'): ReadableError {
  // A circuit-breaker refusal is already a finished, human-readable sentence
  // (built by computeQuotaCooldownMs/formatDuration at trip time). Re-running
  // it through the JSON-sniffing logic below would misclassify it as
  // 'unknown', since none of the raw-JSON markers this function looks for are
  // present in our own message. Duck-typed on `name` rather than
  // `instanceof` since the concrete class lives in server.ts, not here.
  if (err instanceof Error && err.name === 'QuotaExhaustedError') {
    return { kind: 'quota', message: err.message };
  }

  const raw = typeof err === 'string' ? err : String((err as any)?.message || err || '');
  const lower = raw.toLowerCase();
  const retryAfterSeconds = parseRetryDelaySeconds(raw);

  // The breaker's own generated sentences pass through here too once
  // stringified into a plain `.error` field, losing the `instanceof` check
  // above. Matched on shared constants so a reword cannot desynchronise the
  // messages from their own detection.
  const isOwnDailyMessage = lower.includes(DAILY_QUOTA_MARKER_LC);
  const isOwnRateLimitMessage = lower.includes(RATE_LIMIT_MARKER_LC);

  if (isOwnDailyMessage || isOwnRateLimitMessage || looksLikeRateLimit(lower)) {
    // Our own prose, round-tripped back through here as a plain string:
    // return it untouched, and preserve which of the two events it described
    // rather than collapsing both to 'quota'.
    if (isOwnDailyMessage) return { kind: 'quota', message: raw, isDailyQuota: true };
    if (isOwnRateLimitMessage) return { kind: 'rate_limit', message: raw, isDailyQuota: false };

    if (isDailyQuotaError(raw)) {
      return {
        kind: 'quota',
        retryAfterSeconds,
        isDailyQuota: true,
        message:
          `${provider}'s ${DAILY_QUOTA_MARKER}. Daily quotas reset at midnight Pacific time ` +
          `(in ${formatDuration(computeQuotaCooldownMs(raw))}). Enabling billing on the key raises the cap immediately.`,
      };
    }

    // A per-minute limit is a pacing signal, not a wall - so the message must
    // not imply the day is lost, and must not invent a duration the provider
    // never gave us. It previously always claimed "will retry automatically
    // in 1m 0s": nothing retried, and the 1m was this module's own fallback
    // constant being reported to the user as if the provider had said it.
    return {
      kind: 'rate_limit',
      retryAfterSeconds,
      isDailyQuota: false,
      message:
        retryAfterSeconds !== undefined
          ? `${provider} rate limited this request: ${RATE_LIMIT_MARKER}. It asked us to wait ${formatDuration(retryAfterSeconds * 1000)} before trying again. Enabling billing on the API key lifts the per-minute cap.`
          : `${provider} rate limited this request: ${RATE_LIMIT_MARKER}, and did not say for how long. Wait a minute and re-run; if it keeps happening, check the key's quota at https://aistudio.google.com/apikey or enable billing on it.`,
    };
  }

  if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) {
    return {
      kind: 'auth',
      message: `${provider} rejected the API key. Check the key configured in the server environment.`,
    };
  }

  if (lower.includes('abort') || lower.includes('timeout') || lower.includes('etimedout')) {
    return {
      kind: 'timeout',
      message: `${provider} did not respond in time. This usually clears on a re-run.`,
    };
  }

  if (lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('network')) {
    return {
      kind: 'network',
      message: `Could not reach ${provider}. Check network access from the server and re-run.`,
    };
  }

  return {
    kind: 'unknown',
    message: `${provider} returned an unexpected error. Re-run the audit; if it persists the server logs have the detail.`,
  };
}

/**
 * Summarise several failures into one sentence. Prefers the most actionable
 * cause rather than whichever error happened to arrive first.
 */
export function summariseFailures(errors: unknown[], provider = 'The answer engine'): ReadableError {
  if (errors.length === 0) {
    return { kind: 'unknown', message: `${provider} returned no answers.` };
  }
  const described = errors.map((e) => describeProviderError(e, provider));
  const priority: ReadableError['kind'][] = ['auth', 'quota', 'rate_limit', 'network', 'timeout', 'unknown'];
  for (const kind of priority) {
    const hit = described.find((d) => d.kind === kind);
    if (hit) return hit;
  }
  return described[0];
}
