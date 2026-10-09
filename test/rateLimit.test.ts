/**
 * Pure unit checks for the per-IP request limiter. Run: npx tsx test/rateLimit.test.ts
 */
import { FixedWindowLimiter } from '../src/rateLimit';

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

const T0 = 1_000_000;

{
  const l = new FixedWindowLimiter(3, 60_000);
  check('the first request is allowed', l.check('a', T0).allowed, true);
  check('up to the limit is allowed (2)', l.check('a', T0 + 1).allowed, true);
  check('up to the limit is allowed (3)', l.check('a', T0 + 2).allowed, true);
  const blocked = l.check('a', T0 + 3);
  check('the request over the limit is refused', blocked.allowed, false);
  check('the refusal says how long to wait', blocked.retryAfterSeconds, 60);
  check('a refused request does not extend the window', l.check('a', T0 + 30_000).retryAfterSeconds, 30);
}

{
  const l = new FixedWindowLimiter(1, 10_000);
  l.check('a', T0);
  check('a different key is counted separately', l.check('b', T0).allowed, true);
  check('the first key is still blocked', l.check('a', T0 + 1).allowed, false);
  check('the window resets after it elapses', l.check('a', T0 + 10_000).allowed, true);
}

{
  const l = new FixedWindowLimiter(1, 1_000);
  for (let i = 0; i < 50; i++) l.check(`ip-${i}`, T0);
  check('keys accumulate within the window', l.size(T0), 50);
  check('expired keys are pruned, not kept forever', l.size(T0 + 1_000), 0);
}

{
  const l = new FixedWindowLimiter(2, 5_000);
  check('retryAfterSeconds is never below 1', (l.check('a', T0), l.check('a', T0), l.check('a', T0 + 4_999).retryAfterSeconds), 1);
}

{
  // An attacker rotating keys must not make every request scan every key, and
  // must not grow memory without bound.
  const l = new FixedWindowLimiter(5, 60_000);
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) l.check(`spoof-${i}`, T0);
  check('many distinct keys are all tracked up to the cap', l.size(T0), 20_000);
  for (let i = 20_000; i < 60_000; i++) l.check(`spoof-${i}`, T0);
  check('memory is bounded: past the cap, new keys are refused rather than stored', l.size(T0) <= 50_000, true);
  check('a key that cannot be tracked is refused (fails closed)', l.check('one-more', T0).allowed, false);
  check('tracked keys keep working', l.check('spoof-1', T0).allowed, true);
  check('the sweep is not O(keys) per request: 60k checks finished quickly', Date.now() - t0 < 4000, true);
}

console.log(failures === 0 ? '\nAll rate limiter checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
