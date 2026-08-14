/**
 * Checks for the quota circuit breaker (src/quotaBreaker.ts) and the cooldown
 * math behind it (src/errors.ts).
 *
 * Regression: a quota-exhausted audit retried every Gemini call site
 * independently (query generation, one grounded search per query, vendor
 * discovery, narrative - 6+ calls), each with its own retry loop, so a
 * single failed audit could hit an already-exhausted quota 15-20 times and
 * take minutes before finally showing an error. Every one of those calls was
 * rediscovering the same wall. These checks pin the breaker's actual job:
 * discover it once, then refuse instantly - no network call, no wait - until
 * the cooldown elapses.
 *
 * Run with: npx tsx test/quotaBreaker.test.ts
 */

import { QuotaBreaker } from '../src/quotaBreaker';
import {
  computeQuotaCooldownMs,
  describeProviderError,
  formatDuration,
  isDailyQuotaError,
  msUntilNextUtcMidnight,
} from '../src/errors';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`pass  ${name}`);
  }
}
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

// ---------------------------------------------------------------- breaker core behaviour
{
  const breaker = new QuotaBreaker();
  const t0 = 1_000_000;

  check('a fresh breaker is not tripped', breaker.isTripped(t0), false);

  breaker.trip(30_000, 'Gemini is rate limited on the free tier.', t0);
  check('tripping makes it tripped', breaker.isTripped(t0), true);
  check('status reports the reason while tripped', breaker.status(t0).reason, 'Gemini is rate limited on the free tier.');
  check('status reports remaining time', breaker.status(t0).msRemaining, 30_000);

  check('still tripped just before the cooldown ends', breaker.isTripped(t0 + 29_999), true);
  check('auto-clears exactly at the cooldown boundary', breaker.isTripped(t0 + 30_000), false);
  check('status reflects the auto-clear', breaker.status(t0 + 30_000).reason, null);
}

// A second failure while already tripped must extend, never shorten, the
// cooldown - it is confirming evidence the wall is still there, not a reason
// to trust it less.
{
  const breaker = new QuotaBreaker();
  const t0 = 2_000_000;
  breaker.trip(60_000, 'first failure', t0);
  breaker.trip(10_000, 'second failure, shorter', t0 + 5_000); // would end at t0+15000, earlier than t0+60000
  check('a shorter re-trip does not shorten the cooldown', breaker.status(t0 + 5_000).msRemaining, 55_000);

  breaker.trip(120_000, 'third failure, longer', t0 + 5_000); // would end at t0+125000, later
  check('a longer re-trip does extend the cooldown', breaker.status(t0 + 5_000).msRemaining, 120_000);
}

check('reset() clears an active trip', (() => {
  const breaker = new QuotaBreaker();
  breaker.trip(60_000, 'x', 0);
  breaker.reset();
  return breaker.isTripped(0);
})(), false);

// ---------------------------------------------------------------- cooldown computation
check(
  'a per-minute quota error uses the provider-suggested delay',
  computeQuotaCooldownMs('{"error":{"details":[{"retryDelay":"36s"}]}}'),
  36_000
);
check(
  'a missing retryDelay falls back to a sane default, not zero',
  computeQuotaCooldownMs('{"error":{"code":429,"message":"exceeded quota"}}'),
  60_000
);
check(
  'a very short suggested delay is floored so it cannot thrash',
  computeQuotaCooldownMs('{"error":{"details":[{"retryDelay":"2s"}]}}'),
  30_000
);

check('"daily" in prose is detected as a daily quota', isDailyQuotaError('You have hit your daily limit'), true);
check(
  'the PerDay quota id form is detected without the word "daily"',
  isDailyQuotaError('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
  true
);
check('a per-minute id is not mistaken for a daily one', isDailyQuotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), false);

{
  const now = Date.UTC(2026, 0, 15, 22, 30, 0); // 2026-01-15 22:30:00 UTC
  const expected = Date.UTC(2026, 0, 16, 0, 0, 0) - now; // 1h30m to next midnight
  check('daily cooldown runs to the next UTC midnight, not a fixed 24h', msUntilNextUtcMidnight(now), expected);
  check(
    'a daily-quota error cooldown matches time-to-midnight, not the provider retryDelay',
    computeQuotaCooldownMs('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier, retryDelay: "5s"', now),
    expected
  );
}

// ---------------------------------------------------------------- duration formatting
check('formatDuration renders hours and minutes', formatDuration(4 * 3600_000 + 12 * 60_000), '4h 12m');
check('formatDuration renders minutes and seconds under an hour', formatDuration(90_000), '1m 30s');
check('formatDuration renders bare seconds under a minute', formatDuration(45_000), '45s');
check('formatDuration floors negative/zero to 0s rather than throwing', formatDuration(-5), '0s');

// ---------------------------------------------------------------- message classification end to end
{
  const perMinute = describeProviderError(
    '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"36s"}]}}',
    'Gemini'
  );
  check('a per-minute quota error classifies as quota, not daily', perMinute.isDailyQuota, false);
  assert('a per-minute message names a concrete wait, not "24 hours"', /36s|retry automatically/.test(perMinute.message), perMinute.message);

  const daily = describeProviderError('RESOURCE_EXHAUSTED: quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'Gemini');
  check('a daily quota error is classified as daily', daily.isDailyQuota, true);
  assert('a daily message says midnight UTC, not a generic "24 hours"', /midnight utc/i.test(daily.message), daily.message);
}

// A QuotaExhaustedError-shaped object (name === 'QuotaExhaustedError', as
// thrown by the breaker in server.ts) must pass through untouched rather
// than being re-parsed as if it were raw provider JSON - the actual bug this
// module was patched for while wiring in the breaker.
{
  class FakeQuotaExhaustedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'QuotaExhaustedError';
    }
  }
  const breakerMessage = "Gemini's daily free-tier quota is exhausted. It resets at midnight UTC (in 4h 12m).";
  const described = describeProviderError(new FakeQuotaExhaustedError(breakerMessage), 'Gemini');
  check('a breaker refusal is returned verbatim, not re-mangled', described.message, breakerMessage);
  check('a breaker refusal classifies as quota', described.kind, 'quota');

  // The same message, but stringified first (as happens once it lands in a
  // plain `.error` field on captured evidence) - the instanceof check cannot
  // see it any more, so the phrase-matching fallback must catch it instead.
  const describedFromString = describeProviderError(breakerMessage, 'Gemini');
  check('a stringified breaker refusal is still classified as quota, not "unknown"', describedFromString.kind, 'quota');
  assert('a stringified breaker refusal is not corrupted by re-parsing', describedFromString.message === breakerMessage, describedFromString.message);
}

console.log(failures === 0 ? '\nAll quota breaker checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
