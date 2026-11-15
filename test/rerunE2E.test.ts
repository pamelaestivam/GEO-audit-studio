/**
 * Run an audit again, end to end, on the real built server and a fake Gemini that counts hits (docs/PLAN_2026-11.md P3):
 *   - the request carries only the saved audit's id: anything else in the body is ignored, every input and question comes from the saved audit;
 *   - a re-run costs exactly what the same audit costs (calls counted), and its saved report carries `previousAuditId`; the earlier audit is untouched;
 *   - the comparison of the two saved reports (src/reportCompare.ts) over a fake that changes its answer between the runs;
 *   - a second user cannot re-run the audit or read the new one (the answer is the one for an audit that does not exist);
 *   - the same click retried is one audit (Idempotency-Key); a re-run that fails is not saved and carries no link; the per-minute limiter and the
 *     sign-in rule apply; a deleted earlier audit leaves the link dangling and the later audit intact.
 * Needs a current dist/. Run: npx tsx test/rerunE2E.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { randomPort } from './ports';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_AUTH_ENV, installAuthFetch, loginAs, rawFetch } from './authHelper';
import { compareReports } from '../src/reportCompare';

installAuthFetch();

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(ok ? `pass  ${name}` : `FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

const GEMINI_PORT = randomPort(7500, 90);
const APP_PORT = randomPort(7600, 200);
let mode: FakeMode = 'ok';
const TWO_Q = [
  { id: 'q1', intent: 'direct_recommendation', queryText: 'best poke in Austin', targetPersona: 'Buyer' },
  { id: 'q2', intent: 'direct_recommendation', queryText: 'poke house menu', targetPersona: 'Buyer' },
];

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-e2e-'));
  const children: ChildProcess[] = [];
  async function server(extra: Record<string, string> = {}) {
    const port = APP_PORT + children.length;
    const child = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env, PORT: String(port), NODE_ENV: 'production', GEMINI_API_KEY: 'fake-key', GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MIN_INTERVAL_MS: '0', RATE_LIMIT_PER_MIN: '0', HTTP_PROXY: '', HTTPS_PROXY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '', ANTHROPIC_API_KEY: '',
        DATA_DIR: dataDir, ...TEST_AUTH_ENV, ...extra,
      },
      stdio: 'ignore',
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return base;
  }
  const wait = async (base: string, jobId: string, headers: Record<string, string> = {}) => {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d: any = await (await fetch(`${base}/api/audit/job/${jobId}`, { headers })).json();
      if (d.status !== 'running') return d;
    }
    return null;
  };
  const post = (base: string, p: string, body: any, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  try {
    const base = await server();

    // ---- the first audit
    mode = 'ok';
    let h0 = fake.hits();
    const s1: any = await (await post(base, '/api/audit/run', { businessName: 'Poke House', domain: 'poke.house', competitors: ['Pokeworks'], queries: TWO_Q }, { 'Idempotency-Key': 'first-1' })).json();
    const j1 = await wait(base, s1.jobId);
    const firstCalls = fake.hits() - h0;
    const A = j1.report;
    check('the first audit is measured, saved, and costs 3 calls (2 searches + the analysis)', [j1.saved, A.degraded !== true, firstCalls], [true, true, 3]);
    const A_before = JSON.stringify((await (await fetch(`${base}/api/audits/${A.id}`)).json()).audit);

    // ---- run it again: the body is junk on purpose, only the id counts
    mode = 'changed_answer';
    h0 = fake.hits();
    const rr = await post(base, '/api/audit/rerun', { auditId: A.id, businessName: 'INJECTED', queries: [{ queryText: 'injected question' }], competitors: ['Evil'] }, { 'Idempotency-Key': 'again-1' });
    const s2: any = await rr.json();
    check('the re-run is accepted (202) and names a job', [rr.status, typeof s2.jobId], [202, 'string']);
    const replay = await post(base, '/api/audit/rerun', { auditId: A.id }, { 'Idempotency-Key': 'again-1' });
    const s2b: any = await replay.json();
    check('the same click retried names the same job', s2b.jobId, s2.jobId);
    const j2 = await wait(base, s2.jobId);
    const B = j2.report;
    check('a re-run costs exactly what the same audit costs: 3 calls, the retried click included', fake.hits() - h0, firstCalls);
    check('it was run on the SAVED inputs, not on the body: name, domain, competitors and the same two questions', [B.businessName, B.domain, B.competitors, B.queriesTested.map((q: any) => q.queryText)], ['Poke House', 'poke.house', ['Pokeworks'], ['best poke in Austin', 'poke house menu']]);
    check('its saved report carries previousAuditId, and it is saved', [B.previousAuditId, j2.saved], [A.id, true]);
    check('the earlier audit is untouched', JSON.stringify((await (await fetch(`${base}/api/audits/${A.id}`)).json()).audit), A_before);
    const listed: any = await (await fetch(`${base}/api/audits`)).json();
    check('both audits are in the history', listed.audits.map((a: any) => a.id).sort(), [A.id, B.id].sort());

    // ---- the comparison, over a fake that changed its answer
    const fetchedA = (await (await fetch(`${base}/api/audits/${A.id}`)).json()).audit;
    const fetchedB = (await (await fetch(`${base}/api/audits/${B.id}`)).json()).audit;
    const c: any = compareReports(fetchedA, fetchedB);
    check('the two saved reports are comparable', c.comparable, true);
    check('named before 2 of 2, now 0 of 2, over the 2 answers measured both times', [c.pairsCompared, c.namedBefore, c.namedNow], [2, 2, 0]);
    check('the cited site changed and a new rival was named', [c.sourcesAppeared, c.sourcesGone, c.rivalsNew.includes('Wild Tuna Co')], [['tripadvisor.com'], ['yelp.com'], true]);

    // ---- another person
    const bob = await loginAs(base, 'bob@example.com');
    const bobHeaders = { Authorization: `Bearer ${bob}` };
    h0 = fake.hits();
    const nope = await post(base, '/api/audit/rerun', { auditId: A.id }, { ...bobHeaders, 'Idempotency-Key': 'bob-1' });
    const nopeBody: any = await nope.json();
    const none = await post(base, '/api/audit/rerun', { auditId: 'audit-does-not-exist' }, { ...bobHeaders, 'Idempotency-Key': 'bob-2' });
    const noneBody: any = await none.json();
    check('another user re-running someone else\'s audit gets exactly the answer for an audit that does not exist', [nope.status, nopeBody], [none.status, noneBody]);
    check('...which is a 404 sentence, and no call was made', [nope.status, typeof nopeBody.error, fake.hits() - h0], [404, 'string', 0]);
    check('another user cannot read the new audit either', (await fetch(`${base}/api/audits/${B.id}`, { headers: bobHeaders })).status, 404);

    // ---- sign-in, missing id
    const anon = await rawFetch(`${base}/api/audit/rerun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditId: A.id }) });
    check('without a session the route refuses (401)', anon.status, 401);
    const noId = await post(base, '/api/audit/rerun', {}, { 'Idempotency-Key': 'noid' });
    check('no id is the same 404 sentence', [noId.status, (await noId.json() as any).error], [404, 'That saved audit was not found. It may have been deleted.']);

    // ---- a re-run that fails
    mode = 'unauthorized';
    const s3: any = await (await post(base, '/api/audit/rerun', { auditId: B.id }, { 'Idempotency-Key': 'again-2' })).json();
    const j3 = await wait(base, s3.jobId);
    check('a re-run that fails is a failed audit: not saved, no link to the earlier one', [j3.report.degraded, j3.saved, j3.report.previousAuditId], [true, false, undefined]);
    const listed2: any = await (await fetch(`${base}/api/audits`)).json();
    check('...and the history is unchanged', listed2.audits.length, 2);
    check('...the earlier audit is untouched', JSON.stringify((await (await fetch(`${base}/api/audits/${B.id}`)).json()).audit), JSON.stringify(fetchedB));

    // ---- the earlier audit is deleted
    mode = 'ok';
    check('deleting the earlier audit works', (await fetch(`${base}/api/audits/${A.id}`, { method: 'DELETE' })).status, 200);
    const afterDelete: any = (await (await fetch(`${base}/api/audits/${B.id}`)).json()).audit;
    check('the later audit keeps its link and loses nothing; the earlier one now answers 404 (the page then says so)', [afterDelete.previousAuditId, (await fetch(`${base}/api/audits/${A.id}`)).status], [A.id, 404]);

    // ---- the per-minute limiter applies to the new route
    const limited = await server({ RATE_LIMIT_PER_MIN: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(limited, '/api/audit/rerun', { auditId: 'x' }, { 'Idempotency-Key': `lim-${i}` })).status);
    check('the per-minute limiter counts the re-run route: the 4th and 5th are 429', statuses, [404, 404, 404, 429, 429]);
  } finally {
    for (const c of children) c.kill();
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nRun-again end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
