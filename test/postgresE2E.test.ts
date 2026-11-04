/**
 * End to end: the real built server on a real PostgreSQL database, the way two Vercel instances would share one.
 * Two server processes use one database and AUDIT_DRIVER=client (what Vercel uses); a fake Gemini counts real HTTP
 * hits; the database is read for the step rows and incidents.
 *
 *  - /api/audit/status says the store is postgres and durable, with no note;
 *  - the same retried click sent to both servers at once makes ONE job (the database's unique index decides);
 *  - an audit submitted on one server is advanced by the other, step by step, with exactly the planned calls and
 *    every step done on its first attempt (before this store, "a job on another instance" was a typed 404);
 *  - two simultaneous advances, one on each server: exactly one steps, the other is busy, one real call;
 *  - the finished audit is in the history of the other server, and survives killing every server (SIGKILL);
 *  - a server killed in the middle of a call: the other server waits out the claim, repeats the call once, and says so;
 *  - deep readiness reports the storage as a postgres store that survives restarts.
 *
 * Needs a current dist/ and TEST_DATABASE_URL (a throwaway database; the test creates and drops its own schema).
 * Without TEST_DATABASE_URL it says NOT RUN (CI sets REQUIRE_POSTGRES=1, which makes that a failure).
 * Run: TEST_DATABASE_URL=postgresql://... npx tsx test/postgresE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import { PortRange, randomPort } from './ports';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch, rawFetch } from './authHelper';
import { createPgPool } from '../src/postgresStore';

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

const GEMINI_PORT = randomPort(9800, 100);
const nextPort = new PortRange(9900, 200);
let mode: FakeMode = 'ok';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUERY = [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }];

async function run(url: string) {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode, 1500);
  const admin = await createPgPool(url, { max: 2 });
  const schema = `e2e_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dbUrl = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const procs: ChildProcess[] = [];

  const start = (env: Record<string, string> = {}) => {
    const port = nextPort.take();
    const proc = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
        DATA_DIR: '',
        DATABASE_URL: dbUrl,
        AUDIT_DRIVER: 'client',
        // Short enough that a claim left by a killed server expires inside the test.
        AUDIT_LEASE_MS: '3000',
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
    return { base: `http://127.0.0.1:${port}`, proc };
  };
  const up = async (s: { base: string }) => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${s.base}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    throw new Error('a server did not come up');
  };
  const kill = (s: { proc: ChildProcess }) =>
    new Promise<void>((resolve) => {
      s.proc.once('close', () => resolve());
      s.proc.kill('SIGKILL');
    });
  const submit = async (base: string, key: string) => {
    const res = await fetch(`${base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ businessName: 'Poke House', domain: 'poke.house', queries: QUERY }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const advance = async (base: string, jobId: string) => {
    const res = await fetch(`${base}/api/audit/job/${jobId}/advance`, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as any };
  };
  const q = async (sql: string, params: any[] = []) => (await admin.query(sql.replace(/\$SCHEMA/g, schema), params)).rows as any[];
  const waitHits = async (n: number, ms = 20000) => {
    for (let i = 0; i < ms / 50 && fake.hits() < n; i++) await sleep(50);
  };

  try {
    const A = start();
    const B = start();
    await Promise.all([up(A), up(B)]);

    // ---- both servers say what they are
    for (const [name, s] of [['first', A], ['second', B]] as const) {
      const st = (await (await fetch(`${s.base}/api/audit/status`)).json()) as any;
      check(`the ${name} server reports a durable postgres store with no warning`, [st.storage?.kind, st.storage?.durable, st.storage?.note], ['postgres', true, undefined]);
    }

    // ---- the same retried click reaches both servers at once: one job
    let before = fake.hits();
    const [s1, s2] = await Promise.all([submit(A.base, 'click-1'), submit(B.base, 'click-1')]);
    check('the same click sent to both servers at once is accepted by both', [s1.status, s2.status], [202, 202]);
    check('...and they name the same job', s1.body.jobId === s2.body.jobId, true);
    check('...which exists once in the database', (await q("SELECT COUNT(*)::int AS n FROM $SCHEMA.jobs WHERE idem_key = 'click-1'"))[0].n, 1);
    check('...with nothing spent until a step is asked for', fake.hits() - before, 0);

    // ---- an audit submitted on one server is advanced by the other
    const jobId = s1.body.jobId as string;
    const outcomes: string[] = [];
    let last: any = null;
    for (let i = 0; i < 10; i++) {
      last = await advance(i % 2 === 0 ? B.base : A.base, jobId);
      outcomes.push(last.body.outcome);
      if (last.body.status !== 'running') break;
    }
    check('advancing on alternating servers finishes the audit', [last.body.status, last.body.report?.degraded !== true], ['done', true]);
    check('...with exactly the planned calls (the answer and the analysis)', fake.hits() - before, 2);
    check('...every step done on its first attempt', (await q('SELECT key, state, attempt, repeated_calls FROM $SCHEMA.job_steps WHERE job_id = $1 ORDER BY seq', [jobId])).map((r) => [r.key, r.state, r.attempt, r.repeated_calls]), [
      ['collect:0:Gemini', 'done', 1, 0],
      ['narrative', 'done', 1, 0],
      ['finalize', 'done', 1, 0],
    ]);

    // ---- the finished audit is in the history of the OTHER server
    const histA = (await (await fetch(`${A.base}/api/audits`)).json()) as any;
    const histB = (await (await fetch(`${B.base}/api/audits`)).json()) as any;
    check('the saved audit is in the history on both servers', [histA.audits?.length, histB.audits?.length], [1, 1]);

    // ---- two simultaneous advances, one on each server
    mode = 'slow';
    const racing = await submit(A.base, 'click-2');
    before = fake.hits();
    const both = await Promise.all([advance(A.base, racing.body.jobId), advance(B.base, racing.body.jobId)]);
    check('two simultaneous advances, one per server: one does the step, the other is busy', both.map((r) => r.body.outcome).sort(), ['advanced', 'busy']);
    check('...and the real call count moved by exactly one', fake.hits() - before, 1);
    mode = 'ok';

    // ---- a server killed in the middle of a call: the other waits out the claim and repeats the call once
    mode = 'slow';
    const cut = await submit(A.base, 'click-3');
    before = fake.hits();
    const inflight = fetch(`${A.base}/api/audit/job/${cut.body.jobId}/advance`, { method: 'POST' }).catch(() => 'cut');
    await waitHits(before + 1); // the call has arrived at the fake and is being held
    await kill(A);
    await inflight;
    mode = 'ok';
    const early = await advance(B.base, cut.body.jobId);
    check('right after the kill the claim is still live, so the other server is told to wait (nothing repeated yet)', [early.body.outcome, fake.hits() - before], ['busy', 1]);
    let took: any = null;
    for (let i = 0; i < 40 && !(took && took.body.outcome !== 'busy'); i++) {
      await sleep(500);
      took = await advance(B.base, cut.body.jobId);
    }
    check('once the dead server\'s claim expires the other server takes the step over', took?.body.outcome, 'advanced');
    for (let i = 0; i < 10 && took.body.status === 'running'; i++) took = await advance(B.base, cut.body.jobId);
    check('...and the audit finishes', [took.body.status, took.body.report?.degraded !== true], ['done', true]);
    check('...the interrupted call was made again: the planned 2 calls plus 1 repeat', fake.hits() - before, 3);
    const rep = await q('SELECT key, attempt, repeated_calls FROM $SCHEMA.job_steps WHERE job_id = $1 ORDER BY seq', [cut.body.jobId]);
    check('...the step records the repeat', rep.map((r) => [r.key, r.attempt, r.repeated_calls]), [['collect:0:Gemini', 2, 1], ['narrative', 1, 0], ['finalize', 1, 0]]);
    const inc = await q('SELECT kind, detail FROM $SCHEMA.incidents WHERE job_id = $1', [cut.body.jobId]);
    check('...and an incident says a call may have been made twice', inc.map((i) => [i.kind, /may have been made twice/.test(i.detail)]), [['lease_expired_midcall', true]]);

    // ---- every server killed, a new one started: nothing is lost
    await kill(B);
    const C = start();
    await up(C);
    const histC = (await (await fetch(`${C.base}/api/audits`)).json()) as any;
    check('after every server was killed, a new one still lists all three saved audits', histC.audits?.length >= 2, true);
    const old = await (await fetch(`${C.base}/api/audit/job/${jobId}`)).json();
    check('...and still has the first audit\'s result', [(old as any).status, (old as any).report?.id !== undefined], ['done', true]);

    // ---- deep readiness
    const ready = (await (await fetch(`${C.base}/api/audit/readiness`)).json()) as any;
    const storage = (ready.checks || []).find((c: any) => c.name === 'storage');
    check('deep readiness reports the storage as a postgres store that survives restarts', [storage?.ok, /postgres store works and survives restarts/.test(storage?.detail || '')], [true, true]);
    check('...and readiness needs a session', (await rawFetch(`${C.base}/api/audit/readiness`)).status, 401);
  } finally {
    for (const p of procs) p.kill();
    fake.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
}

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) await run(url);
  else if (process.env.REQUIRE_POSTGRES === '1') check('TEST_DATABASE_URL is set (REQUIRE_POSTGRES=1 says the PostgreSQL checks must run)', false, true);
  else console.log('SKIP  the PostgreSQL end-to-end checks were NOT RUN: set TEST_DATABASE_URL to a throwaway database (scripts/pg-test-cluster.sh starts one). CI runs them.');
  console.log(failures === 0 ? '\nPostgreSQL end-to-end checks finished.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('PostgreSQL end-to-end harness error:', err);
  process.exit(1);
});
