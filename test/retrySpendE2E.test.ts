/**
 * End-to-end proof that a retried request costs what one request costs, and
 * that a transient per-minute rate limit no longer destroys an audit.
 *
 * Regression, reported from a real browser: "This was the first use of the
 * day. It should not have hit the wall so quick." Two separate defects put
 * that banner on screen, both measured against the real built server before
 * being fixed:
 *
 *  1. `src/apiClient.ts` retries any request whose connection fails or hangs,
 *     which is correct for a sleeping Render instance - but an aborted client
 *     request does not abort work the server already started. One click on
 *     "Run Audit" against a cold instance produced four concurrent audits and
 *     **16 real Gemini calls**, on a free tier documented at 10 requests per
 *     minute. The first use of the day is precisely when the instance is
 *     asleep, so it is the run most likely to be quadrupled.
 *
 *  2. A single 429 whose own payload said "retry in 5s" tripped the circuit
 *     breaker, abandoned the audit after exactly **one** Gemini call, and
 *     returned a report of zeros - then told the user it would "retry
 *     automatically in 1m 0s", which nothing did.
 *
 * Both are counted here against `dist/server.cjs` and a fake Gemini endpoint,
 * not asserted about mocks of our own code.
 *
 * Run with: npx tsx test/retrySpendE2E.test.ts
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

const GEMINI_PORT = 3900 + Math.floor(Math.random() * 100);
const APP_PORT = 4000 + Math.floor(Math.random() * 100);
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

/** How many 429s the fake endpoint should serve before it starts succeeding. */
let rateLimitedCallsRemaining = 0;
/** The `retryDelay` the fake endpoint states in those 429s. */
let statedRetryDelay = '3s';

function geminiSuccessBody(text: string) {
  return JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text }], role: 'model' },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://g2.com/reviews/example', title: 'g2.com' } }],
          webSearchQueries: ['example query'],
        },
        finishReason: 'STOP',
      },
    ],
  });
}

function startFakeGemini(): Promise<{ server: http.Server; hits: () => number; reset: () => void }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits += 1;

      if (rateLimitedCallsRemaining > 0) {
        rateLimitedCallsRemaining -= 1;
        // Shaped like a real Gemini per-minute refusal: a quota id naming
        // PerMinute (not PerDay) and a RetryInfo stating the wait.
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Quota exceeded for quota metric generate_content_free_tier_requests',
              status: 'RESOURCE_EXHAUSTED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                  violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
                },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: statedRetryDelay },
              ],
            },
          })
        );
        return;
      }

      const wantsJson = body.includes('"responseMimeType":"application/json"') || body.includes('responseSchema');
      const text = wantsJson
        ? JSON.stringify({
            businessName: 'Walmart',
            domain: 'walmart.com',
            industry: 'Supermarket',
            coreOfferings: 'Groceries',
            targetAudience: 'Shoppers',
            competitors: ['Target'],
            executiveSummary: 'Walmart appears in some answers.',
            inaccuracies: [],
            omissions: [],
            remediationPlan: [],
          })
        : 'Walmart is a solid choice for groceries. Target is also popular for this.';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(geminiSuccessBody(text));
    });
  });
  return new Promise((resolve) => {
    server.listen(GEMINI_PORT, () =>
      resolve({
        server,
        hits: () => hits,
        reset: () => {
          hits = 0;
        },
      })
    );
  });
}

function post(path: string, body: unknown, idempotencyKey?: string) {
  return fetch(`${APP_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function pollJob(jobId: string, timeoutMs = 120000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${APP_BASE}/api/audit/job/${jobId}`);
    const data = await res.json();
    if (data.status === 'running') continue;
    return data;
  }
  return null;
}

async function waitForServer(timeoutMs = 20000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(`${APP_BASE}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const AUDIT_BODY = {
  businessName: 'Walmart',
  domain: 'walmart.com',
  industry: 'Supermarket',
  competitors: ['Target'],
};

async function main() {
  const fakeGemini = await startFakeGemini();
  let appServer: ChildProcess | null = null;

  try {
    appServer = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'fake-key-for-retry-spend-test',
        GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MIN_INTERVAL_MS: '0', // pacing is a separate concern; keep the test fast
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      },
      stdio: 'ignore',
    });

    const up = await waitForServer();
    assert('the app server starts against the fake Gemini endpoint', up);
    if (!up) return;

    // ---------------------------------------------------------------- 1
    // One click, delivered four times because the connection kept stalling.
    // This is exactly what apiFetch does against a waking Render instance:
    // same body, same key, up to four attempts.
    {
      fakeGemini.reset();
      const key = 'test-key-single-click';
      const responses = [];
      for (let i = 0; i < 4; i++) responses.push(await (await post('/api/audit/run', AUDIT_BODY, key)).json());

      const jobIds = responses.map((r: any) => r.jobId);
      assert('every retried submit is answered with a job id', jobIds.every(Boolean), JSON.stringify(responses));
      check('four retries of one click produce ONE audit, not four', new Set(jobIds).size, 1);

      const final = await pollJob(jobIds[0]);
      assert('the single audit completes', final !== null);
      assert('the single audit is not degraded', final?.report?.degraded !== true, JSON.stringify(final?.report?.degradedReason));

      const queriesTested = final?.report?.queriesTested?.length || 0;
      // One grounded search per templated query, plus one narrative call -
      // the budget quotaEfficiencyE2E pins for a single audit. The measured
      // number before this fix was 16.
      check(
        'one click costs one audit of quota however many times it was retried',
        fakeGemini.hits(),
        queriesTested + 1
      );
    }

    // ---------------------------------------------------------------- 2
    // A deliberate second click is a second audit. The guard must collapse
    // retries, never a user asking for the work again.
    {
      const before = fakeGemini.hits();
      const first = await (await post('/api/audit/run', AUDIT_BODY, 'test-key-click-a')).json();
      const second = await (await post('/api/audit/run', AUDIT_BODY, 'test-key-click-b')).json();
      assert('two distinct clicks start two distinct audits', first.jobId !== second.jobId);
      await pollJob(first.jobId);
      await pollJob(second.jobId);
      assert('two clicks genuinely cost two audits', fakeGemini.hits() > before, 'no calls were made at all');
    }

    // ---------------------------------------------------------------- 3
    // A client that sends no key behaves exactly as before - the guard must
    // not silently swallow a legitimate request from an older bundle.
    {
      const a = await (await post('/api/audit/run', AUDIT_BODY)).json();
      const b = await (await post('/api/audit/run', AUDIT_BODY)).json();
      assert('requests without an idempotency key are never collapsed together', a.jobId !== b.jobId);
      await pollJob(a.jobId);
      await pollJob(b.jobId);
    }

    // ---------------------------------------------------------------- 4
    // Brand lookup: the same retried click must not buy several lookups.
    {
      fakeGemini.reset();
      const key = 'test-key-lookup';
      await Promise.all([
        post('/api/audit/parse-url', { input: 'Walmart' }, key).then((r) => r.json()),
        post('/api/audit/parse-url', { input: 'Walmart' }, key).then((r) => r.json()),
        post('/api/audit/parse-url', { input: 'Walmart' }, key).then((r) => r.json()),
      ]);
      check('three retries of one Auto-Detect click cost one Gemini call', fakeGemini.hits(), 1);
    }

    // ---------------------------------------------------------------- 5
    // A single transient per-minute 429 must be waited out, not treated as
    // an exhausted day. Before this fix the audit stopped dead here with one
    // call made and a report of zeros.
    {
      fakeGemini.reset();
      rateLimitedCallsRemaining = 1;
      statedRetryDelay = '3s';

      const started = Date.now();
      const { jobId } = await (await post('/api/audit/run', AUDIT_BODY, 'test-key-transient')).json();
      const final = await pollJob(jobId);
      const elapsed = Date.now() - started;

      assert('an audit interrupted by one rate limit still completes', final !== null);
      assert(
        'a transient rate limit no longer degrades the whole audit',
        final?.report?.degraded !== true,
        JSON.stringify(final?.report?.degradedReason)
      );
      assert(
        'evidence was genuinely collected rather than zeroed out',
        (final?.report?.observationsWithEvidence || 0) > 0,
        `observationsWithEvidence=${final?.report?.observationsWithEvidence}`
      );
      assert(
        'the provider-stated 3s wait was actually honoured, not ignored',
        elapsed >= 3000,
        `completed in ${elapsed}ms, which is faster than the wait the provider asked for`
      );

      const status = await (await fetch(`${APP_BASE}/api/audit/status`)).json();
      check('a survived rate limit does not leave the breaker latched', status.quota.available, true);
    }

    // ---------------------------------------------------------------- 6
    // Brand lookup runs while the user is sitting on the form, and passes
    // maxRetries=0 for exactly that reason: a back-off there is what produced
    // "Brand lookup could not be reached". Riding out a rate limit must not
    // leak into that call site and freeze the form for 20 seconds.
    {
      fakeGemini.reset();
      rateLimitedCallsRemaining = 1;
      statedRetryDelay = '15s';

      const started = Date.now();
      const res = await post('/api/audit/parse-url', { input: 'Walmart' }, 'test-key-lookup-fastfail');
      const data = await res.json();
      const elapsed = Date.now() - started;

      assert(
        'a rate-limited brand lookup still fails fast rather than pausing the form',
        elapsed < 5000,
        `took ${elapsed}ms, but the call site asked to fail fast`
      );
      check('one rate-limited lookup makes one call, not a retry', fakeGemini.hits(), 1);
      check('the typed name is kept rather than guessed at', data?.details?.businessName, 'Walmart');
      check('a failed lookup is reported as not detected', data?.detected, false);
      assert(
        'the reason given is a sentence, not provider JSON',
        typeof data?.reason === 'string' && !data.reason.includes('{'),
        data?.reason
      );

      rateLimitedCallsRemaining = 0;
    }
    // ---------------------------------------------------------------- 7
    // Persistent rate limiting is still a wall: one wait, then stop. The
    // breaker must not become a retry loop, which is the amplification it
    // was built to prevent.
    {
      fakeGemini.reset();
      rateLimitedCallsRemaining = 99;
      statedRetryDelay = '2s';

      const { jobId } = await (await post('/api/audit/run', AUDIT_BODY, 'test-key-persistent')).json();
      const final = await pollJob(jobId);

      assert('a persistent rate limit still ends the audit rather than hanging', final !== null);
      check('a persistently rate-limited audit is flagged degraded', final?.report?.degraded, true);
      assert(
        'it gives up after one wait rather than retrying at every call site',
        fakeGemini.hits() <= 3,
        `made ${fakeGemini.hits()} calls against a wall`
      );
      assert(
        'the degraded reason is a sentence, not provider JSON',
        typeof final?.report?.degradedReason === 'string' &&
          !final.report.degradedReason.includes('{') &&
          !final.report.degradedReason.includes('RESOURCE_EXHAUSTED'),
        final?.report?.degradedReason
      );
      assert(
        'the user is never promised an automatic retry that will not happen',
        !/retry automatically/i.test(final?.report?.degradedReason || ''),
        final?.report?.degradedReason
      );

      rateLimitedCallsRemaining = 0;
    }

  } finally {
    appServer?.kill();
    fakeGemini.server.close();
  }

  console.log(failures === 0 ? '\nAll retry-spend checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Retry-spend test harness error:', err);
  process.exit(1);
});
