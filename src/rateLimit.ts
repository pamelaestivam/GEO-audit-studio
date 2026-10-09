/**
 * A fixed-window request counter, per key (an IP address).
 *
 * Why this exists at all: every quota-spending endpoint is open to anyone who
 * has the URL (see TECH_DEBT.md 2.2), and one audit costs real money and a
 * slice of a free-tier quota that is shared by every user. Without a limit,
 * one script - or one stuck client retry loop - exhausts the day for everybody.
 *
 * Deliberately simple and in-memory. On a serverless host each instance keeps
 * its own counters, so the effective limit is per-instance; that still stops
 * the failure that matters (one client hammering one instance) and is not a
 * substitute for the shared store tracked in TECH_DEBT.md 3.1. Pure and
 * clock-injected so it is unit-tested without sleeping.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets; meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

/** More distinct keys than this at once is an attack or a bug; stop remembering new ones. */
const MAX_KEYS = 50_000;

export class FixedWindowLimiter {
  private windows = new Map<string, { startedAt: number; count: number }>();
  private lastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    // Scanning every key on every request made each request O(keys), which an
    // attacker rotating keys could use to slow the whole server. Expired
    // windows are harmless until swept, so sweep at most every few seconds.
    if (now - this.lastPrune >= Math.min(this.windowMs, 5000)) this.prune(now);
    const current = this.windows.get(key);

    if (!current || now - current.startedAt >= this.windowMs) {
      if (!current && this.windows.size >= MAX_KEYS) {
        // At the cap: sweep for expired keys, but at most once a second, or an
        // attacker holding the table full makes every request scan all of it.
        if (now - this.lastPrune >= 1000) this.prune(now);
        // Still full of live keys: refuse to grow. Failing closed for a key we
        // cannot track is safer than unbounded memory.
        if (this.windows.size >= MAX_KEYS) return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
      }
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop expired windows so a long-lived process cannot accumulate keys forever. */
  prune(now = Date.now()): void {
    this.lastPrune = now;
    for (const [key, w] of this.windows) {
      if (now - w.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }

  /** Number of live keys. Exposed for tests. */
  size(now = Date.now()): number {
    this.prune(now);
    return this.windows.size;
  }
}
