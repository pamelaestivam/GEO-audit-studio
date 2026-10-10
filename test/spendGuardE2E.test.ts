/**
 * End to end, against the real built server and a fake Gemini: the $0 guard.
 *  - paid engine keys in the environment are ignored unless ALLOW_PAID_ENGINES=1, and say so in /api/audit/status;
 *  - the Gemini call counter equals the number of requests the fake really received (counted at the boundary);
 *  - a daily cap stops calls exactly at the cap, the audit says why in a sentence, and no further request is made.
 *
 * Needs a current dist/. Run: npx tsx test/spendGuardE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
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

const GEMINI_PORT = 8100 + Math.floor(Math.random() * 100);
const APP_PORT = 8200 + Math.floor(Math.random() * 90);
const mode: FakeMode = 'ok';

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const apps: ChildProcess[] = [];
  const spawnApp = (port: number, extraEnv: Record<string, string> = {}) => {
    const p = spawn('node', ['dist/server.cjs'], {
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
    apps.push(p);
    return `http://127.0.0.1:${port}`;
  };
  // Paid keys present, no opt-in; paid keys present WITH opt-in (status only: an audit would call the real providers).
  const paidOff = spawnApp(APP_PORT, { OPENAI_API_KEY: 'sk-test-not-real', PERPLEXITY_API_KEY: 'pplx-test-not-real' });
  const paidOn = spawnApp(APP_PORT + 1, { OPENAI_API_KEY: 'sk-test-not-real', ALLOW_PAID_ENGINES: '1' });
  const capped = spawnApp(APP_PORT + 2, { GEMINI_DAILY_CALL_CAP: '2' });

  const status = async (b: string) => (await fetch(`${b}/api/audit/status`)).json();
  async function runAudit(b: string): Promise<any> {
    const start = await fetch(`${b}/api/audit/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Poke House',
        domain: 'poke.house',
        queries: [
          { id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' },
          { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' },
        ],
      }),
    });
    const { jobId } = await start.json();
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d = await (await fetch(`${b}/api/audit/job/${jobId}`)).json();
      if (d.status !== 'running') return d.report ?? d;
    }
    return null;
  }

  try {
    for (let i = 0; i < 80; i++) {
      try {
        const ups = await Promise.all([paidOff, paidOn, capped].map((b) => fetch(`${b}/api/health`).then((r) => r.ok).catch(() => false)));
        if (ups.every(Boolean)) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // ---- paid engines
    let s = await status(paidOff);
    check('paid keys without the opt-in: only Gemini is queried', s.engines, ['Gemini']);
    check('...and the status names what was switched off', s.spend.paidEnginesBlocked, ['ChatGPT', 'Perplexity']);
    s = await status(paidOn);
    check('with ALLOW_PAID_ENGINES=1 the paid engine is queried', s.engines, ['Gemini', 'ChatGPT']);
    check('...and nothing is reported as switched off', s.spend.paidEnginesBlocked, []);

    // ---- the counter equals the real requests
    check('the call counter starts at zero', (await status(paidOff)).spend.geminiCallsToday, 0);
    const before = fake.hits();
    const report = await runAudit(paidOff);
    const made = fake.hits() - before;
    check('the audit completes on Gemini alone', [report?.degraded !== true, report?.measuredEngines], [true, ['Gemini']]);
    check('the server counted exactly the Gemini requests the fake really received', (await status(paidOff)).spend.geminiCallsToday, made);
    check('...and that is the expected minimum (2 questions + the written analysis)', made, 3);
    check('the status says the count is for this instance only', (await status(paidOff)).spend.scope, 'this server instance only');

    // ---- the cap
    const hitsBeforeCap = fake.hits();
    const cappedReport = await runAudit(capped);
    const cappedMade = fake.hits() - hitsBeforeCap;
    check('with a cap of 2, exactly 2 requests reached Gemini', cappedMade, 2);
    check('...the counter says 2 of a cap of 2', [(await status(capped)).spend.geminiCallsToday, (await status(capped)).spend.geminiDailyCap], [2, 2]);
    check('...the measured part is kept and the missing analysis says why, in a sentence', [cappedReport?.degraded !== true, cappedReport?.narrativeAvailable, /at most 2 .* calls a day \(UTC\)/.test(cappedReport?.narrativeNote || '')], [true, false, true]);
    const hitsAfter = fake.hits();
    await runAudit(capped);
    check('once the cap is reached no further request is made at all', fake.hits() - hitsAfter, 0);
  } finally {
    for (const p of apps) p.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nSpend guard end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
