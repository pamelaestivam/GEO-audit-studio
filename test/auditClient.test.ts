/**
 * The page's side of running an audit (`src/auditClient.ts`), against a fake global `fetch`:
 *  - an audit the PAGE drives (driver "client") asks for one step at a time and never polls;
 *  - an audit the server drives (driver "inline") is still only polled;
 *  - a driven audit whose job is gone on a deployment that keeps no state is reported as interrupted, with
 *    the exact sentence a person reads, and never as a result;
 *  - on a deployment that does keep state, a missing job is the ordinary "expired" error.
 *
 * Run with: npx tsx test/auditClient.test.ts
 */
import { AuditInterrupted, interruptedMessage, runAuditJob } from '../src/auditClient';

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

type Reply = { status: number; body: any };
/** Install a fake fetch that answers from a script and records what was asked. */
function fakeFetch(script: (req: { method: string; path: string; headers: Headers }, n: number) => Reply) {
  const calls: { method: string; path: string }[] = [];
  (globalThis as any).fetch = async (path: string, init: RequestInit = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, path });
    const r = script({ method, path, headers: new Headers(init.headers) }, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const STEPS = (done: number) => ({ done, total: 4, plannedCalls: 3, callsMade: done, repeatedCalls: 0 });
const REPORT = { id: 'a1', businessName: 'X', geoVisibilityScore: 50 };

async function main() {
  // ---- driven by the page: one request per step, no polling
  let keys: (string | null)[] = [];
  let calls = fakeFetch((req, n) => {
    if (req.path === '/api/audit/run') {
      keys.push(req.headers.get('Idempotency-Key'));
      return { status: 202, body: { jobId: 'j1', status: 'running', driver: 'client' } };
    }
    if (req.method === 'POST' && req.path === '/api/audit/job/j1/advance') {
      const advance = calls_count(n);
      if (advance < 3) return { status: 200, body: { status: 'running', elapsedMs: 1000, progress: { phase: 'querying', done: advance, total: 2 }, outcome: 'advanced', nextStepAfterMs: 0, steps: STEPS(advance) } };
      if (advance === 3) return { status: 200, body: { status: 'running', elapsedMs: 2000, progress: null, outcome: 'busy', nextStepAfterMs: 5, steps: STEPS(3) } };
      return { status: 200, body: { status: 'done', report: REPORT, saved: false, outcome: 'finished', nextStepAfterMs: 0, steps: STEPS(4) } };
    }
    return { status: 500, body: { error: 'unexpected ' + req.path } };
  });
  function calls_count(n: number) {
    return n - 1; // the submit was call 1
  }
  const messages: string[] = [];
  const result = await runAuditJob({ businessName: 'X' }, (m) => messages.push(m));
  check('a page-driven audit finishes with the report', result.report.id, 'a1');
  check('...by posting to advance each time, and never polling the job', calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/audit/run',
    'POST /api/audit/job/j1/advance',
    'POST /api/audit/job/j1/advance',
    'POST /api/audit/job/j1/advance',
    'POST /api/audit/job/j1/advance',
  ]);
  check('...with one idempotency key for the submit', keys.length === 1 && !!keys[0], true);
  check('...and progress is shown while it runs', messages.length >= 3 && /query/.test(messages[0]), true);

  // ---- driven by the server: polling only, as before
  calls = fakeFetch((req) => {
    if (req.path === '/api/audit/run') return { status: 202, body: { jobId: 'j2', status: 'running', driver: 'inline' } };
    return { status: 200, body: { status: 'done', report: REPORT, saved: true } };
  });
  const polled = await runAuditJob({ businessName: 'X' });
  check('a server-driven audit is only polled (GET), never advanced', [polled.report.saved, calls.map((c) => `${c.method} ${c.path}`)], [true, ['POST /api/audit/run', 'GET /api/audit/job/j2']]);

  // ---- a submit answer with no driver field (an older server) is treated as server-driven
  calls = fakeFetch((req) => (req.path === '/api/audit/run' ? { status: 202, body: { jobId: 'j3', status: 'running' } } : { status: 200, body: { status: 'done', report: REPORT } }));
  await runAuditJob({ businessName: 'X' });
  check('no driver field means polling', calls.map((c) => c.method), ['POST', 'GET']);

  // ---- the job is gone and this deployment keeps no state: interrupted, with how far it got
  calls = fakeFetch((req, n) => {
    if (req.path === '/api/audit/run') return { status: 202, body: { jobId: 'j4', status: 'running', driver: 'client' } };
    if (n === 2) return { status: 200, body: { status: 'running', elapsedMs: 100, progress: null, outcome: 'advanced', nextStepAfterMs: 0, steps: STEPS(1) } };
    return { status: 404, body: { error: 'gone', code: 'job_not_found', storage: { durable: false } } };
  });
  let err: any = null;
  try {
    await runAuditJob({ businessName: 'X' });
  } catch (e) {
    err = e;
  }
  check('a lost job on a stateless deployment throws AuditInterrupted', [err instanceof AuditInterrupted, err?.reason], [true, 'state_lost']);
  check('...with the exact sentence, how far it got, and what running again can cost', err?.message,
    'The server that was running your audit was replaced before it finished, and this deployment does not keep saved state, so the audit could not continue. It had finished 1 of 4 steps and made at least 1 engine call. Nothing from the interrupted run is shown as a measurement. Running it again can use up to 3 engine calls. Please run it again.');
  check('...and the sentence does not claim a result, a resume, or that nothing was spent', /resume|continue where|nothing was spent|no calls/i.test(err?.message || ''), false);

  // ---- the same 404 on a deployment that keeps state is the ordinary expiry, not "interrupted"
  fakeFetch((req) => (req.path === '/api/audit/run' ? { status: 202, body: { jobId: 'j5', status: 'running', driver: 'client' } } : { status: 404, body: { error: 'It expired.', code: 'job_not_found', storage: { durable: true } } }));
  err = null;
  try {
    await runAuditJob({ businessName: 'X' });
  } catch (e) {
    err = e;
  }
  check('a missing job on a deployment that keeps state is an ordinary error', [err instanceof AuditInterrupted, err?.message], [false, 'It expired.']);

  // ---- before any step reported, the sentence still reads whole
  check('the interrupted sentence with nothing known yet', interruptedMessage(null), 'The server that was running your audit was replaced before it finished, and this deployment does not keep saved state, so the audit could not continue. Nothing from the interrupted run is shown as a measurement. Please run it again.');
  check('singular wording for one call', /made at least 1 engine call\./.test(interruptedMessage({ done: 1, total: 3, plannedCalls: 1, callsMade: 1, repeatedCalls: 0 })), true);

  console.log(failures === 0 ? '\nAll audit client checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Audit client test harness error:', e);
  process.exit(1);
});
