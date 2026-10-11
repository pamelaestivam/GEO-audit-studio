/**
 * End to end, against the real built server and a fake Gemini that goes quiet: a request that is accepted and never
 * answered must end as an ordinary, reported timeout, and must not hold up the calls behind it.
 *
 * Before: the Gemini client set no HTTP timeout and every call runs behind the one before it (scheduleGeminiCall), so
 * one request that never answered held every later call in the process (brand lookup, query generation, the readiness
 * probe, every audit) behind it for as long as Node's own fetch took to give up on a silent server (about 301 s per
 * attempt), and nothing reported it. The audit's job row was reaped after 15 minutes, but the queue stayed blocked in
 * the meantime. This test shows the hold for as long as it waits (25 to 60 s) with the limit removed.
 *
 * Proved here, with the limit set short (GEMINI_HTTP_TIMEOUT_MS=1500):
 *   1. an audit whose first Gemini request never answers still completes, because the timeout is retried like any
 *      other transient error; the hung request is counted (3 hits = 1 hung + 1 retry + the narrative);
 *   2. a brand lookup (which never retries) against a provider that never answers comes back within seconds as an
 *      honest "not detected" with a sentence, and the very next lookup, with the provider answering again, is served
 *      at once with exactly one more hit, so the queue was not left blocked;
 *   3. a GEMINI_HTTP_TIMEOUT_MS that is not a number does not stop the server starting or an audit completing (that the
 *      value is refused and the default used is the rule in src/httpTimeout.ts, tested by test/httpTimeout.test.ts).
 *
 * Needs a current dist/. Run: npx tsx test/geminiTimeoutE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch } from './authHelper';
import { randomPort } from './ports';
import { captureOutput, printCaptured, type CapturedOutput } from './serverOutput';

installAuthFetch();

let failures = 0;
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

const GEMINI_PORT = randomPort(7500, 100);
const APP_PORT = randomPort(7600, 300);
const BASE = `http://127.0.0.1:${APP_PORT}`;
let mode: FakeMode = 'hang_first';

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let lastOutput: CapturedOutput | null = null;

function spawnApp(extraEnv: Record<string, string>): ChildProcess {
  const proc = spawn('node', ['dist/server.cjs'], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  lastOutput = captureOutput(proc);
  return proc;
}

async function runOneQueryAudit(timeoutMs: number) {
  const start = await fetch(`${BASE}/api/audit/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': Math.random().toString(36) },
    body: JSON.stringify({
      businessName: 'Poke House',
      domain: 'poke.house',
      queries: [{ id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' }],
    }),
  });
  const { jobId } = await start.json();
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const d = await (await fetch(`${BASE}/api/audit/job/${jobId}`)).json();
    if (d.status !== 'running') return { final: d, ms: Date.now() - began, submitStatus: start.status };
  }
  return { final: null as any, ms: Date.now() - began, submitStatus: start.status };
}

async function lookup(input: string) {
  const began = Date.now();
  try {
    return await lookupOnce(input, began);
  } catch (err: any) {
    return { status: 0, body: { error: String(err?.message || err) }, ms: Date.now() - began };
  }
}

async function lookupOnce(input: string, began: number) {
  const res = await fetch(`${BASE}/api/audit/parse-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': Math.random().toString(36) },
    body: JSON.stringify({ input }),
    // so a missing fix FAILS this check instead of hanging the whole run
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, body: await res.json(), ms: Date.now() - began };
}

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  let app: ChildProcess | null = spawnApp({ GEMINI_HTTP_TIMEOUT_MS: '1500' });
  try {
    const up = await waitForServer();
    assert('the app server starts against the fake endpoint', up);
    if (!up) {
      process.exitCode = 1; // a failed start is a failed run: returning here skips the exit status below
      return;
    }

    // ---- 1. the first request of an audit never answers
    const audit = await runOneQueryAudit(60000);
    assert('the audit was accepted', audit.submitStatus === 202, `submit status ${audit.submitStatus}`);
    assert('an audit whose first Gemini request never answers still completes', audit.final?.status === 'done', JSON.stringify(audit.final?.status));
    assert('it is not marked degraded: the timeout was retried like any transient error', audit.final?.report?.degraded !== true, JSON.stringify(audit.final?.report?.degradedReason));
    assert('the hung request is counted: 1 hung + 1 retry + the narrative = 3 hits', fake.hits() === 3, `hits ${fake.hits()}`);
    assert('it took seconds, not minutes (the 1.5 s limit plus one 5 s retry pause)', audit.ms < 30000, `${audit.ms} ms`);

    // ---- 2. a lookup (no retries) against a provider that never answers, then one that does
    mode = 'hang';
    const before = fake.hits();
    const hung = await lookup('Acme Widgets');
    assert('a brand lookup against a provider that never answers comes back within seconds', hung.ms < 10000, `${hung.ms} ms`);
    assert('it makes exactly one request (a lookup never retries)', fake.hits() - before === 1, `hit delta ${fake.hits() - before}`);
    assert('the person gets an honest "not detected" with a sentence', hung.status === 200 && hung.body?.detected === false && typeof hung.body?.reason === 'string' && hung.body.reason.length > 10, JSON.stringify(hung.body).slice(0, 300));
    assert('the sentence is not a raw error', !/AbortError|The operation was aborted|stack|at \w+\.\w+ \(/.test(String(hung.body?.reason)), String(hung.body?.reason));

    mode = 'ok';
    const mid = fake.hits();
    const next = await lookup('Acme Widgets');
    assert('with the provider answering again the next lookup is served at once (the queue was not left blocked)', next.ms < 5000 && next.status === 200, `${next.ms} ms, status ${next.status}`);
    assert('and it costs exactly one request', fake.hits() - mid === 1, `hit delta ${fake.hits() - mid}`);

    // ---- 3. a value that is not a number is refused, the default is used, the server still serves
    app.kill();
    await new Promise((r) => setTimeout(r, 500));
    mode = 'ok';
    app = spawnApp({ GEMINI_HTTP_TIMEOUT_MS: 'soon' });
    const badValueOutput = lastOutput as CapturedOutput | null;
    const up2 = await waitForServer();
    assert('a bad GEMINI_HTTP_TIMEOUT_MS does not stop the server starting', up2);
    if (up2) {
      assert('the server says it refused the value and what it uses instead', /GEMINI_HTTP_TIMEOUT_MS="soon" is not a number of milliseconds between 100 and 2147483647; using 90000\./.test(badValueOutput?.text() ?? ''), badValueOutput?.text().slice(-400));
      const ok = await runOneQueryAudit(60000);
      assert('and an audit still completes with the default limit', ok.final?.status === 'done' && ok.final?.report?.degraded !== true, JSON.stringify(ok.final?.status));
    } else {
      process.exitCode = 1;
    }
  } finally {
    if (failures > 0) printCaptured('app server', lastOutput);
    app?.kill();
    (fake as any).closeAllConnections?.();
    fake.close();
  }
  console.log(failures === 0 ? '\nGemini timeout checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
