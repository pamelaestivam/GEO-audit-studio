/**
 * End-to-end proof of the foundation: real sign-in enforced on every spending
 * route, audits and jobs that survive a restart, ownership between users, and
 * per-user daily budgets - all against the real built server (dist/server.cjs)
 * with a fake Gemini endpoint at the far end.
 *
 * Each group maps to something that was true of the placeholder it replaced:
 * any email + any password signed in, the "token" was checked by nothing,
 * POST /api/audit/run with no credentials started spending quota, and a
 * restart (or a refresh) destroyed a finished audit.
 *
 * Needs a current dist/. Run: npx tsx test/foundationE2E.test.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_ACCESS_CODE, TEST_AUTH_ENV, rawFetch } from './authHelper';

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

const GEMINI_PORT = 4900 + Math.floor(Math.random() * 100);
let nextPort = 5100 + Math.floor(Math.random() * 400);
let mode: FakeMode = 'ok';

interface App {
  base: string;
  proc: ChildProcess;
  port: number;
}

async function startApp(extraEnv: Record<string, string> = {}, port = nextPort++, unset: string[] = []): Promise<App | null> {
  const childEnv: Record<string, string | undefined> = {
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
  };
  for (const key of unset) delete childEnv[key];
  const proc = spawn('node', ['dist/server.cjs'], { env: childEnv as NodeJS.ProcessEnv, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      if ((await rawFetch(`${base}/api/health`)).ok) return { base, proc, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  return null;
}

async function stopApp(app: App, signal: NodeJS.Signals = 'SIGTERM') {
  await new Promise<void>((resolve) => {
    app.proc.once('exit', () => resolve());
    app.proc.kill(signal);
    setTimeout(resolve, 3000);
  });
}

async function login(app: App, email: string, accessCode = TEST_ACCESS_CODE) {
  const res = await rawFetch(`${app.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, accessCode }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const BIZ = {
  businessName: 'Poke House',
  domain: 'poke.house',
  queries: [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }],
};

async function startAudit(app: App, token: string, body: any = BIZ, extraHeaders: Record<string, string> = {}) {
  const res = await rawFetch(`${app.base}/api/audit/run`, {
    method: 'POST',
    headers: { ...authed(token), ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

async function pollJob(app: App, token: string, jobId: string, timeoutMs = 30000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    const res = await rawFetch(`${app.base}/api/audit/job/${jobId}`, { headers: authed(token) });
    const body = await res.json().catch(() => ({}));
    if (body.status === 'running') {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    return { status: res.status, body };
  }
  return { status: 0, body: { status: 'timeout' } as any };
}

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const apps: App[] = [];
  const tmpDirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-e2e-'));
    tmpDirs.push(d);
    return d;
  };

  try {
    // ==================================================================
    // 1. A configured server with durable storage.
    // ==================================================================
    const dataDir = tmp();
    const A = await startApp({ DATA_DIR: dataDir });
    assert('configured server starts', !!A);
    if (!A) return;
    apps.push(A);

    // --- public surface
    const status = await (await rawFetch(`${A.base}/api/audit/status`)).json();
    check('status is public and reports sign-in is configured', status.auth?.mode, 'configured');
    check('status reports durable sqlite storage', [status.storage?.kind, status.storage?.durable], ['sqlite', true]);
    const health = await (await rawFetch(`${A.base}/api/health`)).json();
    check('health reports durable storage', health.storage, { kind: 'sqlite', durable: true });

    check('the compiled backend bundle is not downloadable', (await rawFetch(`${A.base}/server.cjs`)).status, 404);
    check('...nor its source map', (await rawFetch(`${A.base}/server.cjs.map`)).status, 404);
    check('the frontend itself is still served', (await rawFetch(`${A.base}/`)).status, 200);

    // --- nothing that spends or reads saved work is open
    const noAuthRun = await rawFetch(`${A.base}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BIZ),
    });
    check('POST /api/audit/run with no token is refused', noAuthRun.status, 401);
    const noAuthBody = await noAuthRun.json();
    assert('...with a sentence that says what to do', /sign in/i.test(noAuthBody.error), JSON.stringify(noAuthBody));
    check('...and a machine-readable code', noAuthBody.code, 'auth_required');
    for (const [method, route] of [
      ['POST', '/api/audit/parse-url'],
      ['POST', '/api/audit/generate-queries'],
      ['POST', '/api/audit/evaluate-query'],
      ['GET', '/api/audit/job/anything'],
      ['GET', '/api/audits'],
      ['GET', '/api/audits/anything'],
      ['DELETE', '/api/audits/anything'],
      ['GET', '/api/auth/me'],
    ] as const) {
      const r = await rawFetch(`${A.base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      check(`${method} ${route} needs a session`, r.status, 401);
    }
    check('the old placeholder token is not a session', (await rawFetch(`${A.base}/api/audits`, { headers: { Authorization: `Bearer token-${Date.now()}` } })).status, 401);
    check('the removed signup route is gone', (await rawFetch(`${A.base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    check('Gemini was not called by any refused request', fake.hits(), 0);

    // --- sign in
    const wrongCode = await login(A, 'alice@example.com', 'not-the-code');
    check('a wrong access code is refused', wrongCode.status, 401);
    assert('...with a sentence', /access code is not valid/i.test(wrongCode.body.error), JSON.stringify(wrongCode.body));
    check('a bad email is refused', (await login(A, 'not-an-email')).status, 400);
    const missingCode = await rawFetch(`${A.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice@example.com' }) });
    check('a missing code is refused', missingCode.status, 401);
    const alice = await login(A, 'Alice@Example.com');
    check('a right code signs in', alice.status, 200);
    check('...as the normalised email', alice.body.user?.email, 'alice@example.com');
    assert('...with a token and expiry', typeof alice.body.token === 'string' && alice.body.expiresAt > Date.now());
    const me = await rawFetch(`${A.base}/api/auth/me`, { headers: authed(alice.body.token) });
    check('the token is accepted by /api/auth/me', me.status, 200);
    const tampered = alice.body.token.slice(0, -3) + 'AAA';
    check('a tampered token is refused', (await rawFetch(`${A.base}/api/auth/me`, { headers: authed(tampered) })).status, 401);
    const bob = await login(A, 'bob@example.com');

    // --- an audit, end to end, saved
    const run = await startAudit(A, alice.body.token);
    check('a signed-in audit is accepted', run.status, 202);
    const done = await pollJob(A, alice.body.token, run.body.jobId);
    check('it completes', done.body.status, 'done');
    check('it was saved durably', done.body.saved, true);
    assert('it is a real, undegraded report', !!done.body.report && done.body.report.degraded !== true);
    const reportId = done.body.report.id;
    assert('report ids are unique, not just a timestamp', /^audit-\d+-[0-9a-f]{8}$/.test(reportId), reportId);

    const list = await (await rawFetch(`${A.base}/api/audits`, { headers: authed(alice.body.token) })).json();
    check('the saved audit is listed for its owner', list.audits.map((a: any) => a.id), [reportId]);
    assert('the list carries headline numbers but no evidence', typeof list.audits[0].geoVisibilityScore === 'number' && !('queriesTested' in list.audits[0]));
    const full = await (await rawFetch(`${A.base}/api/audits/${reportId}`, { headers: authed(alice.body.token) })).json();
    check('the full report can be fetched', full.audit?.id, reportId);
    assert('...with its evidence', full.audit.queriesTested?.[0]?.evidence?.[0]?.answerText?.length > 20);

    // --- ownership
    const bobList = await (await rawFetch(`${A.base}/api/audits`, { headers: authed(bob.body.token) })).json();
    check("another user's list does not include it", bobList.audits, []);
    check("another user cannot read it", (await rawFetch(`${A.base}/api/audits/${reportId}`, { headers: authed(bob.body.token) })).status, 404);
    check("another user cannot delete it", (await rawFetch(`${A.base}/api/audits/${reportId}`, { method: 'DELETE', headers: authed(bob.body.token) })).status, 404);
    const bobPollsAlice = await rawFetch(`${A.base}/api/audit/job/${run.body.jobId}`, { headers: authed(bob.body.token) });
    check("another user cannot poll someone else's job", bobPollsAlice.status, 404);
    const sameKey = { 'Idempotency-Key': 'shared-key-123' };
    const aliceKeyed = await startAudit(A, alice.body.token, BIZ, sameKey);
    const bobKeyed = await startAudit(A, bob.body.token, BIZ, sameKey);
    assert('the same Idempotency-Key from two users starts two audits, never hands over a job', aliceKeyed.body.jobId !== bobKeyed.body.jobId, `${aliceKeyed.body.jobId} vs ${bobKeyed.body.jobId}`);
    await pollJob(A, alice.body.token, aliceKeyed.body.jobId);
    await pollJob(A, bob.body.token, bobKeyed.body.jobId);

    // --- failed audits are shown but not kept
    mode = 'unauthorized';
    const failedRun = await startAudit(A, alice.body.token);
    const failed = await pollJob(A, alice.body.token, failedRun.body.jobId);
    check('a fully failed audit is reported as degraded', failed.body.report?.degraded, true);
    check('...and is not saved', failed.body.saved, false);
    mode = 'ok';
    const afterFail = await (await rawFetch(`${A.base}/api/audits`, { headers: authed(alice.body.token) })).json();
    check('...so history holds only real audits', afterFail.audits.length, 2);

    // --- survives a restart (the point of all this)
    await stopApp(A);
    const A2 = await startApp({ DATA_DIR: dataDir }, A.port);
    assert('the server restarts on the same data directory', !!A2);
    if (!A2) return;
    apps.push(A2);
    const afterRestart = await (await rawFetch(`${A2.base}/api/audits`, { headers: authed(alice.body.token) })).json();
    check('after a restart the same session still works (stateless token)', afterRestart.audits?.length, 2);
    check('...and the audit is still there', afterRestart.audits.some((a: any) => a.id === reportId), true);
    const fullAfter = await (await rawFetch(`${A2.base}/api/audits/${reportId}`, { headers: authed(alice.body.token) })).json();
    check('...in full', fullAfter.audit?.queriesTested?.length, full.audit.queriesTested.length);
    const oldJob = await rawFetch(`${A2.base}/api/audit/job/${run.body.jobId}`, { headers: authed(alice.body.token) });
    check('a finished job can still be polled after a restart', (await oldJob.json()).status, 'done');

    // --- an audit running when the server dies is failed honestly, not lost
    mode = 'slow';
    const inflight = await startAudit(A2, alice.body.token);
    check('a slow audit is accepted', inflight.status, 202);
    await new Promise((r) => setTimeout(r, 400));
    await stopApp(A2, 'SIGKILL');
    mode = 'ok';
    const A3 = await startApp({ DATA_DIR: dataDir }, A.port);
    assert('the server restarts after being killed mid-audit', !!A3);
    if (!A3) return;
    apps.push(A3);
    const orphan = await rawFetch(`${A3.base}/api/audit/job/${inflight.body.jobId}`, { headers: authed(alice.body.token) });
    const orphanBody = await orphan.json();
    check('the orphaned job is reported as failed, not stuck "running"', [orphan.status, orphanBody.status], [500, 'error']);
    assert('...with a sentence that says what happened', /restarted/i.test(orphanBody.error), JSON.stringify(orphanBody));

    // --- delete
    const del = await rawFetch(`${A3.base}/api/audits/${reportId}`, { method: 'DELETE', headers: authed(alice.body.token) });
    check('the owner can delete a saved audit', del.status, 200);
    check('...and it is gone', (await rawFetch(`${A3.base}/api/audits/${reportId}`, { headers: authed(alice.body.token) })).status, 404);

    // --- deep readiness: a real call, said as such, cached
    const hitsBefore = fake.hits();
    const ready = await (await rawFetch(`${A3.base}/api/audit/readiness`, { headers: authed(alice.body.token) })).json();
    check('readiness passes on a healthy deployment', ready.ok, true);
    const byName = Object.fromEntries(ready.checks.map((c: any) => [c.name, c]));
    check('...it made one real Gemini call', fake.hits() - hitsBefore, 1);
    check('...and says gemini was verified', [byName.gemini.ok, byName.gemini.verified], [true, true]);
    check('...storage is verified durable', [byName.storage.ok, byName.storage.verified], [true, true]);
    check('...sign-in is verified configured', byName['sign-in'].ok, true);
    const again = await (await rawFetch(`${A3.base}/api/audit/readiness`, { headers: authed(alice.body.token) })).json();
    check('a repeat within minutes is served from cache, costing no quota', [again.cached, fake.hits() - hitsBefore], [true, 1]);
    check('readiness needs a session', (await rawFetch(`${A3.base}/api/audit/readiness`)).status, 401);

    // --- the post-deploy smoke script, run for real against a real server
    const runSmoke = (base: string, extra: string[] = []) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('node', ['scripts/smoke.mjs', base, ...extra], { env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' } });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) => resolve({ code, out }));
      });
    const smokeGood = await runSmoke(A3.base, ['--email', 'smoke@example.com', '--code', TEST_ACCESS_CODE]);
    check('the smoke script passes against a healthy, configured, durable deployment', smokeGood.code, 0);
    assert('...and exercised sign-in and readiness', /signing in with the supplied credentials works/.test(smokeGood.out) && /readiness: gemini/.test(smokeGood.out), smokeGood.out.slice(-600));

    // ==================================================================
    // 2. A revoked access code ends the sessions it created.
    // ==================================================================
    const R1 = await startApp({ ACCESS_CODES: `${TEST_ACCESS_CODE},second-code-99` });
    assert('server with two codes starts', !!R1);
    if (R1) {
      apps.push(R1);
      const viaSecond = await login(R1, 'carol@example.com', 'second-code-99');
      check('the second code signs in', viaSecond.status, 200);
      await stopApp(R1);
      const R2 = await startApp({ ACCESS_CODES: TEST_ACCESS_CODE }, R1.port);
      if (R2) {
        apps.push(R2);
        const res = await rawFetch(`${R2.base}/api/auth/me`, { headers: authed(viaSecond.body.token) });
        check('after the code is withdrawn its session is refused', res.status, 401);
        assert('...with a sentence that says why', /withdrawn/i.test((await res.json()).error));
      }
    }

    // ==================================================================
    // 3. Daily budgets: per user, and failures that cost nothing do not count.
    // ==================================================================
    const B = await startApp({ USER_AUDITS_PER_DAY: '2', GLOBAL_AUDITS_PER_DAY: '3', MAX_CONCURRENT_AUDITS: '5' });
    assert('server with budgets starts', !!B);
    if (B) {
      apps.push(B);
      const u1 = (await login(B, 'u1@example.com')).body.token;
      const u2 = (await login(B, 'u2@example.com')).body.token;
      const u3 = (await login(B, 'u3@example.com')).body.token;

      mode = 'unauthorized';
      const free = await startAudit(B, u1);
      await pollJob(B, u1, free.body.jobId);
      mode = 'ok';

      const first = await startAudit(B, u1);
      await pollJob(B, u1, first.body.jobId);
      const second = await startAudit(B, u1);
      await pollJob(B, u1, second.body.jobId);
      check('a failed audit that collected no evidence did not use the budget (two real audits fit)', [first.status, second.status], [202, 202]);

      const third = await startAudit(B, u1);
      check('the third real audit in 24 hours is refused', third.status, 429);
      assert('...with a sentence that says the limit and when it frees up', /2 audits for the last 24 hours/.test(third.body.error) && /frees up in about/.test(third.body.error), JSON.stringify(third.body));
      assert('...and a Retry-After header', Number(third.headers.get('retry-after')) > 0);

      const replay = await startAudit(B, u1, BIZ, { 'Idempotency-Key': 'replay-me' });
      check('a further audit from the same user is refused, even under a new key', replay.status, 429);
      check("another user is not affected by the first user's limit", (await startAudit(B, u2)).status, 202);

      // global: u1 used 2, u2 used 1 -> 3 = the global limit
      const globalRefused = await startAudit(B, u3);
      check('the global daily limit stops everyone once reached', globalRefused.status, 429);
      assert('...and says it is a service-wide limit', /This service has reached its limit of 3 audits/.test(globalRefused.body.error), JSON.stringify(globalRefused.body));
    }

    // ==================================================================
    // 4. No DATA_DIR: honest about not saving.
    // ==================================================================
    const M = await startApp({});
    assert('server without DATA_DIR starts', !!M);
    if (M) {
      apps.push(M);
      const s = await (await rawFetch(`${M.base}/api/audit/status`)).json();
      check('status says storage is not durable', [s.storage.kind, s.storage.durable], ['memory', false]);
      assert('...and says why', /DATA_DIR/.test(s.storage.note), JSON.stringify(s.storage));
      const t = (await login(M, 'm@example.com')).body.token;
      const r = await startAudit(M, t);
      const d = await pollJob(M, t, r.body.jobId);
      check('an audit still runs', d.body.status, 'done');
      check('...but is reported as not saved', d.body.saved, false);
    }

    // --- readiness reports a rejected key as a sentence, and a missing one as missing
    const RB = await startApp({});
    if (RB) {
      apps.push(RB);
      mode = 'unauthorized';
      const t2 = (await login(RB, 'r@example.com')).body.token;
      const bad = await (await rawFetch(`${RB.base}/api/audit/readiness`, { headers: authed(t2) })).json();
      check('a rejected key fails readiness', bad.ok, false);
      const g = bad.checks.find((c: any) => c.name === 'gemini');
      assert('...with a sentence naming the model and the problem', /rejected the API key/.test(g.detail) && /model:/.test(g.detail) && !g.detail.includes('{'), g.detail);
      assert('...and no raw provider payload', !JSON.stringify(bad).includes('SECRET_PAYLOAD_MARKER'));
      assert('non-durable storage is flagged by readiness too', bad.checks.find((c: any) => c.name === 'storage').ok === false);
      mode = 'ok';
    }
    const NK = await startApp({ GEMINI_API_KEY: '' });
    if (NK) {
      apps.push(NK);
      const t3 = (await login(NK, 'nk@example.com')).body.token;
      const missing = await (await rawFetch(`${NK.base}/api/audit/readiness`, { headers: authed(t3) })).json();
      assert('a missing Gemini key is reported as missing', /GEMINI_API_KEY is not set/.test(missing.checks.find((c: any) => c.name === 'gemini').detail));
    }

    // ==================================================================
    // 5. Unconfigured production never falls open.
    // ==================================================================
    const U = await startApp({ SESSION_SECRET: '', ACCESS_CODES: '' });
    assert('an unconfigured server still starts (so it can say why)', !!U);
    if (U) {
      apps.push(U);
      const s = await (await rawFetch(`${U.base}/api/audit/status`)).json();
      check('status reports sign-in as unconfigured', s.auth.mode, 'unconfigured');
      assert('...and names what the operator must set', /SESSION_SECRET/.test(s.auth.problem) && /ACCESS_CODES/.test(s.auth.problem), s.auth.problem);
      const l = await login(U, 'x@example.com', 'anything-at-all');
      const smokeBad = await runSmoke(U.base);
    check('the smoke script FAILS against an unconfigured deployment', smokeBad.code, 1);
    assert('...and names sign-in and storage as the problems', /FAIL  sign-in is configured/.test(smokeBad.out) && /FAIL  storage is durable/.test(smokeBad.out), smokeBad.out.slice(-700));
    check('sign-in is refused with 503, not accepted', l.status, 503);
      check('...with the same sentence', l.body.code, 'auth_unconfigured');
      const run = await rawFetch(`${U.base}/api/audit/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' }, body: JSON.stringify(BIZ) });
      check('spending routes are refused with 503, not opened', run.status, 503);
    }

    // ==================================================================
    // 6. Findings from the independent adversarial review.
    // ==================================================================

    // --- ownership is by (code label, email), not the claimed email alone
    const L = await startApp({ ACCESS_CODES: 'anna=anna-code-1234,ben=ben-code-56789' });
    assert('server with labelled codes starts', !!L);
    if (L) {
      apps.push(L);
      const annaSam = (await login(L, 'sam@example.com', 'anna-code-1234')).body;
      const benSam = (await login(L, 'SAM@example.com', 'ben-code-56789')).body;
      assert('the same email signs in under two codes', !!annaSam.token && !!benSam.token);
      check('...as two different identities', annaSam.user.id === benSam.user.id, false);
      const r1 = await startAudit(L, annaSam.token);
      const d1 = await pollJob(L, annaSam.token, r1.body.jobId);
      const id1 = d1.body.report.id;
      check("the owner sees their audit", (await (await rawFetch(`${L.base}/api/audits`, { headers: authed(annaSam.token) })).json()).audits.length, 1);
      check("someone typing their email under another code sees NOTHING", (await (await rawFetch(`${L.base}/api/audits`, { headers: authed(benSam.token) })).json()).audits.length, 0);
      check("...cannot open it", (await rawFetch(`${L.base}/api/audits/${id1}`, { headers: authed(benSam.token) })).status, 404);
      check("...cannot delete it", (await rawFetch(`${L.base}/api/audits/${id1}`, { method: 'DELETE', headers: authed(benSam.token) })).status, 404);
      check("...cannot poll its job", (await rawFetch(`${L.base}/api/audit/job/${r1.body.jobId}`, { headers: authed(benSam.token) })).status, 404);
    }

    // --- every spending route is budgeted, not just /run
    const LK = await startApp({ USER_LOOKUPS_PER_HOUR: '2' });
    assert('server with a lookup limit starts', !!LK);
    if (LK) {
      apps.push(LK);
      const t = (await login(LK, 'lk@example.com')).body.token;
      const evalQ = (n: number) => rawFetch(`${LK.base}/api/audit/evaluate-query`, { method: 'POST', headers: { ...authed(t), 'Idempotency-Key': `lk-${n}` }, body: JSON.stringify({ businessName: 'Poke House', queryText: `best poke ${n}` }) });
      const before = fake.hits();
      const statuses = [(await evalQ(1)).status, (await evalQ(2)).status, (await evalQ(3)).status];
      check('two quick lookups are served; the third in the hour is refused', statuses, [200, 200, 429]);
      const refused = await (await evalQ(4)).json();
      assert('...with a sentence that says the limit', /30|2 quick lookups/.test(refused.error) && /Try again/i.test(refused.error), JSON.stringify(refused));
      check('the refused lookups made no Gemini calls', fake.hits() - before, 2);
      check('a refused lookup sets Retry-After', Number((await evalQ(5)).headers.get('retry-after')) > 0, true);
      const parse = await rawFetch(`${LK.base}/api/audit/parse-url`, { method: 'POST', headers: authed(t), body: JSON.stringify({ input: 'Poke House' }) });
      check('brand detection counts toward the same limit', parse.status, 429);
    }

    // --- readiness: concurrent cold requests share one check
    const RD = await startApp({});
    if (RD) {
      apps.push(RD);
      const t = (await login(RD, 'rd@example.com')).body.token;
      const before = fake.hits();
      const all = await Promise.all(Array.from({ length: 15 }, () => rawFetch(`${RD.base}/api/audit/readiness`, { headers: authed(t) }).then((r) => r.json())));
      check('15 simultaneous cold readiness requests all answer', all.every((r) => Array.isArray(r.checks)), true);
      check('...and made ONE real Gemini call between them, not one each', fake.hits() - before, 1);
    }

    // --- a restart or deploy must not cost anyone their daily allowance
    const orphanDir = tmp();
    const O1 = await startApp({ DATA_DIR: orphanDir, USER_AUDITS_PER_DAY: '1', GLOBAL_AUDITS_PER_DAY: '0' });
    if (O1) {
      apps.push(O1);
      const t = (await login(O1, 'orphan@example.com')).body.token;
      mode = 'slow';
      const started = await startAudit(O1, t, BIZ, { 'Idempotency-Key': 'orphan-click' });
      check('the audit starts', started.status, 202);
      await new Promise((r) => setTimeout(r, 400));
      await stopApp(O1, 'SIGKILL');
      mode = 'ok';
      const O2 = await startApp({ DATA_DIR: orphanDir, USER_AUDITS_PER_DAY: '1', GLOBAL_AUDITS_PER_DAY: '0' }, O1.port);
      if (O2) {
        apps.push(O2);
        const fresh = await startAudit(O2, t, BIZ);
        check('after the crash the person can run their one audit of the day (the orphan was not counted)', fresh.status, 202);
        const replay = await startAudit(O2, t, BIZ, { 'Idempotency-Key': 'orphan-click' });
        check('replaying the orphaned click returns the same job', replay.body.jobId, started.body.jobId);
        check('...and says what that job IS now (failed), not "running"', replay.body.status, 'error');
      }
    }

    // --- the per-IP limits cannot be dodged by choosing your own X-Forwarded-For
    const XF = await startApp({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    if (XF) {
      apps.push(XF);
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await rawFetch(`${XF.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${i}` }, body: JSON.stringify({ email: 'a@example.com', accessCode: 'wrong-code-000' }) });
        codes.push(r.status);
      }
      check('with no proxy configured, a spoofed X-Forwarded-For does not buy more guesses', codes, [401, 401, 401, 429, 429, 429]);
      const health = await (await rawFetch(`${XF.base}/api/health`)).json();
      check('health reports that no proxy is trusted', health.trustProxyHops, 0);
    }
    const XT = await startApp({ AUTH_RATE_LIMIT_PER_MIN: '3', TRUST_PROXY: '1' });
    if (XT) {
      apps.push(XT);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await rawFetch(`${XT.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${i}` }, body: JSON.stringify({ email: 'a@example.com', accessCode: 'wrong-code-000' }) });
        codes.push(r.status);
      }
      check('when a proxy IS declared (TRUST_PROXY=1), the address it reports is what is limited', codes, [401, 401, 401, 401]);
      check('health reports the trusted hop count', (await (await rawFetch(`${XT.base}/api/health`)).json()).trustProxyHops, 1);
    }

    // --- a plain `node dist/server.cjs` with NODE_ENV unset and no config does not open the door
    const NE = await startApp({ SESSION_SECRET: '', ACCESS_CODES: '', ALLOW_DEV_AUTH: '1' }, nextPort++, ['NODE_ENV']);
    assert('a server started with NODE_ENV unset starts', !!NE);
    if (NE) {
      apps.push(NE);
      const st = await (await rawFetch(`${NE.base}/api/audit/status`)).json();
      check('it is unconfigured, not "dev mode"', st.auth.mode, 'unconfigured');
      const l = await login(NE, 'anyone@evil.example', 'dev-access');
      check('the publicly known dev code does not sign anyone in', l.status, 503);
    }

    // --- the public status endpoint does not leak filesystem paths or OS errors
    const blocker = path.join(os.tmpdir(), `geo-e2e-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'x');
    tmpDirs.push(blocker);
    const BK = await startApp({ DATA_DIR: path.join(blocker, 'sub') });
    if (BK) {
      apps.push(BK);
      const st = await (await rawFetch(`${BK.base}/api/audit/status`)).json();
      check('a database that cannot be opened is reported as non-durable', st.storage.durable, false);
      assert('...with a note that names no path and no OS error', !/\/|ENOTDIR|ENOENT|geo-e2e-blocker/.test(st.storage.note), st.storage.note);
      check('HEAD on the public status endpoint works (for HEAD-based monitors)', (await rawFetch(`${BK.base}/api/audit/status`, { method: 'HEAD' })).status, 200);
    }

    // --- the report says when every question names the brand
    const BR = await startApp({});
    if (BR) {
      apps.push(BR);
      const t = (await login(BR, 'br@example.com')).body.token;
      const dflt = await startAudit(BR, t, { businessName: 'Poke House', domain: 'poke.house' });
      const dd = await pollJob(BR, t, dflt.body.jobId);
      check('default queries with no industry: all three name the brand, and the report says so', [dd.body.report.queriesNamingBrand, dd.body.report.queriesAttempted], [3, 3]);
      const withIndustry = await startAudit(BR, t, { businessName: 'Poke House', domain: 'poke.house', industry: 'poke restaurants' });
      const wd = await pollJob(BR, t, withIndustry.body.jobId);
      check('with an industry, the discovery question is brand-neutral', [wd.body.report.queriesNamingBrand, wd.body.report.queriesAttempted], [2, 3]);
      const own = await pollJob(BR, t, (await startAudit(BR, t, BIZ)).body.jobId);
      check('a person\'s own category question does not name the brand', [own.body.report.queriesNamingBrand, own.body.report.queriesAttempted], [0, 1]);
    }
  } finally {
    for (const a of apps) a.proc.kill('SIGKILL');
    fake.close();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll foundation checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Foundation test harness error:', err);
  process.exit(1);
});
