/**
 * End-to-end proof that the circuit breaker stops the amplification that
 * caused repeated "quota exhausted" failures to keep recurring.
 *
 * This runs the actual built server (dist/server.cjs) against a fake Gemini
 * endpoint that always returns 429, and counts the real HTTP requests that
 * land on it. Before the breaker, one failed audit could retry each of ~6
 * call sites up to 3 times - 15-20+ requests against an already-exhausted
 * quota, taking minutes. This proves the number stays small and a second
 * audit, while still tripped, makes none at all.
 *
 * Run with: npx tsx test/quotaBreakerE2E.test.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import http from 'http';

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

const GEMINI_PORT = 3400 + Math.floor(Math.random() * 200);
const APP_PORT = 3600 + Math.floor(Math.random() * 200);
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const APP2_PORT = 3800 + Math.floor(Math.random() * 200);
const APP2_BASE = `http://127.0.0.1:${APP2_PORT}`;

/** A fake Gemini endpoint that always returns a per-minute 429, and counts hits. */
function startFakeGemini(): Promise<{ server: http.Server; hitCount: () => number; resetHitCount: () => void }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
        },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(GEMINI_PORT, () =>
      resolve({ server, hitCount: () => hits, resetHitCount: () => { hits = 0; } })
    );
  });
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runAudit(base: string, body: unknown, timeoutMs = 60000) {
  const startRes = await post(base, '/api/audit/run', body);
  const start = await startRes.json();
  if (!start.jobId) return { start, final: null as any };

  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${base}/api/audit/job/${start.jobId}`);
    const data = await res.json();
    if (data.status === 'running') continue;
    return { start, final: data };
  }
  return { start, final: null as any };
}

async function waitForServer(base: string, timeoutMs = 20000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const fakeGemini = await startFakeGemini();

  let appServer: ChildProcess | null = null;
  const t0 = Date.now();

  try {
    appServer = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'fake-key-for-e2e-quota-test',
        GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MAX_RETRIES: '2', // realistic default, to prove the breaker (not a low test-only cap) is what limits calls
        GEMINI_MIN_INTERVAL_MS: '0', // keep the test fast; pacing is a separate concern from the breaker
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      },
      stdio: 'ignore',
    });

    const up = await waitForServer(APP_BASE);
    assert('the app server starts against the fake Gemini endpoint', up);
    if (!up) return;

    // --- First audit: discovers the quota is exhausted.
    const first = await runAudit(APP_BASE, {
      businessName: 'Hyundai',
      domain: 'hyundai.com',
      industry: 'Car',
      competitors: ['Toyota', 'Nissan'],
    });

    assert('the first audit completes (degraded) rather than hanging', first.final !== null);
    check('the first audit is flagged degraded', first.final?.report?.degraded, true);
    assert(
      'the first audit reports a quota problem, not a generic error',
      /quota|rate limited/i.test(first.final?.report?.degradedReason || ''),
      first.final?.report?.degradedReason
    );

    const hitsAfterFirst = fakeGemini.hitCount();
    console.log(`  (fake Gemini received ${hitsAfterFirst} request(s) during the first audit)`);

    // The old behaviour: 6+ call sites (query generation, ~3 grounded
    // searches, vendor discovery, narrative) each retried up to 3 times would
    // put this well past 15. The breaker should trip on the very first 429
    // and stop the rest of the audit outright, so this should be small -
    // generously bounded at 5 to allow for the couple of calls that can
    // legitimately race before the breaker trips.
    assert(
      `the first audit made few requests to the exhausted quota, not 15+ (made ${hitsAfterFirst})`,
      hitsAfterFirst <= 5,
      `made ${hitsAfterFirst} requests`
    );

    const firstAuditDurationMs = Date.now() - t0;
    assert(
      `the first audit failed fast rather than hanging on retries (took ${Math.round(firstAuditDurationMs / 1000)}s)`,
      firstAuditDurationMs < 30000
    );

    // --- Second audit: the breaker should already be tripped process-wide,
    // so this should make ZERO further requests to Gemini.
    const t1 = Date.now();
    const second = await runAudit(APP_BASE, {
      businessName: 'Toyota',
      domain: 'toyota.com',
    });
    const secondAuditDurationMs = Date.now() - t1;

    assert('a second audit while still tripped also completes (degraded)', second.final !== null);
    check('a second audit while tripped is also flagged degraded', second.final?.report?.degraded, true);

    const hitsAfterSecond = fakeGemini.hitCount();
    check(
      'a second audit while the breaker is tripped makes zero further requests to Gemini',
      hitsAfterSecond,
      hitsAfterFirst
    );
    assert(
      `the second audit returned near-instantly, not after another retry cycle (took ${Math.round(secondAuditDurationMs / 1000)}s)`,
      secondAuditDurationMs < 10000
    );

    // --- Two audits fired concurrently (not sequentially, unlike above) can
    // both pass the breaker's entry check before either one's failure has
    // been recorded. generateContentWithRetry re-checks the breaker a
    // second time immediately before each queued call actually executes, to
    // close that window. Uses a second, freshly-spawned server so the
    // breaker starts clean rather than riding the already-tripped state
    // from the sequential checks above.
    let app2: ChildProcess | null = null;
    try {
      app2 = spawn('node', ['dist/server.cjs'], {
        env: {
          ...process.env,
          PORT: String(APP2_PORT),
          NODE_ENV: 'production',
          GEMINI_API_KEY: 'fake-key-for-e2e-quota-test-2',
          GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
          GEMINI_MAX_RETRIES: '2',
          GEMINI_MIN_INTERVAL_MS: '0',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
        },
        stdio: 'ignore',
      });
      const app2Up = await waitForServer(APP2_BASE);
      assert('the second server instance starts for the concurrency check', app2Up);

      if (app2Up) {
        fakeGemini.resetHitCount();
        const t2 = Date.now();
        const [concurrentA, concurrentB] = await Promise.all([
          runAudit(APP2_BASE, { businessName: 'Kia', domain: 'kia.com' }),
          runAudit(APP2_BASE, { businessName: 'Mazda', domain: 'mazda.com' }),
        ]);
        const concurrentDurationMs = Date.now() - t2;
        const hitsFromConcurrentPair = fakeGemini.hitCount();

        assert('both concurrent audits complete', concurrentA.final !== null && concurrentB.final !== null);
        assert(
          `a concurrent pair of audits still stays bounded, not 15+ (made ${hitsFromConcurrentPair})`,
          hitsFromConcurrentPair <= 6,
          `made ${hitsFromConcurrentPair} requests across two concurrent audits`
        );
        assert(
          `the concurrent pair did not each independently retry to exhaustion (took ${Math.round(concurrentDurationMs / 1000)}s)`,
          concurrentDurationMs < 30000
        );
      }
    } finally {
      app2?.kill();
    }

    // --- The status endpoint should reflect the tripped breaker, so the
    // frontend can warn before a user even fills out the form.
    const statusRes = await fetch(`${APP_BASE}/api/audit/status`);
    const status = await statusRes.json();
    check('the status endpoint reports quota unavailable', status.quota?.available, false);
    assert('the status endpoint gives a readable reason', typeof status.quota?.reason === 'string' && status.quota.reason.length > 0, JSON.stringify(status));
    assert('the status endpoint gives a reset time', typeof status.quota?.resetAt === 'string', JSON.stringify(status));
  } finally {
    appServer?.kill();
    fakeGemini.server.close();
  }

  console.log(failures === 0 ? '\nAll quota breaker E2E checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E test harness error:', err);
  process.exit(1);
});
