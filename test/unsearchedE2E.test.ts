/**
 * End to end, on the real built server and a fake Gemini that counts hits (docs/PLAN_2026-11.md P2):
 *   - an answer given WITHOUT a web search is not counted (one of two questions: 1 of 2 measured, the other listed as not counted with its
 *     own sentence, never as "the engine left you out", and exactly the calls the same audit makes when both are searched);
 *   - every answer unsearched: a failed audit whose reason is that sentence, one call, no analysis, no hint; "Add & Audit Query" says it too;
 *   - a refused search (a 429 only when the request carries the search tool): the audit fails exactly as before this change (same
 *     sentence, same number of calls, measured on main) plus the hint; readiness on that same server asks nothing (the breaker is tripped);
 *   - the operator's own daily cap carries no hint;
 *   - the readiness check asks what an audit asks: both ok = 2 calls; a refused search = plain ok, search not ok, and the breaker is NOT tripped
 *     (an audit right after still reaches the fake); a 500 on the search only; an unsearched reply; no key; cached = 0 more calls.
 * Needs a current dist/. Run: npx tsx test/unsearchedE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomPort } from './ports';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch } from './authHelper';
import { NOT_SEARCHED_MESSAGE, DEGRADED_HINT } from '../src/errors';

installAuthFetch();

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
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

const GEMINI_PORT = randomPort(7000, 90);
const PORTS = [randomPort(7100, 400)];
let mode: FakeMode = 'ok';

// What a rate-limited / refused-search audit said and cost BEFORE this change (measured on main at 4b17f3e, 2026-11-15, one question under
// the fake's `search_refused`: a 429 "You exceeded your current quota ..." on the search request).
const BASELINE_REFUSED_CALLS = 1;
const BASELINE_REFUSED_REASON = "Gemini rate limited this request: too many requests in a short window, and did not say for how long. Wait a minute and re-run; if it keeps happening, check the key's quota at https://aistudio.google.com/apikey or enable billing on it.";

const ONE_Q = [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }];
const TWO_Q = [...ONE_Q, { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' }];

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const children: ChildProcess[] = [];
  let nextPort = PORTS[0];
  async function server(extraEnv: Record<string, string> = {}) {
    const port = nextPort++;
    const child = spawn('node', ['dist/server.cjs'], {
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
        ...TEST_AUTH_ENV,
        ...extraEnv,
      },
      stdio: 'ignore',
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return base;
  }
  async function runAudit(base: string, queries: any[]): Promise<any> {
    const start = await fetch(`${base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queries }),
    });
    const { jobId } = await start.json();
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d = await (await fetch(`${base}/api/audit/job/${jobId}`)).json();
      if (d.status !== 'running') return Object.assign(d.report ?? {}, { __job: d });
    }
    return null;
  }
  const readiness = async (base: string, refresh = false) => (await (await fetch(`${base}/api/audit/readiness${refresh ? '?refresh=1' : ''}`)).json()) as any;
  const line = (r: any, name: string) => (r.checks || []).find((c: any) => c.name === name);

  try {
    // ---- 1. one of two answers has no search behind it
    {
      const base = await server();
      mode = 'ok';
      let h0 = fake.hits();
      const ok = await runAudit(base, TWO_Q);
      const okCalls = fake.hits() - h0;
      check('baseline: a fully searched two-question audit makes 3 calls (2 searches + the analysis)', [okCalls, ok.degraded !== true, ok.questionsAnswered], [3, true, 2]);

      mode = 'unsearched_second';
      h0 = fake.hits();
      const r = await runAudit(base, TWO_Q);
      const calls = fake.hits() - h0;
      check('one unsearched answer of two: the audit is measured, on 1 of 2 answers', [r.degraded !== true, r.questionsAnswered, r.observationsAttempted, r.observationsWithEvidence], [true, 1, 2, 1]);
      check('...and makes exactly the calls the same audit makes when both are searched', calls, okCalls);
      const cell = r.queriesTested?.[1]?.engines?.Gemini;
      assert('...the second question is listed as not counted, with the sentence', cell?.status === 'retrieval_failed' && String(cell?.excerpt).includes(NOT_SEARCHED_MESSAGE), JSON.stringify(cell));
      assert('...never as "the engine left you out", and not as a retrieval failure that did not happen', cell?.status !== 'omitted' && !/No answer (was )?captured/.test(String(cell?.excerpt)), JSON.stringify(cell));
      assert('...the first question is measured as usual', r.queriesTested?.[0]?.engines?.Gemini?.status !== 'retrieval_failed');
      assert('`searched` is not copied into the report (no golden report changes)', !JSON.stringify({ ...r, __job: undefined }).includes('"searched"'));
      check('the report says which rule it was measured under: metricVersion 3', r.metricVersion, 3);
      check('a measured audit carries no hint', r.degradedHint, undefined);
    }

    // ---- 2. every answer unsearched
    {
      const base = await server();
      mode = 'unsearched_answer';
      const h0 = fake.hits();
      const r = await runAudit(base, ONE_Q);
      check('every answer unsearched: a failed audit whose reason is the not-searched sentence', [r.degraded, r.degradedReason], [true, NOT_SEARCHED_MESSAGE]);
      check('...one call, and the analysis is skipped', fake.hits() - h0, 1);
      check('...no hint (nothing here was refused)', r.degradedHint, undefined);
      assert('...and the cell does not say "No answer was captured"', !/No answer was captured/.test(JSON.stringify(r.queriesTested)), JSON.stringify(r.queriesTested?.[0]?.engines));
      const ev = await fetch(`${base}/api/audit/evaluate-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unsearched-eval-1' },
        body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queryText: 'best poke in Austin' }),
      });
      const evBody: any = await ev.json();
      check('"Add & Audit Query" under the same mode answers with that sentence and invents nothing', [ev.status, evBody.error, evBody.evaluatedQuery], [502, NOT_SEARCHED_MESSAGE, undefined]);
    }

    // ---- 3. a refused search
    {
      const base = await server();
      mode = 'search_refused';
      const h0 = fake.hits();
      const r = await runAudit(base, ONE_Q);
      const calls = fake.hits() - h0;
      console.log(`MEASURE refused audit: calls=${calls} reason=${JSON.stringify(r.degradedReason)}`);
      check('a refused search fails the audit exactly as before this change: the same number of calls', calls, BASELINE_REFUSED_CALLS);
      check('...and the same sentence', [r.degraded, r.degradedReason], [true, BASELINE_REFUSED_REASON]);
      check('...plus the hint', r.degradedHint, DEGRADED_HINT);
      // readiness on that SAME server, right away: the breaker is tripped, so neither Gemini line asks anything.
      const h1 = fake.hits();
      const rd = await readiness(base);
      assert('readiness right after: the breaker is tripped, so the plain line is not checked', line(rd, 'gemini')?.ok === false && line(rd, 'gemini')?.verified === false, JSON.stringify(line(rd, 'gemini')));
      check('...and the search line says it was not checked', [line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified, line(rd, 'gemini search')?.detail], [false, false, 'Not checked, because the plain Gemini check did not pass.']);
      check('...without a single call', fake.hits() - h1, 0);
    }

    // ---- 4. the operator's own cap carries no hint
    {
      const base = await server({ GEMINI_DAILY_CALL_CAP: '1' });
      mode = 'ok';
      const h0 = fake.hits();
      const rd = await readiness(base);
      check('cap of 1: readiness makes the plain call, and the search is refused by the cap, not verified', [fake.hits() - h0, line(rd, 'gemini')?.ok, line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified], [1, true, false, false]);
      assert('...in the cap\'s own sentence', /at most 1 answer-engine call a day/.test(line(rd, 'gemini search')?.detail || ''), line(rd, 'gemini search')?.detail);
      const r = await runAudit(base, ONE_Q);
      check('an audit refused by the daily cap fails with no call and carries no hint', [r.degraded, r.degradedHint, fake.hits() - h0], [true, undefined, 1]);
      assert('...its reason is the cap\'s sentence', /at most 1 answer-engine call a day/.test(r.degradedReason || ''), r.degradedReason);
    }

    // ---- 5. an unauthorized failure carries no hint
    {
      const base = await server();
      mode = 'unauthorized';
      const r = await runAudit(base, ONE_Q);
      check('a rejected key fails the audit with no hint', [r.degraded, r.degradedHint], [true, undefined]);
    }

    // ---- 6. readiness
    {
      const base = await server();
      mode = 'ok';
      let h0 = fake.hits();
      const rd = await readiness(base);
      check('readiness, both fine: two calls, both lines ok and verified', [fake.hits() - h0, line(rd, 'gemini')?.ok, line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified], [2, true, true, true]);
      assert('...the search line names the model', /^Model \S+ searched the web and answered\.$/.test(line(rd, 'gemini search')?.detail || ''), line(rd, 'gemini search')?.detail);
      h0 = fake.hits();
      const again = await readiness(base);
      check('a second request inside five minutes makes no call and is cached', [fake.hits() - h0, again.cached], [0, true]);
    }
    {
      const base = await server();
      mode = 'search_refused';
      const h0 = fake.hits();
      const rd = await readiness(base);
      check('readiness with a refused search: plain ok, search not ok and verified, two calls', [fake.hits() - h0, line(rd, 'gemini')?.ok, line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified], [2, true, false, true]);
      assert('...saying the search was refused', /answered a plain request but was refused a web search\. Either this model has no free web search on this key, or the day's free search allowance is used up; the rate-limit page in Google AI Studio shows which\.$/.test(line(rd, 'gemini search')?.detail || ''), line(rd, 'gemini search')?.detail);
      const h1 = fake.hits();
      const r = await runAudit(base, ONE_Q);
      assert('...and the breaker is NOT tripped: an audit started right after still reaches the fake', fake.hits() - h1 >= 1, `hits ${fake.hits() - h1}`);
      assert('...(it then fails as before, with the hint)', r.degraded === true && r.degradedHint === DEGRADED_HINT, JSON.stringify([r.degraded, r.degradedHint]));
    }
    {
      const base = await server();
      mode = 'search_500';
      const h0 = fake.hits();
      const rd = await readiness(base);
      check('a 500 on the search call only: two calls (no retry)', fake.hits() - h0, 2);
      const d = line(rd, 'gemini search')?.detail || '';
      assert('...says the web-search request failed, not that it was refused', /answered a plain request, but the web-search request failed: /.test(d) && !/refused a web search/.test(d) && !/SECRET_PAYLOAD_MARKER/.test(d), d);
      check('...not ok, verified', [line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified], [false, true]);
    }
    {
      const base = await server();
      mode = 'unsearched_answer';
      const rd = await readiness(base);
      check('an answer with no search behind it: search not ok, its sentence', [line(rd, 'gemini')?.ok, line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified, /^Model \S+ answered the readiness question without searching the web\.$/.test(line(rd, 'gemini search')?.detail || '')], [true, false, true, true]);
    }
    {
      const base = await server({ GEMINI_API_KEY: '' });
      mode = 'ok';
      const h0 = fake.hits();
      const rd = await readiness(base);
      check('no key: the search line is not checked and nothing is called', [fake.hits() - h0, line(rd, 'gemini search')?.ok, line(rd, 'gemini search')?.verified, line(rd, 'gemini search')?.detail], [0, false, false, 'Not checked, because the plain Gemini check did not pass.']);
    }
  } finally {
    for (const c of children) c.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nUnsearched-answer end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
