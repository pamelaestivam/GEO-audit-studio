/**
 * Makes a retried request cost what one request costs.
 *
 * `src/apiClient.ts` retries any request whose connection fails or hangs,
 * because a sleeping Render instance refuses or stalls the request that wakes
 * it. That retry is necessary - but it was being applied to POSTs that start
 * real, quota-spending work, and an aborted client request does not abort the
 * work the server already began. A cold instance therefore turned one click
 * on "Run Audit" into up to four concurrent audits: measured at 16 real
 * Gemini calls for a single click, against a free tier documented at 10
 * requests per minute. That is the "first use of the day and it is already
 * rate limited" report - the first use of the day is exactly when the
 * instance is asleep, so it is the one most likely to be quadrupled.
 *
 * The client sends a stable `Idempotency-Key` per user action and reuses it
 * across its own retries; the server replays the first result for that key
 * instead of starting the work again.
 *
 * Deliberately dependency-free and time-injectable so it can be unit tested
 * without a server or a clock.
 */

export interface IdempotencyResult<T> {
  value: T;
  /** True when this is a replay of work already started under the same key. */
  replayed: boolean;
}

export class IdempotencyStore<T> {
  private entries = new Map<string, { value: T; createdAt: number }>();

  constructor(private readonly ttlMs: number) {}

  /**
   * Return the value already stored for `key`, or store and return `create()`.
   *
   * A missing/blank key means the caller opted out (an older client, or a
   * direct API user), and every call runs - the previous behaviour exactly,
   * so this can never turn a legitimate request into a silent no-op.
   */
  run(key: string | undefined | null, create: () => T, now = Date.now()): IdempotencyResult<T> {
    if (!key) return { value: create(), replayed: false };

    this.prune(now);
    const existing = this.entries.get(key);
    if (existing) return { value: existing.value, replayed: true };

    const value = create();
    this.entries.set(key, { value, createdAt: now });
    return { value, replayed: false };
  }

  /**
   * Drop a key so the next request under it does the work again. Used when
   * the stored value is a promise that rejected: sharing an in-flight call is
   * the point, but a failed call must not be replayed as a cached failure for
   * the rest of the TTL - the user's next attempt deserves a real attempt.
   */
  forget(key: string | undefined | null): void {
    if (key) this.entries.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    }
  }

  /** Number of live keys. Exposed for tests. */
  size(now = Date.now()): number {
    this.prune(now);
    return this.entries.size;
  }
}

/** Header the client sends; also the name used by Stripe/IETF for this. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** A key unique to one user action, reused across that action's retries. */
export function newIdempotencyKey(): string {
  const globalCrypto = (globalThis as any).crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read the key off an Express-style request, tolerating array-valued headers. */
export function readIdempotencyKey(headers: Record<string, any> | undefined): string | undefined {
  const raw = headers?.[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // Bound it: the key is a Map key held for the whole TTL, and it arrives
  // from the network.
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}
