/**
 * Proves the actual call budget of a real audit against a *succeeding* fake
 * Gemini endpoint - not the always-429 fake server used by
 * quotaBreakerE2E.test.ts. That file proves failures don't amplify; this
 * file proves success doesn't overspend in the first place.
 *
 * Regression: "I searched a single query, it should not get that much
 * calls." Before this change, one audit could cost up to 7 Gemini calls -
 * brand lookup (fired automatically, not opt-in), LLM query generation
 * (even though a free deterministic template already existed), one grounded
 * search per query, an LLM vendor-discovery call (which re-verified every
 * name against the source text anyway, so the model step added nothing),
 * and narrative synthesis. Query generation and vendor discovery are now
 * free (template text / text extraction); brand lookup is opt-in only.
 *
 * Run with: npx tsx test/quotaEfficiencyE2E.test.ts
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

const GEMINI_PORT = 3500 + Math.floor(Math.random() * 200);
const APP_PORT = 3700 + Math.floor(Math.random() * 200);
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

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

/** A fake Gemini endpoint that always succeeds, and counts + logs every hit. */
function startFakeGemini(): Promise<{ server: http.Server; hitCount: () => number; paths: () => string[] }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      paths.push(req.url || '');
      const wantsJson = body.includes('"responseMimeType":"application/json"') || body.includes('responseSchema');
      const text = wantsJson
        ? JSON.stringify({
            businessName: 'Example Co',
            domain: 'example.com',
            industry: 'Software',
            coreOfferings: 'Widgets',
            targetAudience: 'Buyers',
            competitors: ['RivalCo'],
            executiveSummary: 'Example Co appears in some answers.',
            inaccuracies: [],
            omissions: [],
            remediationPlan: [],
            vendors: ['RivalCo'],
          })
        : 'Example Co is a solid choice. RivalCo is also popular for this use case.';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(geminiSuccessBody(text));
    });
  });
  return new Promise((resolve) => {
    server.listen(GEMINI_PORT, () => resolve({ server, hitCount: () => paths.length, paths: () => paths }));
  });
}

function post(path: string, body: unknown) {
  return fetch(`${APP_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runAudit(body: unknown, timeoutMs = 60000) {
  const startRes = await post('/api/audit/run', body);
  const start = await startRes.json();
  if (!start.jobId) return { start, final: null as any };

  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${APP_BASE}/api/audit/job/${start.jobId}`);
    const data = await res.json();
    if (data.status === 'running') continue;
    return { start, final: data };
  }
  return { start, final: null as any };
}

async function waitForServer(timeoutMs = 20000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${APP_BASE}/api/health`);
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

  try {
    appServer = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'fake-key-for-efficiency-test',
        GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MIN_INTERVAL_MS: '0',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      },
      stdio: 'ignore',
    });

    const up = await waitForServer();
    assert('the app server starts against the fake success endpoint', up);
    if (!up) return;

    // --- A genuine single-query audit: the user typed one query themselves
    // and did not click "Auto-Detect". This is the exact scenario reported:
    // "I searched a single query, it should not get that many calls."
    const single = await runAudit({
      businessName: 'Example Co',
      domain: 'example.com',
      industry: 'Software',
      competitors: ['RivalCo'],
      queries: [
        { id: 'q1', intent: 'direct_recommendation', queryText: 'best widget provider', targetPersona: 'Buyer' },
      ],
    });

    assert('the single-query audit completes successfully', single.final !== null);
    assert('the single-query audit is not degraded', single.final?.report?.degraded !== true, JSON.stringify(single.final?.report?.degradedReason));
    check('exactly one query was tested, matching what was supplied', single.final?.report?.queriesTested?.length, 1);

    const hitsForSingleQuery = fakeGemini.hitCount();
    console.log(`  (a single-query audit made ${hitsForSingleQuery} real Gemini call(s): ${JSON.stringify(fakeGemini.paths())})`);

    // Exactly 2: one grounded search for the one query, one narrative call.
    // No query-generation call (the user supplied the query), no
    // vendor-discovery call (pure text extraction now), no brand-lookup call
    // (not clicked). This is the number that was 6-7 before this change.
    check('a single-query audit costs exactly 2 Gemini calls (evidence + narrative)', hitsForSingleQuery, 2);

    // --- The default case: user supplies no query text at all, relying on
    // the auto-generated set. Query generation itself must still be free.
    const defaultQueries = await runAudit({
      businessName: 'Example Co',
      domain: 'example.com',
      industry: 'Software',
    });

    assert('an audit with no supplied queries still completes', defaultQueries.final !== null);
    const totalHitsAfterDefault = fakeGemini.hitCount();
    const hitsForDefaultAudit = totalHitsAfterDefault - hitsForSingleQuery;
    const queriesTestedCount = defaultQueries.final?.report?.queriesTested?.length || 0;
    console.log(
      `  (the default-query audit tested ${queriesTestedCount} template queries using ${hitsForDefaultAudit} real Gemini call(s))`
    );

    // One grounded search per templated query, plus one narrative call.
    // Critically: NOT queriesTestedCount + 2, which is what an LLM call to
    // author the queries would have added on top.
    check(
      'query generation itself adds zero Gemini calls - cost is exactly one call per templated query plus narrative',
      hitsForDefaultAudit,
      queriesTestedCount + 1
    );

    // --- Brand lookup costs exactly one call, and only when explicitly
    // invoked - the exact totals asserted above already prove neither audit
    // triggered it as a side effect; this proves the explicit path itself is
    // real and correctly costs one call, not zero and not several.
    const hitsBeforeLookup = fakeGemini.hitCount();
    const lookupRes = await post('/api/audit/parse-url', { input: 'Example Co' });
    await lookupRes.json();
    const hitsAfterLookup = fakeGemini.hitCount();
    check('the explicit brand-lookup endpoint costs exactly one Gemini call', hitsAfterLookup - hitsBeforeLookup, 1);
  } finally {
    appServer?.kill();
    fakeGemini.server.close();
  }

  console.log(failures === 0 ? '\nAll quota efficiency checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Efficiency test harness error:', err);
  process.exit(1);
});
