/**
 * End-to-end proof, against the real built server (dist/server.cjs) and a fake
 * Gemini endpoint, of the MVP-hardening fixes. Each check maps to a defect
 * observed in a real browser run of the previous build:
 *
 *  - vendor discovery turned capitalised filler ("Pricing", "Key", "Monday")
 *    into rivals and divided the client's share of voice by 16 instead of 3;
 *  - a failed narrative step was reported as "100% accuracy, 0 inaccuracies";
 *  - a failed audit shipped a placeholder Schema.org remediation task, a
 *    made-up omission, and every engine marked "omitted" (a finding);
 *  - blank offerings/audience were filled with guessed text;
 *  - raw provider JSON could reach the report through evidence errors;
 *  - nothing limited how many requests, or concurrent audits, one client could
 *    start against a shared quota.
 *
 * Needs a current dist/. Run: npx tsx test/mvpHardeningE2E.test.ts
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

const GEMINI_PORT = 4100 + Math.floor(Math.random() * 100);
let nextAppPort = 4300 + Math.floor(Math.random() * 300);

type Mode = 'ok' | 'narrative_fails' | 'unauthorized' | 'slow';
let mode: Mode = 'ok';

const MARKDOWN_ANSWER = `For poke in Austin, top picks are:

* **Pokeworks** - consistently rated highest.
* **Sweetfin** - great vegan bowls.
* **Poke House** - solid fresh fish.

According to Yelp and TripAdvisor, Pricing starts at $12. Key takeaways: Fresh fish matters. Why choose Pokeworks? Check Monday hours.`;

function geminiSuccessBody(text: string) {
  return JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text }], role: 'model' },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://yelp.com/biz/x', title: 'yelp.com' } }],
          webSearchQueries: ['poke austin'],
        },
        finishReason: 'STOP',
      },
    ],
  });
}

function startFakeGemini(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const wantsJson = body.includes('responseSchema');
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 2500));
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid. SECRET_PAYLOAD_MARKER', status: 'UNAUTHENTICATED' } }));
        return;
      }
      if (mode === 'narrative_fails' && wantsJson) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 500, message: 'internal SECRET_PAYLOAD_MARKER', status: 'INTERNAL' } }));
        return;
      }
      const text = wantsJson
        ? JSON.stringify({ executiveSummary: 'Narrative ok.', inaccuracies: [], omissions: [], remediationPlan: [] })
        : MARKDOWN_ANSWER;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(geminiSuccessBody(text));
    });
  });
  return new Promise((resolve) => server.listen(GEMINI_PORT, () => resolve(server)));
}

interface App {
  base: string;
  proc: ChildProcess;
}

async function startApp(extraEnv: Record<string, string> = {}): Promise<App | null> {
  const port = nextAppPort++;
  const proc = spawn('node', ['dist/server.cjs'], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      GEMINI_API_KEY: 'fake-key',
      GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
      GEMINI_MIN_INTERVAL_MS: '0',
      RATE_LIMIT_PER_MIN: '0',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      OPENAI_API_KEY: '',
      PERPLEXITY_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, proc };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  return null;
}

function post(app: App, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function runAudit(app: App, body: unknown, timeoutMs = 60000) {
  const startRes = await post(app, '/api/audit/run', body);
  const start = await startRes.json();
  if (!start.jobId) return { start, final: null as any };
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const data = await (await fetch(`${app.base}/api/audit/job/${start.jobId}`)).json();
    if (data.status === 'running') continue;
    return { start, final: data };
  }
  return { start, final: null as any };
}

const POKE = {
  businessName: 'Poke House',
  domain: 'poke.house',
  queries: [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }],
};

async function main() {
  const fake = await startFakeGemini();
  const procs: ChildProcess[] = [];

  try {
    // ------------------------------------------------------------------
    // Server A: no rate limiting, default concurrency.
    // ------------------------------------------------------------------
    const A = await startApp();
    assert('server A starts', !!A);
    if (!A) return;
    procs.push(A.proc);

    // --- Vendor discovery and the share-of-voice denominator -------------
    mode = 'ok';
    const ok = await runAudit(A, POKE);
    const report = ok.final?.report;
    assert('a normal audit completes and is not degraded', !!report && report.degraded !== true, JSON.stringify(report?.degradedReason));

    const rivalNames = (report?.competitorBenchmarks || []).map((b: any) => b.name.replace(' (Your Business)', ''));
    check(
      'only the real vendors are scored (client + the two named rivals)',
      [...rivalNames].sort(),
      ['Pokeworks', 'Poke House', 'Sweetfin'].sort()
    );
    check('capitalised filler is not reported as a rival', report?.untrackedRivals?.slice().sort(), ['Pokeworks', 'Sweetfin']);
    check('share of voice is 1 of 3 vendors, not 1 of 16', report?.shareOfVoice, 33);
    check('the visibility numerator is reported, so the UI can show "1 of 1"', report?.observationsMentioned, 1);
    check('the visibility denominator is reported', report?.observationsWithEvidence, 1);

    // --- Blank optional fields stay blank, never guessed ------------------
    check('blank core offerings stay blank', report?.coreOfferings, '');
    check('blank target audience stays blank', report?.targetAudience, '');
    check('the qualitative analysis is marked as having run', report?.narrativeAvailable, true);

    // --- Narrative failure must not read as "100% accurate" ---------------
    mode = 'narrative_fails';
    const nf = await runAudit(A, POKE);
    const nfReport = nf.final?.report;
    assert('an audit whose narrative failed still returns the measured evidence', !!nfReport && nfReport.degraded !== true);
    check('the report says the analysis did not run', nfReport?.narrativeAvailable, false);
    check('accuracy is null (not assessed), not 100%', nfReport?.accuracyRate, null);
    assert('the measured visibility is still reported', typeof nfReport?.geoVisibilityScore === 'number' && nfReport.geoVisibilityScore === 100);
    assert('a note explains what was not assessed', typeof nfReport?.narrativeNote === 'string' && nfReport.narrativeNote.length > 20, nfReport?.narrativeNote);
    assert('the note contains no raw provider payload', !String(nfReport?.narrativeNote).includes('SECRET_PAYLOAD_MARKER') && !String(nfReport?.narrativeNote).includes('{"'), nfReport?.narrativeNote);

    // --- A fully failed audit carries no fabricated findings --------------
    mode = 'unauthorized';
    const failed = await runAudit(A, { ...POKE, industry: '', coreOfferings: '' });
    const fr = failed.final?.report;
    check('a fully failed audit is flagged degraded', fr?.degraded, true);
    check('it proposes no remediation tasks', fr?.remediationPlan, []);
    check('it reports no omissions', fr?.omissions, []);
    check('it reports no inaccuracies', fr?.inaccuracies, []);
    check('accuracy is null, not 0', fr?.accuracyRate, null);
    const firstEngines = fr?.queriesTested?.[0]?.engines || {};
    check('only the configured engine is listed', Object.keys(firstEngines), ['Gemini']);
    check('its status is "no data", never "omitted"', firstEngines.Gemini?.status, 'retrieval_failed');
    const blob = JSON.stringify(failed.final);
    assert('no raw provider payload anywhere in the failed report', !blob.includes('SECRET_PAYLOAD_MARKER'), blob.slice(0, 300));
    assert('no placeholder JSON-LD price in the failed report', !blob.includes('"price"'));
    assert('the failure reason says what to do (key rejected)', /key/i.test(String(fr?.degradedReason)), fr?.degradedReason);

    // --- Per-query evidence errors are sentences --------------------------
    const failedExcerpt = String(firstEngines.Gemini?.excerpt);
    assert('the per-engine failure says which engine and why, as a sentence', /Gemini/.test(failedExcerpt) && /key/i.test(failedExcerpt) && !failedExcerpt.includes('{'), failedExcerpt);

    // --- Real progress is reported while a job runs -----------------------
    mode = 'slow';
    const slowStart = await (await post(A, '/api/audit/run', POKE)).json();
    await new Promise((r) => setTimeout(r, 600));
    const running = await (await fetch(`${A.base}/api/audit/job/${slowStart.jobId}`)).json();
    check('a running job reports it is running', running.status, 'running');
    check('a running job reports what it is doing', running.progress?.phase, 'querying');
    check('a running job reports how many queries there are', running.progress?.total, 1);
    mode = 'ok';

    // --- API error handling: sentences, not HTML --------------------------
    const unknown = await fetch(`${A.base}/api/nope`);
    check('an unknown API route is a 404', unknown.status, 404);
    const unknownBody = await unknown.json().catch(() => null);
    assert('...with a JSON sentence', typeof unknownBody?.error === 'string', JSON.stringify(unknownBody));

    const malformed = await fetch(`${A.base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    check('a malformed body is a 400', malformed.status, 400);
    const malformedBody = await malformed.json().catch(() => null);
    assert('...with a JSON sentence, not an HTML stack trace', typeof malformedBody?.error === 'string', JSON.stringify(malformedBody));

    const huge = await fetch(`${A.base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: 'x'.repeat(200_000) }),
    });
    check('an oversize body is a 413', huge.status, 413);
    assert('...with a JSON sentence', typeof (await huge.json().catch(() => null))?.error === 'string');

    const longLookup = await post(A, '/api/audit/parse-url', { input: 'a'.repeat(5000) });
    check('an over-long brand lookup is refused before it costs a Gemini call', longLookup.status, 400);

    const badTypes = await post(A, '/api/audit/evaluate-query', { businessName: { x: 1 }, queryText: ['y'] });
    check('non-string fields are a 400, not a crash', badTypes.status, 400);

    const health = await fetch(`${A.base}/api/health`);
    assert('the X-Powered-By header is not advertised', health.headers.get('x-powered-by') === null);
    check('nosniff is set', health.headers.get('x-content-type-options'), 'nosniff');
    const healthBody = await health.json();
    check('health states that storage is in-memory', healthBody.storage, 'in-memory');

    // ------------------------------------------------------------------
    // Server B: per-IP rate limit of 3 / minute on quota-spending POSTs.
    // ------------------------------------------------------------------
    const B = await startApp({ RATE_LIMIT_PER_MIN: '3' });
    assert('server B starts', !!B);
    if (B) {
      procs.push(B.proc);
      mode = 'ok';
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await post(B, '/api/audit/parse-url', { input: `Brand ${i}` })).status);
      }
      assert('the first three requests are served', statuses.slice(0, 3).every((s) => s !== 429), JSON.stringify(statuses));
      check('the fourth request in a minute is refused', statuses[3], 429);
      const refused = await post(B, '/api/audit/parse-url', { input: 'again' });
      assert('the refusal carries Retry-After', Number(refused.headers.get('retry-after')) >= 1);
      assert('the refusal is a sentence', typeof (await refused.json())?.error === 'string');
      check('reads are never rate limited (status polling must keep working)', (await fetch(`${B.base}/api/audit/status`)).status, 200);
      check('health is never rate limited', (await fetch(`${B.base}/api/health`)).status, 200);
    }

    // ------------------------------------------------------------------
    // Server C: only one audit at a time; retries of the same click pass.
    // ------------------------------------------------------------------
    const C = await startApp({ MAX_CONCURRENT_AUDITS: '1' });
    assert('server C starts', !!C);
    if (C) {
      procs.push(C.proc);
      mode = 'slow';
      const first = await post(C, '/api/audit/run', POKE, { 'Idempotency-Key': 'click-1' });
      const firstBody = await first.json();
      check('the first audit is accepted', first.status, 202);

      const retry = await post(C, '/api/audit/run', POKE, { 'Idempotency-Key': 'click-1' });
      const retryBody = await retry.json();
      check('a retry of the same click is not refused by the cap', retry.status, 202);
      check('...and gets the same job back', retryBody.jobId, firstBody.jobId);

      const second = await post(C, '/api/audit/run', POKE, { 'Idempotency-Key': 'click-2' });
      check('a genuinely different audit over the cap is refused', second.status, 429);
      const secondBody = await second.json();
      assert('...with a sentence that says to try again', /try again/i.test(String(secondBody.error)), JSON.stringify(secondBody));

      // Slot frees once the first audit finishes.
      const began = Date.now();
      while (Date.now() - began < 30000) {
        const j = await (await fetch(`${C.base}/api/audit/job/${firstBody.jobId}`)).json();
        if (j.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      mode = 'ok';
      const third = await post(C, '/api/audit/run', POKE, { 'Idempotency-Key': 'click-3' });
      check('once the running audit finishes, a new one is accepted', third.status, 202);
    }
  } finally {
    procs.forEach((p) => p.kill());
    fake.close();
  }

  console.log(failures === 0 ? '\nAll MVP hardening checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Hardening test harness error:', err);
  process.exit(1);
});
