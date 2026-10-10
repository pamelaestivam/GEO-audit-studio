/**
 * End to end, against the real built server and a fake Gemini that counts real HTTP hits: an audit the PAGE
 * drives (AUDIT_DRIVER=client, what Vercel uses) spends only when the page asks for a step, once per step,
 * and says plainly when its job is gone (docs/PLAN_STEP_E.md, slice S4).
 *
 *  - nothing runs after the 202: zero hits while nobody asks;
 *  - a replayed submit and an abandoned submit spend nothing;
 *  - advancing to the end makes exactly the planned calls, each step once;
 *  - two advances at the same moment: one does the step, the other is told it is busy, and the hit count
 *    moves by exactly one;
 *  - a job on another instance of a stateless deployment is a typed 404, and nothing is spent;
 *  - advancing is not counted by the per-minute limiter, submitting still is;
 *  - an audit nobody is driving stops holding a concurrent-audit slot.
 *
 * Needs a current dist/. Run: npx tsx test/auditClientDriverE2E.test.ts
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

const GEMINI_PORT = 9000 + Math.floor(Math.random() * 100);
const APP_PORT = 9100 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'ok';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUERY = [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }];

async function main() {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  const fake = await startFakeGemini(GEMINI_PORT, () => mode, 1500);
  const dirs: string[] = [];
  const procs: ChildProcess[] = [];
  let nextPort = APP_PORT;
  const start = (env: Record<string, string> = {}, durable = true) => {
    const port = nextPort++;
    let dir: string | undefined;
    if (durable) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-client-driver-'));
      dirs.push(dir);
    }
    procs.push(
      spawn('node', ['dist/server.cjs'], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'production',
          ...(dir ? { DATA_DIR: dir } : { DATA_DIR: '' }),
          AUDIT_DRIVER: 'client',
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
      })
    );
    return { base: `http://127.0.0.1:${port}`, db: dir ? path.join(dir, 'geo-audit.sqlite') : '' };
  };

  const main1 = start();
  const limited = start({ RATE_LIMIT_PER_MIN: '3' });
  const slots = start({ MAX_CONCURRENT_AUDITS: '1', AUDIT_STALL_MS: '1000' });
  const mem1 = start({}, false);
  const mem2 = start({}, false);

  const submit = async (base: string, key?: string) => {
    const res = await fetch(`${base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queries: QUERY }),
    });
    return { status: res.status, body: await res.json() };
  };
  const advance = async (base: string, jobId: string) => {
    const res = await fetch(`${base}/api/audit/job/${jobId}/advance`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  };
  const stepRows = (db: string, jobId: string) => {
    const conn = new DatabaseSync(db);
    try {
      return conn.prepare('SELECT key, state, attempt FROM job_steps WHERE job_id = ? ORDER BY seq').all(jobId) as any[];
    } finally {
      conn.close();
    }
  };

  try {
    for (const s of [main1, limited, slots, mem1, mem2]) {
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${s.base}/api/health`)).ok) break;
        } catch {
          /* not up yet */
        }
        await sleep(250);
      }
    }

    // ---- nothing runs after the 202
    let before = fake.hits();
    const first = await submit(main1.base, 'key-1');
    check('a page-driven audit is accepted and says who drives it', [first.status, first.body.driver, first.body.status], [202, 'client', 'running']);
    await sleep(1500);
    check('...and with nobody asking, nothing is spent', fake.hits() - before, 0);
    const poll = await (await fetch(`${main1.base}/api/audit/job/${first.body.jobId}`)).json();
    check('...the job simply waits, running, with no progress yet', [poll.status, poll.progress], ['running', null]);

    // ---- a replayed submit changes nothing
    const replay = await submit(main1.base, 'key-1');
    check('the same click sent again returns the same job and spends nothing', [replay.body.jobId === first.body.jobId, replay.body.driver, fake.hits() - before], [true, 'client', 0]);

    // ---- an audit nobody drives never spends: a retried submit under another key is a different, idle job
    const abandoned = await submit(main1.base, 'key-2');
    await sleep(1000);
    check('a second submit under another key is another job, and an idle one spends nothing', [abandoned.body.jobId !== first.body.jobId, fake.hits() - before], [true, 0]);

    // ---- advancing to the end: exactly the planned calls, each step once
    let outcomes: string[] = [];
    let last: any = null;
    for (let i = 0; i < 20; i++) {
      const r = await advance(main1.base, first.body.jobId);
      outcomes.push(r.body.outcome);
      last = r;
      if (r.body.status !== 'running') break;
    }
    check('advancing to the end finishes the audit', [last.body.status, last.body.report?.degraded !== true], ['done', true]);
    check('...with exactly the planned calls (the answer and the analysis), and the last step reports finished', [fake.hits() - before, outcomes[outcomes.length - 1]], [2, 'finished']);
    check('...every step done on its first attempt', stepRows(main1.db, first.body.jobId).map((s) => [s.key, s.state, s.attempt]), [['collect:0:Gemini', 'done', 1], ['narrative', 'done', 1], ['finalize', 'done', 1]]);
    check('...the progress it reports is its own: steps done of total and the calls made', [last.body.steps.done, last.body.steps.total, last.body.steps.plannedCalls, last.body.steps.callsMade], [3, 3, 2, 2]);
    const after = await advance(main1.base, first.body.jobId);
    check('asking again after the end just reports the result and does nothing', [after.body.status, after.body.outcome, fake.hits() - before], ['done', 'idle', 2]);

    // ---- two advances at the same moment: one steps, one is told it is busy
    mode = 'slow';
    const racing = await submit(main1.base, 'key-3');
    before = fake.hits();
    const both = await Promise.all([advance(main1.base, racing.body.jobId), advance(main1.base, racing.body.jobId)]);
    check('two simultaneous advances: one does the step, the other is busy', both.map((r) => r.body.outcome).sort(), ['advanced', 'busy']);
    check('...and the real call count moved by exactly one', fake.hits() - before, 1);
    check('...the busy one tells the page to wait a moment before asking again', both.find((r) => r.body.outcome === 'busy')?.body.nextStepAfterMs, 1000);
    mode = 'ok';

    // ---- another instance of a stateless deployment does not have the job
    const onMem1 = await submit(mem1.base, 'key-m');
    before = fake.hits();
    const elsewhere = await advance(mem2.base, onMem1.body.jobId);
    check('a job on another instance of a deployment that keeps no state is a typed 404 that says so', [elsewhere.status, elsewhere.body.code, elsewhere.body.storage], [404, 'job_not_found', { durable: false }]);
    check('...and nothing was spent', fake.hits() - before, 0);
    const stranger = await advance(main1.base, onMem1.body.jobId);
    check('a job id that does not exist on a durable deployment says the same, with durable: true', [stranger.status, stranger.body.code, stranger.body.storage], [404, 'job_not_found', { durable: true }]);

    // ---- the per-minute limiter counts submits, not the page's steady stream of advances
    const l1 = await submit(limited.base, 'l-1');
    const advances: number[] = [];
    for (let i = 0; i < 8; i++) advances.push((await advance(limited.base, l1.body.jobId)).status);
    check('eight advances against a limit of 3 per minute are not refused', advances.every((s) => s === 200 || s === 500), true);
    await submit(limited.base, 'l-2');
    await submit(limited.base, 'l-3');
    check('...but the next submit is refused by the same limiter', (await submit(limited.base, 'l-4')).status, 429);

    // ---- an audit nobody drives stops holding a concurrent-audit slot
    const s1 = await submit(slots.base, 's-1');
    const s2 = await submit(slots.base, 's-2');
    check('with one slot, a second audit is refused while the first is fresh', [s1.status, s2.status], [202, 429]);
    await sleep(1500);
    check('...and once the first has been left untouched past the stall window it no longer holds the slot', (await submit(slots.base, 's-3')).status, 202);
  } finally {
    for (const p of procs) p.kill();
    fake.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nClient-driver end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
