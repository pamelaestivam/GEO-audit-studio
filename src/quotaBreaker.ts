/**
 * Circuit breaker for a provider whose quota is exhausted.
 *
 * Without this, a quota error was retried per call site (up to 3 times, tens
 * of seconds apart) and every call site in an audit hit the same exhausted
 * quota independently - one failed audit could attempt Gemini 15-20 times
 * before giving up, taking minutes, and using up whatever quota might have
 * been about to recover. Once a quota error is seen, this remembers it and
 * every subsequent call - across this request, this audit, and every other
 * request on the server - fails instantly with the stored reason until the
 * cooldown elapses. No further network calls are attempted against a wall
 * already known to be there.
 *
 * Deliberately pure and dependency-free (the caller passes `now`) so it can
 * be unit tested without mocking time or the network.
 */

export interface QuotaBreakerStatus {
  tripped: boolean;
  reason: string | null;
  resetAt: number | null;
  msRemaining: number;
}

export class QuotaBreaker {
  private exhaustedUntil: number | null = null;
  private reason: string | null = null;

  /** True if currently tripped. Auto-clears once the cooldown has elapsed. */
  isTripped(now = Date.now()): boolean {
    if (this.exhaustedUntil === null) return false;
    if (now >= this.exhaustedUntil) {
      this.reset();
      return false;
    }
    return true;
  }

  /** Record a quota failure and stop further attempts for `cooldownMs`. */
  trip(cooldownMs: number, reason: string, now = Date.now()): void {
    const until = now + Math.max(0, cooldownMs);
    // A second failure while already tripped should extend, never shorten,
    // the cooldown - it is new evidence the wall is still there.
    if (this.exhaustedUntil === null || until > this.exhaustedUntil) {
      this.exhaustedUntil = until;
    }
    this.reason = reason;
  }

  /** Clear the breaker early - used only by tests and manual recovery. */
  reset(): void {
    this.exhaustedUntil = null;
    this.reason = null;
  }

  status(now = Date.now()): QuotaBreakerStatus {
    const tripped = this.isTripped(now);
    return {
      tripped,
      reason: tripped ? this.reason : null,
      resetAt: tripped ? this.exhaustedUntil : null,
      msRemaining: tripped && this.exhaustedUntil ? this.exhaustedUntil - now : 0,
    };
  }
}
