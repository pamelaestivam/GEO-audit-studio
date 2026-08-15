/**
 * Checks for the retry-safety store (`src/idempotency.ts`).
 *
 * Regression: `apiFetch` retries a request whose connection stalls, which a
 * sleeping Render instance does routinely - but the retried request was a
 * POST that starts quota-spending work, and aborting the client's side does
 * not abort work the server already began. One click on "Run Audit" was
 * measured starting four concurrent audits and 16 real Gemini calls.
 *
 * `test/retrySpendE2E.test.ts` proves the end-to-end effect against the real
 * server. These checks pin the edges that are awkward to reach from there:
 * expiry, opting out, and not caching a failure.
 *
 * Run with: npx tsx test/idempotency.test.ts
 */

import { IdempotencyStore, newIdempotencyKey, readIdempotencyKey } from '../src/idempotency';

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

// ---------------------------------------------------------------- replay
{
  const store = new IdempotencyStore<string>(60_000);
  let created = 0;
  const create = () => `job-${++created}`;

  const first = store.run('k1', create, 0);
  const second = store.run('k1', create, 10);
  const third = store.run('k1', create, 20);

  check('the work runs exactly once for a repeated key', created, 1);
  check('every repeat gets the first result back', [second.value, third.value], [first.value, first.value]);
  check('the first call is not reported as a replay', first.replayed, false);
  check('a repeat is reported as a replay', second.replayed, true);
}

// ---------------------------------------------------------------- distinct keys
{
  const store = new IdempotencyStore<string>(60_000);
  let created = 0;
  const create = () => `job-${++created}`;

  store.run('click-a', create, 0);
  store.run('click-b', create, 0);
  // A second deliberate click is a second job. Collapsing those would turn a
  // user asking for the work again into a silent no-op.
  check('two different keys each do their own work', created, 2);
}

// ---------------------------------------------------------------- opting out
{
  const store = new IdempotencyStore<string>(60_000);
  let created = 0;
  const create = () => `job-${++created}`;

  // An older client bundle, or a direct API caller, sends no key. That must
  // behave exactly as it did before this store existed - every call runs.
  store.run(undefined, create, 0);
  store.run(undefined, create, 0);
  store.run('', create, 0);
  check('a missing or blank key never collapses requests', created, 3);
  check('un-keyed work is not stored', store.size(0), 0);
}

// ---------------------------------------------------------------- expiry
{
  const store = new IdempotencyStore<string>(1000);
  let created = 0;
  const create = () => `job-${++created}`;

  store.run('k', create, 0);
  store.run('k', create, 999);
  check('a key still inside its TTL replays', created, 1);

  store.run('k', create, 1001);
  check('a key past its TTL does the work again', created, 2);
  check('expired entries are dropped rather than accumulating', store.size(5000), 0);
}

// ---------------------------------------------------------------- forget
{
  const store = new IdempotencyStore<string>(60_000);
  let created = 0;
  const create = () => `job-${++created}`;

  store.run('k', create, 0);
  // The stored value for the in-flight endpoints is a promise. When it
  // rejects, the caller forgets the key: sharing an in-flight call is the
  // point, but replaying a *failure* for the rest of the TTL would deny the
  // user a real second attempt.
  store.forget('k');
  store.run('k', create, 1);
  check('a forgotten key does the work again on the next attempt', created, 2);
  assert('forgetting a key that was never stored is harmless', (() => {
    store.forget('never-seen');
    store.forget(undefined);
    return true;
  })());
}

// ---------------------------------------------------------------- header parsing
{
  check('a normal header value is read', readIdempotencyKey({ 'idempotency-key': 'abc' }), 'abc');
  check('surrounding whitespace is trimmed', readIdempotencyKey({ 'idempotency-key': '  abc  ' }), 'abc');
  check('a repeated header arriving as an array takes the first value', readIdempotencyKey({ 'idempotency-key': ['a', 'b'] }), 'a');
  check('a missing header reads as no key', readIdempotencyKey({}), undefined);
  check('absent headers do not throw', readIdempotencyKey(undefined), undefined);
  check('a blank header is treated as no key', readIdempotencyKey({ 'idempotency-key': '   ' }), undefined);
  check('a non-string header is ignored', readIdempotencyKey({ 'idempotency-key': 42 as any }), undefined);
  // The key is held in a Map for the whole TTL and arrives from the network,
  // so an unbounded one is a memory lever for anyone who can reach the API.
  check('an over-long key is rejected rather than stored', readIdempotencyKey({ 'idempotency-key': 'x'.repeat(201) }), undefined);
  check('a key at the length limit is accepted', readIdempotencyKey({ 'idempotency-key': 'x'.repeat(200) })?.length, 200);
}

// ---------------------------------------------------------------- key generation
{
  const keys = new Set(Array.from({ length: 500 }, () => newIdempotencyKey()));
  check('generated keys are unique across a burst', keys.size, 500);
  assert('generated keys are non-empty strings', Array.from(keys).every((k) => typeof k === 'string' && k.length > 0));
}

console.log(failures === 0 ? '\nAll idempotency checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
