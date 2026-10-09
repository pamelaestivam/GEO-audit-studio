/**
 * End to end, against the real built server and a fake Gemini: what the report
 * does with the narrative model's inaccuracy claims.
 *
 * Before: every claim was kept, a claim about a query that was never asked (or
 * an engine that was never measured) was silently re-attributed to the first
 * query and engine, and the accuracy rate divided the CLAIM count by the
 * MENTION count - so two claims about one answer, out of two answers that
 * mention the brand, read as 0% accurate instead of 50%.
 *
 * Needs a current dist/. Run: npx tsx test/narrativeAttributionE2E.test.ts
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

const GEMINI_PORT = 6100 + Math.floor(Math.random() * 100);
const APP_PORT = 6300 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'narrative_findings';

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
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Two queries; the fake answer names Poke House in both (so two mentioning answers).
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
    let final: any = null;
    for (let i = 0; i < 240 && !final; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d = await (await fetch(`${base}/api/audit/job/${jobId}`)).json();
      if (d.status !== 'running') final = d;
    }
    const report = final?.report;
    check('the audit completes with a narrative', [report?.degraded !== true, report?.narrativeAvailable], [true, true]);
    check('both answers name the brand', report?.observationsMentioned, 2);
    check(
      'only the two claims about a real captured answer are kept',
      (report?.inaccuracies || []).map((i: any) => [i.queryId, i.engine, i.queryText]),
      [['q1', 'Gemini', 'best poke in Austin'], ['q1', 'Gemini', 'best poke in Austin']]
    );
    check('the claim about a query never asked and the claim about an unmeasured engine are counted as discarded, not re-attributed', report?.inaccuraciesDiscarded, 2);
    const asked = fake.narrativeRequests().find((r) => JSON.stringify(r).includes('senior Generative Engine'));
    const promptText = JSON.stringify(asked?.contents ?? '');
    check('the narrative prompt numbers every answer, so the model can cite one: [Q1][Gemini] and [Q2][Gemini]', [promptText.includes('[Q1][Gemini]'), promptText.includes('[Q2][Gemini]')], [true, true]);
    const claimSchema = (asked?.generationConfig ?? asked?.config)?.responseSchema?.properties?.inaccuracies?.items;
    check('the response schema requires engine and queryNumber, and queryNumber is an integer', [claimSchema?.required?.includes('engine'), claimSchema?.required?.includes('queryNumber'), claimSchema?.properties?.queryNumber?.type], [true, true, 'INTEGER']);
    check('accuracy counts answers: one of two mentioning answers was flagged, so 50%, not 0%', report?.accuracyRate, 50);
  } finally {
    app.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nNarrative attribution checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
