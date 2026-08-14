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

/** Milliseconds until the next UTC midnight, when daily quotas reset. */
export function msUntilNextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next - now;
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
 * until UTC midnight; a per-minute cap needs whatever the provider asked for,
 * with a floor so a missing retryDelay doesn't collapse to an instant retry.
 */
export function computeQuotaCooldownMs(raw: string, now = Date.now()): number {
  if (isDailyQuotaError(raw)) return msUntilNextUtcMidnight(now);
  const suggested = parseRetryDelaySeconds(raw);
  const floorMs = 30000;
  return Math.max(floorMs, (suggested ?? 60) * 1000);
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

  // The breaker's own generated sentences ("...quota is exhausted...", "...
  // rate limited on the free tier...") pass through here too once stringified
  // into a plain `.error` field, losing the `instanceof` check above. These
  // phrases are distinctive to messages this module itself produces.
  const isOwnQuotaMessage = lower.includes('free-tier quota is exhausted') || lower.includes('rate limited on the free tier');

  if (isOwnQuotaMessage || lower.includes('resource_exhausted') || lower.includes('exceeded your current quota') || lower.includes('429')) {
    if (isOwnQuotaMessage) return { kind: 'quota', message: raw, isDailyQuota: lower.includes('daily') };
    const isDailyCap = isDailyQuotaError(raw);
    const cooldownMs = computeQuotaCooldownMs(raw);
    return {
      kind: 'quota',
      retryAfterSeconds,
      isDailyQuota: isDailyCap,
      message: isDailyCap
        ? `${provider}'s daily free-tier quota is exhausted. It resets at midnight UTC (in ${formatDuration(cooldownMs)}), or you can raise the limit by enabling billing on the API key.`
        : `${provider} is rate limited on the free tier. It will retry automatically in ${formatDuration(cooldownMs)}, or you can enable billing on the API key to lift the per-minute cap.`,
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
