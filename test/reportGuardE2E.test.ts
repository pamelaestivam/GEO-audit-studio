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
  const spawnApp = (port: number, extraEnv: Record<string, string> = {}): ChildProcess => spawn('node', ['dist/server.cjs'], {
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
  const app = spawnApp(APP_PORT);
  // A second server whose consistency check is forced to fail, to prove the failure path.
  const APP2_PORT = APP_PORT + 301;
  const forcedApp = spawnApp(APP2_PORT, { AUDIT_FORCE_INVARIANT_VIOLATION: '1' });
  const base = `http://127.0.0.1:${APP_PORT}`;
  const forcedBase = `http://127.0.0.1:${APP2_PORT}`;

  async function runAudit(b: string = base): Promise<any> {
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
      if (d.status !== 'running') return Object.assign(d.report ?? {}, { __job: d });
    }
    return null;
  }

  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok && (await fetch(`${forcedBase}/api/health`)).ok) break;
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
    check('the removal is said: four sentences, with the reason and what is still true', report?.summaryNote, '4 sentences from the written summary were removed because they appeared to state a figure we could not verify. Only the figures in the first sentence are measured.');

    check('an impossible model-supplied count (47 questions in a 2-question audit) is replaced, not shown', (report?.omissions || []).map((o: any) => o.affectedQueriesCount <= report.queriesAttempted), [true]);
    check('a model forecast with a figure ("+40% visibility in 30 days") is replaced by the plain default', (report?.remediationPlan || []).map((t: any) => t.expectedGain), ['Improved answer-engine citation rate']);

    // ---- a violated invariant becomes a visible failed audit, not a result
    const forced = await runAudit(forcedBase);
    check('a violated consistency check returns a failed audit, not a result', [forced.degraded, forced.narrativeAvailable], [true, false]);
    check('...whose summary says the figures failed a check and nothing is a measurement', /failed an internal consistency check/.test(forced.executiveSummary || '') && /nothing here is a measurement/.test(forced.executiveSummary || ''), true);
    check('...whose per-question cells do not claim a retrieval failure that did not happen', (forced.queriesTested || []).every((q: any) => Object.values(q.engines).every((c: any) => /Answers were collected from .*consistency check/.test(c.excerpt) && !/No answer was captured/.test(c.excerpt))), true);
    check('...and which was not saved to the person\'s history', forced.__job?.saved, false);
    const history = await (await fetch(`${forcedBase}/api/audits`)).json();
    check('...so the audit list stays empty', (history.audits || []).length, 0);

    mode = 'ok';
    report = await runAudit();
    check('a summary with no figure in it is kept as written', /Narrative ok\./.test(report?.executiveSummary || ''), true);
    check('...and nothing is claimed as removed', report?.summaryNote, undefined);
    check('...and the audit is not rejected by the consistency check', report?.degraded !== true, true);
  } finally {
    app.kill();
    forcedApp.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nReport guard end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
