/**
 * A golden-report test for the audit pipeline, at the boundary: the real built server, a fake Gemini,
 * and the report that comes back compared with a report captured from the server BEFORE the pipeline
 * was split into pure steps (docs/PLAN_STEP_E.md, slice S1).
 *
 * Why it exists: splitting a 400-line function must not change a single word or figure a person reads.
 * A unit test of the new functions would only prove they agree with themselves. This one fails if any
 * string, number, key or the order of rows moves.
 *
 * Compared after removing the values that differ on every run (the audit id and the timestamps) and
 * sorting object keys, so the order of KEYS is not checked; the order of rows in every list is. To accept a deliberate change to the report, regenerate with UPDATE_GOLDEN=1 and read
 * the diff in review: the diff IS the change a person will see.
 *
 * What it does NOT guard (mutations that still pass, checked 2026-10-10): the tie order and the
 * zero-mention filter of `untrackedRivals` (all fixture vendors are mentioned once), `dedupeMatchers`
 * (the typed competitor already absorbs its variants), the cap on the number of questions (`maxQueries`), which evidence list feeds `sourcesForBrand`, and
 * whether discovered vendor names are masked from the summary guard. Only Gemini answers in these
 * scenarios, so multi-engine success paths are not exercised. Add a scenario before touching those.
 *
 * Needs a current dist/. Run: npx tsx test/auditGoldenE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch } from './authHelper';

installAuthFetch();

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const GOLDEN_DIR = path.join(process.cwd(), 'test', 'golden');
let failures = 0;
function pass(name: string) {
  console.log(`pass  ${name}`);
}
function fail(name: string, detail: string) {
  failures++;
  console.log(`FAIL  ${name}\n        ${detail}`);
}

/** Remove what differs on every run, and write keys in a fixed order so the file is stable. */
function normalise(report: any): any {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.id;
  delete copy.createdAt;
  delete copy.answersCapturedFrom;
  delete copy.answersCapturedTo;
  for (const q of copy.queriesTested || []) for (const ev of q.evidence || []) delete ev.capturedAt;
  return sortKeys(copy);
}
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const GEMINI_PORT = 8300 + Math.floor(Math.random() * 100);
const APP_PORT = 8400 + Math.floor(Math.random() * 300);
let mode: FakeMode = 'ok';

const INPUT = {
  businessName: 'Poke House',
  domain: 'https://www.Poke.House/menu',
  industry: 'Restaurants',
  coreOfferings: 'poke bowls',
  targetAudience: 'office workers',
  competitors: ['Pokeworks', 'Sweetgreen'],
  queries: [
    { id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' },
    { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' },
  ],
};

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const spawnApp = (port: number, extraEnv: Record<string, string> = {}): ChildProcess =>
    spawn('node', ['dist/server.cjs'], {
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
  const forcedApp = spawnApp(APP_PORT + 301, { AUDIT_FORCE_INVARIANT_VIOLATION: '1' });
  const base = `http://127.0.0.1:${APP_PORT}`;
  const forcedBase = `http://127.0.0.1:${APP_PORT + 301}`;

  async function runAudit(b: string, body: any): Promise<any> {
    const start = await fetch(`${b}/api/audit/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { jobId } = await start.json();
    for (let i = 0; i < 480; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d = await (await fetch(`${b}/api/audit/job/${jobId}`)).json();
      if (d.status !== 'running') return d.report ?? null;
    }
    return null;
  }

  const scenarios: { name: string; mode: FakeMode; forced?: boolean; body?: any }[] = [
    { name: 'ok', mode: 'ok' },
    { name: 'findings', mode: 'narrative_findings' },
    { name: 'unattributable', mode: 'narrative_unattributable' },
    { name: 'invented-numbers', mode: 'narrative_invented_numbers' },
    { name: 'remediation', mode: 'narrative_remediation' },
    { name: 'narrative-fails', mode: 'narrative_fails' },
    { name: 'all-engines-fail', mode: 'unauthorized' },
    { name: 'many-vendors', mode: 'many_vendors' },
    { name: 'partial-failure', mode: 'partial_failure' },
    { name: 'odd-narrative-values', mode: 'narrative_odd_values' },
    { name: 'invariant-violation', mode: 'ok', forced: true },
    { name: 'blank-optional-fields', mode: 'ok', body: { businessName: 'Poke House', queries: INPUT.queries } },
  ];

  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok && (await fetch(`${forcedBase}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });

    for (const s of scenarios) {
      mode = s.mode;
      const report = await runAudit(s.forced ? forcedBase : base, s.body ?? INPUT);
      const label = `golden report: ${s.name}`;
      if (!report) {
        fail(label, 'the audit did not finish');
        continue;
      }
      const actual = JSON.stringify(normalise(report), null, 2) + '\n';
      const file = path.join(GOLDEN_DIR, `audit-${s.name}.json`);
      if (UPDATE) {
        fs.writeFileSync(file, actual);
        pass(`${label} (written)`);
        continue;
      }
      if (!fs.existsSync(file)) {
        fail(label, `no golden file ${file}; run with UPDATE_GOLDEN=1 on a known-good build`);
        continue;
      }
      const expected = fs.readFileSync(file, 'utf8');
      if (actual === expected) {
        pass(label);
      } else {
        const a = actual.split('\n');
        const e = expected.split('\n');
        const at = a.findIndex((line, idx) => line !== e[idx]);
        fail(label, `first difference at line ${at + 1}:\n          expected: ${e[at]}\n          actual:   ${a[at]}`);
      }
    }
  } finally {
    app.kill();
    forcedApp.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nGolden report checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
