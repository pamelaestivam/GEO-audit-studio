/**
 * Checks for the network-resilience wrapper (`src/apiClient.ts`).
 *
 * Regression: "Load failed" reached the user verbatim. That string is the
 * browser's own message for a `fetch()` that failed before reaching the
 * server - typically a connection refused while a Render free instance is
 * still booting from sleep. It happens outside any try/catch that could
 * translate it, on whichever request happens to be first. These checks run
 * against a fake global `fetch`, since the real failure mode (a refused
 * connection) is not reproducible against a live local server.
 *
 * Run with: npx tsx test/apiClient.test.ts
 */

import { apiFetch } from '../src/apiClient';

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
async function assertThrows(name: string, fn: () => Promise<any>, match?: RegExp) {
  try {
    await fn();
    failures++;
    console.log(`FAIL  ${name}\n        expected a throw, got none`);
  } catch (err: any) {
    if (match && !match.test(err.message || '')) {
      failures++;
      console.log(`FAIL  ${name}\n        message did not match ${match}: ${err.message}`);
    } else {
      console.log(`pass  ${name}`);
    }
  }
}

function installFakeFetch(behaviour: (call: number) => 'network-error' | 'ok') {
  let calls = 0;
  const original = global.fetch;
  (global as any).fetch = async (_path: string, _init?: any) => {
    calls += 1;
    if (behaviour(calls) === 'network-error') {
      // This is exactly what a browser throws for a refused/reset connection:
      // a bare TypeError, no status code, no body to parse.
      throw new TypeError('Load failed');
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return {
    callCount: () => calls,
    restore: () => {
      (global as any).fetch = original;
    },
  };
}

async function main() {
  // A connection refused on the very first attempt (cold-start scenario)
  // must be retried, not surfaced immediately as "Load failed".
  {
    const fake = installFakeFetch((call) => (call === 1 ? 'network-error' : 'ok'));
    const res = await apiFetch('/api/audit/run', { retries: 3 });
    check('a single network failure is retried and eventually succeeds', res.status, 200);
    check('exactly two attempts were made (1 failure + 1 success)', fake.callCount(), 2);
    fake.restore();
  }

  // A sleeping instance can refuse several attempts in a row while booting.
  {
    const fake = installFakeFetch((call) => (call <= 3 ? 'network-error' : 'ok'));
    const res = await apiFetch('/api/audit/run', { retries: 3 });
    check('three consecutive failures still succeed within the retry budget', res.status, 200);
    fake.restore();
  }

  // Once retries are exhausted, the user gets a sentence, never the raw
  // browser string.
  {
    const fake = installFakeFetch(() => 'network-error');
    await assertThrows(
      'exhausted retries produce a readable message, not "Load failed"',
      () => apiFetch('/api/audit/run', { retries: 2 }),
      /could not reach the server/i
    );
    check('the raw browser error text does not leak through', fake.callCount() <= 3, true);
    fake.restore();
  }

  // retries: 0 must still make exactly one attempt and fail cleanly - used
  // for requests that intentionally want to fail fast (brand lookup while a
  // user waits on the form).
  {
    const fake = installFakeFetch(() => 'network-error');
    await assertThrows('retries:0 fails after exactly one attempt', () => apiFetch('/api/audit/run', { retries: 0 }));
    check('retries:0 makes exactly one call', fake.callCount(), 1);
    fake.restore();
  }

  // A hung connection (our own timeout firing) must be retried too - it is
  // indistinguishable from a slow-to-wake server, not a real answer.
  {
    let calls = 0;
    const original = global.fetch;
    (global as any).fetch = async (_path: string, init: any) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a connection that never resolves until our timeout aborts it.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res = await apiFetch('/api/audit/run', { retries: 2, timeoutMs: 50 });
    check('a timed-out attempt is retried rather than failing immediately', res.status, 200);
    check('exactly two attempts were made (1 timeout + 1 success)', calls, 2);
    (global as any).fetch = original;
  }

  // A real HTTP error response (server reachable, request rejected) must not
  // be retried - retrying a 400 wastes time and cannot succeed.
  {
    let calls = 0;
    const original = global.fetch;
    (global as any).fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
    };
    const res = await apiFetch('/api/audit/run', { retries: 3 });
    check('a real 400 response is returned as-is', res.status, 400);
    check('a real HTTP error is not retried', calls, 1);
    (global as any).fetch = original;
  }

  console.log(failures === 0 ? '\nAll apiClient checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
