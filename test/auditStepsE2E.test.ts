/**
 * End to end, against the real built server, a fake Gemini that counts real HTTP hits, and the real SQLite file:
 * an audit runs as recorded STEPS (docs/PLAN_STEP_E.md, slice S3). The rows in `job_steps` are what the server
 * did; the hit count is what it spent. They must agree, and a step that breaks must leave a visible trace.
 *
 * Needs a current dist/. Run: npx tsx test/auditStepsE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch } from './authHelper';

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

const GEMINI_PORT = 8700 + Math.floor(Math.random() * 100);
const APP_PORT = 8800 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'ok';

const QUERIES = [
  { id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' },
  { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' },
];

async function main() {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const dirs: string[] = [];
  const procs: ChildProcess[] = [];
  const start = (port: number, extraEnv: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-steps-'));
    dirs.push(dir);
    const proc = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
        DATA_DIR: dir,
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
    procs.push(proc);
    return { base: `http://127.0.0.1:${port}`, db: path.join(dir, 'geo-audit.sqlite') };
  };
  const normal = start(APP_PORT);
  const broken = start(APP_PORT + 1, { AUDIT_FORCE_STEP_EXCEPTION: 'narrative' });
  // Its own server: a tripped quota breaker lasts until the provider's daily reset and would taint every later audit.
  const quota = start(APP_PORT + 2);
  const quotaLater = start(APP_PORT + 3);

  async function runAudit(base: string, queries: any[]): Promise<{ jobId: string; job: any; progress: any[] }> {
    const started = await fetch(`${base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queries }),
    });
    const { jobId } = await started.json();
    const progress: any[] = [];
    for (let i = 0; i < 480; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const res = await fetch(`${base}/api/audit/job/${jobId}`);
      const body = await res.json();
      if (body.status === 'running' && body.progress) progress.push(body.progress);
      if (body.status !== 'running') return { jobId, job: body, progress };
    }
    throw new Error('the audit did not finish');
  }
  const rows = (dbPath: string, jobId: string) => {
    const db = new DatabaseSync(dbPath);
    try {
      return {
        steps: db.prepare('SELECT key, state, attempt, skip_reason, error_code, repeated_calls, call_started_at, lease_holder, result FROM job_steps WHERE job_id = ? ORDER BY seq').all(jobId) as any[],
        job: db.prepare('SELECT status, billable, phase, heartbeat_at, instance_id, fail_code FROM jobs WHERE id = ?').get(jobId) as any,
        incidents: db.prepare('SELECT kind, detail FROM incidents WHERE job_id = ?').all(jobId) as any[],
      };
    } finally {
      db.close();
    }
  };

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try {
        up = (await fetch(`${normal.base}/api/health`)).ok && (await fetch(`${broken.base}/api/health`)).ok && (await fetch(`${quota.base}/api/health`)).ok && (await fetch(`${quotaLater.base}/api/health`)).ok;
      } catch {
        /* not up yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) throw new Error('the test servers did not come up');

    // ---- one question, one engine: two real calls, three recorded steps
    let before = fake.hits();
    let { jobId, job } = await runAudit(normal.base, [QUERIES[0]]);
    check('a one-question audit makes exactly 2 real Gemini calls (the answer and the analysis)', fake.hits() - before, 2);
    let r = rows(normal.db, jobId);
    check('...and records three steps, each done on its first attempt', r.steps.map((s) => [s.key, s.state, s.attempt]), [['collect:0:Gemini', 'done', 1], ['narrative', 'done', 1], ['finalize', 'done', 1]]);
    check('...no step was ever repeated or left holding a lease', r.steps.map((s) => [s.repeated_calls, s.lease_holder]), [[0, null], [0, null], [0, null]]);
    check('...the two steps that call out recorded that the call started', r.steps.map((s) => s.call_started_at !== null), [true, true, false]);
    check('...a finished audit keeps no raw answers in its step rows (the result holds what the person gets)', r.steps.map((s) => s.result), [null, null, null]);
    check('...the job is done, billable, and carries a heartbeat and the instance that ran it', [r.job.status, r.job.billable, r.job.heartbeat_at !== null, typeof r.job.instance_id], ['done', 1, true, 'string']);
    check('...the person got a real report', [job.status, job.report?.degraded !== true, job.report?.narrativeAvailable], ['done', true, true]);

    // ---- two questions: calls and steps grow together
    before = fake.hits();
    ({ jobId, job } = await runAudit(normal.base, QUERIES));
    check('two questions make 3 real calls', fake.hits() - before, 3);
    r = rows(normal.db, jobId);
    check('...and 4 steps in plan order', r.steps.map((s) => s.key), ['collect:0:Gemini', 'collect:1:Gemini', 'narrative', 'finalize']);

    // ---- the pauses and the progress a person sees are kept: three questions
    const three0 = [...QUERIES, { id: 'q3', intent: 'direct_recommendation', queryText: 'poke house prices', targetPersona: 'Buyer' }];
    before = fake.hits();
    const timesBefore = fake.hitTimes().length;
    let paced: Awaited<ReturnType<typeof runAudit>>;
    paced = await runAudit(normal.base, three0);
    const t = fake.hitTimes().slice(timesBefore);
    check('three questions make 4 real calls (three answers and the analysis)', fake.hits() - before, 4);
    check('...at least 1.1 s apart between questions, and at least 0.55 s before the analysis call', [t[1] - t[0] >= 1100, t[2] - t[1] >= 1100, t[3] - t[2] >= 550], [true, true, true]);
    const querying = paced.progress.filter((p) => p.phase === 'querying').map((p) => p.done);
    check('...the page is told which question it is on (0 done, then 1 done; the last question is over in an instant), then that the analysis is being written', [[0, 1].every((n) => querying.includes(n)), querying.every((n, i) => i === 0 || n >= querying[i - 1]), paced.progress.some((p) => p.phase === 'analysing' && p.done === 3 && p.total === 3)], [true, true, true]);

    // ---- every engine fails: the analysis step is skipped (nothing to analyse), and no analysis call is made
    mode = 'unauthorized';
    before = fake.hits();
    ({ jobId, job } = await runAudit(normal.base, [QUERIES[0]]));
    check('when the only engine fails, exactly 1 call is made and the analysis is not attempted', fake.hits() - before, 1);
    r = rows(normal.db, jobId);
    check('...the analysis step is recorded as skipped for lack of evidence', r.steps.map((s) => [s.key, s.state, s.skip_reason]), [['collect:0:Gemini', 'done', null], ['narrative', 'skipped', 'no_evidence'], ['finalize', 'done', null]]);
    check('...and the person gets a failed audit that says so, which is not billable', [job.report?.degraded, r.job.billable], [true, 0]);
    mode = 'ok';

    // ---- a step that breaks leaves a visible trace and a failed audit, never a hang
    before = fake.hits();
    ({ jobId, job } = await runAudit(broken.base, [QUERIES[0]]));
    r = rows(broken.db, jobId);
    check('a step that breaks ends the audit as a failed audit with a sentence', [job.status, job.report?.degraded, /Audit failed to complete/.test(job.report?.executiveSummary || '')], ['done', true, true]);
    check('...the broken step is recorded as failed with a code, and the finish was not reached', r.steps.map((s) => [s.key, s.state, s.error_code]), [['collect:0:Gemini', 'done', null], ['narrative', 'failed', 'step_exception'], ['finalize', 'pending', null]]);
    check('...an incident is recorded for the owner, in a sentence', r.incidents.map((i) => [i.kind, /^Step narrative failed: /.test(i.detail)]), [['step_exception', true]]);
    check('...it is not billable, and only the one answer call was spent (the analysis never started)', [r.job.billable, fake.hits() - before], [0, 1]);

    // ---- the daily quota runs out on the first call: the questions not yet started are skipped, not attempted
    mode = 'daily_quota';
    before = fake.hits();
    const three = [...QUERIES, { id: 'q3', intent: 'direct_recommendation', queryText: 'poke house prices', targetPersona: 'Buyer' }];
    ({ jobId, job } = await runAudit(quota.base, three));
    r = rows(quota.db, jobId);
    check('when the daily quota runs out on the first call, only that one call is made', fake.hits() - before, 1);
    check('...the questions not yet started are skipped for the breaker, and the analysis for lack of evidence', r.steps.map((s) => [s.key, s.state, s.skip_reason]), [
      ['collect:0:Gemini', 'done', null],
      ['collect:1:Gemini', 'skipped', 'breaker'],
      ['collect:2:Gemini', 'skipped', 'breaker'],
      ['narrative', 'skipped', 'no_evidence'],
      ['finalize', 'done', null],
    ]);
    check('...and the person gets a failed audit that names the quota, not a result', [job.report?.degraded, /quota/i.test(job.report?.degradedReason || ''), r.job.billable], [true, true, 0]);
    mode = 'ok';

    // ---- the daily quota runs out on the SECOND call: the question already answered is kept, the rest skipped
    mode = 'daily_quota_after_first';
    before = fake.hits();
    ({ jobId, job } = await runAudit(quotaLater.base, three));
    r = rows(quotaLater.db, jobId);
    check('when the quota runs out on the second call, only two calls are made (the analysis is refused without a call)', fake.hits() - before, 2);
    check('...the question that hit the quota is recorded, the one after it is skipped for the breaker, and the answered one is kept', r.steps.map((s) => [s.key, s.state, s.skip_reason]), [
      ['collect:0:Gemini', 'done', null],
      ['collect:1:Gemini', 'done', null],
      ['collect:2:Gemini', 'skipped', 'breaker'],
      ['narrative', 'done', null],
      ['finalize', 'done', null],
    ]);
    check('...the person gets a measured report from the one answer, which says the written analysis was not produced', [job.report?.degraded !== true, job.report?.narrativeAvailable, job.report?.observationsWithEvidence], [true, false, 1]);
    mode = 'ok';
  } finally {
    for (const p of procs) p.kill();
    fake.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nAudit steps end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
