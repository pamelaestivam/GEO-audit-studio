/**
 * End to end: an audit that was running when the server died is RESUMED on a durable store, from the step it was
 * on, and every repeated paid call is counted and recorded (docs/PLAN_STEP_E.md, slice S5). The real built server
 * is killed with SIGKILL and started again on the same database; a fake Gemini counts real HTTP hits; the SQLite
 * file is read for the step rows and incidents.
 *
 *  - killed between steps (during the pause between questions): finishes with exactly the planned calls, no repeat;
 *  - killed in the middle of a call: the call is made again once, and that is recorded (repeated call, incident);
 *  - killed three times on the same step: it stops with a sentence and the calls are capped, never retried forever;
 *  - an audit the PAGE drives survives a restart and carries on when the page asks again;
 *  - a job made before audits were stepped (no plan) is failed with a sentence, not left running.
 *
 * Needs a current dist/. Run: npx tsx test/auditResumeE2E.test.ts
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

const GEMINI_PORT = 9500 + Math.floor(Math.random() * 100);
let nextPort = 9600 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'ok';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const Q1 = { id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' };
const Q2 = { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' };

async function main() {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  // Each call to Gemini takes 2 s in 'slow' mode, long enough to kill the server in the middle of one.
  const fake = await startFakeGemini(GEMINI_PORT, () => mode, 2000);
  const dirs: string[] = [];
  const procs: ChildProcess[] = [];

  const boot = async (dir: string, port: number, env: Record<string, string> = {}) => {
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
        ...env,
      },
      stdio: 'ignore',
    });
    procs.push(proc);
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return proc;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    throw new Error('the server did not come up');
  };
  const kill = (p: ChildProcess) =>
    new Promise<void>((resolve) => {
      p.once('close', () => resolve());
      p.kill('SIGKILL');
    });
  const newDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-resume-'));
    dirs.push(d);
    return d;
  };
  const submit = async (base: string, queries: any[]) => {
    const res = await fetch(`${base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queries }),
    });
    return (await res.json()) as any;
  };
  const waitDone = async (base: string, jobId: string, ms = 60000) => {
    for (let i = 0; i < ms / 250; i++) {
      const res = await fetch(`${base}/api/audit/job/${jobId}`);
      const body = await res.json();
      if (body.status !== 'running') return { httpStatus: res.status, body };
      await sleep(250);
    }
    throw new Error('the audit did not finish');
  };
  const waitHits = async (n: number, ms = 20000) => {
    for (let i = 0; i < ms / 50 && fake.hits() < n; i++) await sleep(50);
  };
  const rows = (dir: string, jobId: string) => {
    const db = new DatabaseSync(path.join(dir, 'geo-audit.sqlite'));
    try {
      return {
        steps: db.prepare('SELECT key, state, attempt, repeated_calls FROM job_steps WHERE job_id = ? ORDER BY seq').all(jobId) as any[],
        incidents: db.prepare('SELECT kind, detail FROM incidents WHERE job_id = ?').all(jobId) as any[],
        job: db.prepare('SELECT status, billable, fail_code, error FROM jobs WHERE id = ?').get(jobId) as any,
      };
    } finally {
      db.close();
    }
  };

  try {
    // ---- killed between steps: during the pause between two questions
    {
      const dir = newDir();
      const port = nextPort++;
      mode = 'ok';
      const before = fake.hits();
      let proc = await boot(dir, port);
      const { jobId } = await submit(`http://127.0.0.1:${port}`, [Q1, Q2]);
      // Wait until the first answer is STORED (not merely received), then kill during the pause before question 2.
      for (let i = 0; i < 400 && rows(dir, jobId).steps[0]?.state !== 'done'; i++) await sleep(25);
      await kill(proc);
      proc = await boot(dir, port);
      const fin = await waitDone(`http://127.0.0.1:${port}`, jobId);
      const r = rows(dir, jobId);
      check('an audit killed between two questions is resumed and finishes', [fin.body.status, fin.body.report?.degraded !== true], ['done', true]);
      check('...with exactly the planned calls (two answers and the analysis): nothing was made twice', fake.hits() - before, 3);
      check('...the step that was waiting is taken over as attempt 2, and no call is counted as repeated', r.steps.map((s) => [s.key, s.state, s.attempt, s.repeated_calls]), [
        ['collect:0:Gemini', 'done', 1, 0],
        ['collect:1:Gemini', 'done', 2, 0],
        ['narrative', 'done', 1, 0],
        ['finalize', 'done', 1, 0],
      ]);
      check('...no incident, and the audit is billable', [r.incidents.length, r.job.billable], [0, 1]);
      await kill(proc);
    }

    // ---- killed in the middle of a call: the call is made again, once, and said so
    {
      const dir = newDir();
      const port = nextPort++;
      mode = 'slow';
      const before = fake.hits();
      let proc = await boot(dir, port);
      const { jobId } = await submit(`http://127.0.0.1:${port}`, [Q1]);
      await waitHits(before + 1); // the call has arrived and is being held by the fake
      await kill(proc);
      mode = 'ok';
      proc = await boot(dir, port);
      const fin = await waitDone(`http://127.0.0.1:${port}`, jobId);
      const r = rows(dir, jobId);
      check('an audit killed in the middle of a call is resumed and finishes', [fin.body.status, fin.body.report?.degraded !== true], ['done', true]);
      check('...the interrupted call was made again: the planned 2 calls plus 1 repeat', fake.hits() - before, 3);
      check('...the step records the repeat (attempt 2, one repeated call)', r.steps.map((s) => [s.key, s.attempt, s.repeated_calls]), [['collect:0:Gemini', 2, 1], ['narrative', 1, 0], ['finalize', 1, 0]]);
      check('...and an incident says a call may have been made twice', r.incidents.map((i) => [i.kind, /may have been made twice/.test(i.detail)]), [['lease_expired_midcall', true]]);
      await kill(proc);
    }

    // ---- killed three times on the same step: it stops, with a sentence, and the calls are capped
    {
      const dir = newDir();
      const port = nextPort++;
      mode = 'slow';
      const before = fake.hits();
      let proc = await boot(dir, port);
      const { jobId } = await submit(`http://127.0.0.1:${port}`, [Q1]);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await waitHits(before + attempt);
        await kill(proc);
        proc = await boot(dir, port);
      }
      const fin = await waitDone(`http://127.0.0.1:${port}`, jobId);
      const r = rows(dir, jobId);
      check('a step killed three times is not tried a fourth time: the audit ends with a sentence', [fin.httpStatus, fin.body.status, /did not finish after 3 tries/.test(fin.body.error || '')], [500, 'error', true]);
      check('...only three calls were ever made', fake.hits() - before, 3);
      check('...the step is failed with a code, the job is not billable and says why', [r.steps[0].state, r.job.fail_code, r.job.billable], ['failed', 'step_attempts_exceeded', 0]);
      check('...and the owner has an incident for it', r.incidents.some((i) => i.kind === 'step_attempts_exceeded'), true);
      mode = 'ok';
      await kill(proc);
    }

    // ---- an audit the page drives survives a restart and carries on when the page asks again
    {
      const dir = newDir();
      const port = nextPort++;
      mode = 'ok';
      const before = fake.hits();
      let proc = await boot(dir, port, { AUDIT_DRIVER: 'client' });
      const sub = await submit(`http://127.0.0.1:${port}`, [Q1]);
      const base = `http://127.0.0.1:${port}`;
      const first = await (await fetch(`${base}/api/audit/job/${sub.jobId}/advance`, { method: 'POST' })).json();
      check('a page-driven audit takes its first step', [sub.driver, first.outcome, fake.hits() - before], ['client', 'advanced', 1]);
      await kill(proc);
      proc = await boot(dir, port, { AUDIT_DRIVER: 'client' });
      await sleep(1500);
      const still = await (await fetch(`${base}/api/audit/job/${sub.jobId}`)).json();
      check('after a restart it is still running (nothing fails it, nothing runs it on its own)', [still.status, fake.hits() - before], ['running', 1]);
      let last: any = null;
      for (let i = 0; i < 10; i++) {
        last = await (await fetch(`${base}/api/audit/job/${sub.jobId}/advance`, { method: 'POST' })).json();
        if (last.status !== 'running') break;
      }
      check('...and when the page asks again it finishes, with exactly the planned calls', [last.status, fake.hits() - before], ['done', 2]);
      await kill(proc);
    }

    // ---- a job made before audits were stepped (no plan) cannot be resumed: it is failed with a sentence
    {
      const dir = newDir();
      const port = nextPort++;
      let proc = await boot(dir, port);
      await kill(proc);
      const db = new DatabaseSync(path.join(dir, 'geo-audit.sqlite'));
      db.prepare("INSERT INTO jobs (id, owner, status, started_at, budget_key) VALUES ('legacy-1', 'someone@example.com', 'running', ?, 'someone@example.com')").run(Date.now());
      db.close();
      proc = await boot(dir, port);
      const r = rows(dir, 'legacy-1');
      check('a running job with no plan is failed at boot with a code and a sentence', [r.job.status, r.job.fail_code, /server restarted/.test(r.job.error || ''), r.job.billable], ['error', 'restarted', true, 0]);
      await kill(proc);
    }
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    fake.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nResume end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
