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
}

/** Pull `"retryDelay":"36s"` out of a provider error payload. */
export function parseRetryDelaySeconds(raw: string): number | undefined {
  const match = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (match) return Math.ceil(Number(match[1]));
  return undefined;
}

export function describeProviderError(err: unknown, provider = 'The answer engine'): ReadableError {
  const raw = typeof err === 'string' ? err : String((err as any)?.message || err || '');
  const lower = raw.toLowerCase();
  const retryAfterSeconds = parseRetryDelaySeconds(raw);

  if (lower.includes('resource_exhausted') || lower.includes('exceeded your current quota') || lower.includes('429')) {
    const isDailyCap = lower.includes('per day') || lower.includes('perday') || lower.includes('daily');
    return {
      kind: 'quota',
      retryAfterSeconds,
      message: isDailyCap
        ? `${provider} has hit its daily free-tier quota. It resets in 24 hours, or you can raise the limit by enabling billing on the API key.`
        : `${provider} is rate limited on the free tier${
            retryAfterSeconds ? `; it asked us to wait about ${retryAfterSeconds}s` : ''
          }. Wait a moment and re-run, or enable billing on the API key to lift the per-minute cap.`,
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
