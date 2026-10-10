/**
 * End to end, against the real built server and a fake Gemini: a figure the narrative model
 * invents never reaches the written summary, and the removal is said out loud.
 *
 * Before: the model's executiveSummary was shown verbatim, so "traffic will grow 47%" or
 * "double within three months" appeared under a heading that sits above measured figures.
 *
 * Needs a current dist/. Run: npx tsx test/reportGuardE2E.test.ts
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

const GEMINI_PORT = 7700 + Math.floor(Math.random() * 100);
const APP_PORT = 7800 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'narrative_invented_numbers';

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const app: ChildProcess = spawn('node', ['dist/server.cjs'], {
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
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${APP_PORT}`;

  async function runAudit(): Promise<any> {
    const start = await fetch(`${base}/api/audit/run`, {
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
      const d = await (await fetch(`${base}/api/audit/job/${jobId}`)).json();
      if (d.status !== 'running') return d.report;
    }
    return null;
  }

  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    let report = await runAudit();
    check('the audit completes', [report?.degraded !== true, report?.narrativeAvailable], [true, true]);
    const summary: string = report?.executiveSummary || '';
    check('the measured figures are stated by the server, in one deterministic sentence', /Poke House was named in 2 of 2 answers captured across Gemini \(100% visibility\)/.test(summary), true);
    check('a model sentence that repeats a measured figure is removed too (the server states the figures itself)', /named in 2 of 2 answers\./.test(summary.replace(/^.*?\(100% visibility\)[^.]*\.\s*/, '')), false);
    check('an invented digit figure (47%) never reaches the summary', /47/.test(summary), false);
    check('a size-of-change word with no digit ("double") never reaches the summary', /double/i.test(summary), false);
    check('an invented spelled-out figure ("three months") never reaches the summary', /three months/i.test(summary), false);
    check('the plain sentence is kept', /Pokeworks is the main rival/.test(summary), true);
    check('the removal is said: four sentences, with the reason and what is still true', report?.summaryNote, '4 sentences from the written summary were removed because they contained a figure we could not verify. Only the figures in the first sentence are measured.');

    check('an impossible model-supplied count (47 questions in a 2-question audit) is replaced, not shown', (report?.omissions || []).map((o: any) => o.affectedQueriesCount <= report.queriesAttempted), [true]);
    check('a model forecast with a figure ("+40% visibility in 30 days") is replaced by the plain default', (report?.remediationPlan || []).map((t: any) => t.expectedGain), ['Improved answer-engine citation rate']);

    mode = 'ok';
    report = await runAudit();
    check('a summary with no figure in it is kept as written', /Narrative ok\./.test(report?.executiveSummary || ''), true);
    check('...and nothing is claimed as removed', report?.summaryNote, undefined);
    check('...and the audit is not rejected by the consistency check', report?.degraded !== true, true);
  } finally {
    app.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nReport guard end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
