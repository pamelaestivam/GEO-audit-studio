/**
 * Contract tests: boot the real built server and assert the guarantees the
 * product makes to a user.
 *
 * Every check here corresponds to a defect that actually shipped. Unit tests
 * did not catch them because none of them were logic errors — they were
 * promises the system broke at its edges: inventing business facts, overwriting
 * user input, and showing raw provider JSON as if it were a finding.
 *
 * Run with: npx tsx test/contract.test.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import { mergeDetectedDetails, containsFabricatedPlaceholder } from '../src/detection';
import { describeProviderError, parseRetryDelaySeconds, summariseFailures } from '../src/errors';

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

// ============================================================ user input wins
// Regression: a user typed "Gym" as the industry and the audit reported
// "Software & Technology Services", because failed detection returned canned
// text and the client let it overwrite the field.
{
  const user = {
    businessName: 'City Sports',
    domain: '',
    industry: 'Gym',
    coreOfferings: '',
    competitors: [] as string[],
  };
  const detected = {
    businessName: 'City Sports Ltd',
    domain: 'citysports.com',
    industry: 'Software & Technology Services',
    coreOfferings: 'Digital cloud services, automation & SaaS platform',
    competitors: ['Industry Competitor A'],
  };
  const merged = mergeDetectedDetails(user, detected);

  check('a typed industry is never overwritten by detection', merged.industry, 'Gym');
  check('a typed business name is never overwritten', merged.businessName, 'City Sports');
  check('a blank domain is filled from detection', merged.domain, 'citysports.com');
  check('a blank offerings field is filled from detection', merged.coreOfferings, detected.coreOfferings);
  check('blank competitors are filled from detection', merged.competitors, ['Industry Competitor A']);
}

{
  const user = {
    businessName: 'City Sports',
    domain: 'citysports.com',
    industry: 'Gym',
    coreOfferings: 'Gym memberships, personal training',
    competitors: ['PureGym'],
  };
  const merged = mergeDetectedDetails(user, null);
  check('nothing is invented when detection returns nothing', merged, {
    businessName: 'City Sports',
    domain: 'citysports.com',
    industry: 'Gym',
    coreOfferings: 'Gym memberships, personal training',
    competitors: ['PureGym'],
  });
}

{
  const merged = mergeDetectedDetails(
    { businessName: 'City Sports', domain: '', industry: '', coreOfferings: '', competitors: [] },
    { businessName: 'City Sports', domain: 'citysports.com' }
  );
  check('fields detection did not return stay blank rather than guessed', merged.industry, '');
  check('offerings stay blank rather than guessed', merged.coreOfferings, '');
  check('competitors stay empty rather than guessed', merged.competitors, []);
}

// ============================================================ error readability
// Regression: the UI rendered a raw Gemini 429 JSON blob at the top of a report.
{
  const quota429 =
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"36s"}]}}';
  const readable = describeProviderError(quota429, 'Gemini');

  check('a 429 is classified as a quota problem', readable.kind, 'quota');
  assert('the quota message contains no raw JSON', !readable.message.includes('{'), readable.message);
  assert('the quota message contains no status codes', !readable.message.includes('RESOURCE_EXHAUSTED'), readable.message);
  assert('the quota message tells the user what to do', /billing|wait/i.test(readable.message), readable.message);
  check('the provider retry delay is honoured', parseRetryDelaySeconds(quota429), 36);

  const auth = describeProviderError('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}', 'Gemini');
  check('an invalid key is classified as auth', auth.kind, 'auth');
  assert('the auth message contains no raw JSON', !auth.message.includes('{'), auth.message);

  const worst = summariseFailures([quota429, 'API key not valid'], 'The answer engine');
  check('the most actionable cause wins when several fail', worst.kind, 'auth');
}

// ============================================================ live server contract
const PORT = 3200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Audits now run as background jobs, so the client starts one and polls.
 * Holding a single request open for minutes is what produced "Load failed"
 * on mobile.
 */
async function runAudit(body: unknown, timeoutMs = 120000) {
  const startRes = await post('/api/audit/run', body);
  const start = await startRes.json();
  if (!start.jobId) return { startRes, start, final: null as any };

  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(`${BASE}/api/audit/job/${start.jobId}`);
    const data = await res.json();
    if (data.status === 'running') continue;
    return { startRes, start, final: data };
  }
  return { startRes, start, final: null as any };
}

async function waitForServer(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  let server: ChildProcess | null = null;

  try {
    // An invalid key exercises the path that shipped broken: the provider
    // rejects every call, and the product must degrade honestly.
    server = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'production',
        GEMINI_API_KEY: 'invalid-key-for-contract-test',
        GEMINI_MAX_RETRIES: '0',
        GEMINI_MIN_INTERVAL_MS: '0',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      },
      stdio: 'ignore',
    });

    const up = await waitForServer();
    assert('the built server starts and answers /api/health', up);
    if (!up) return;

    // ---- brand lookup must not invent business facts
    const parseRes = await post('/api/audit/parse-url', { input: 'City Sports' });
    const parseBody = await parseRes.json();
    const parseFabrication = containsFabricatedPlaceholder(parseBody);
    assert(
      'brand lookup invents no industry, offerings or competitors when it fails',
      parseFabrication === null,
      `found placeholder: ${parseFabrication}`
    );
    check('brand lookup reports that detection did not succeed', parseBody.detected, false);
    assert(
      'brand lookup returns no industry it could not determine',
      !parseBody.details?.industry,
      `industry was: ${parseBody.details?.industry}`
    );
    assert(
      'the lookup failure reason is human readable',
      typeof parseBody.reason === 'string' && !parseBody.reason.includes('{'),
      parseBody.reason
    );

    // ---- a failed audit must announce failure, not report zeros as findings
    const runOutcome = await runAudit({
      businessName: 'City Sports',
      domain: 'https://www.citysports.com/',
      industry: 'Gym',
      competitors: ['PureGym'],
      queries: [
        { id: 'q1', intent: 'direct_recommendation', queryText: 'best gym near me', targetPersona: 'Member' },
      ],
    });
    check('starting an audit returns a job id', typeof runOutcome.start.jobId, 'string');
    check('starting an audit answers immediately with 202', runOutcome.startRes.status, 202);
    assert('the audit job completes', runOutcome.final !== null);
    const report = runOutcome.final.report;

    check('a failed audit is flagged degraded', report.degraded, true);
    assert(
      'the degraded reason contains no raw provider JSON',
      typeof report.degradedReason === 'string' && !report.degradedReason.includes('{"'),
      report.degradedReason
    );
    assert(
      'the degraded reason contains no status codes',
      !String(report.degradedReason).includes('RESOURCE_EXHAUSTED'),
      report.degradedReason
    );
    assert(
      'the executive summary of a failed audit says it failed',
      /could not complete|failed/i.test(report.executiveSummary),
      report.executiveSummary
    );
    assert(
      'the audit preserves the industry the user typed',
      report.industry === 'Gym',
      `industry was: ${report.industry}`
    );
    assert(
      'a failed audit invents no competitors',
      containsFabricatedPlaceholder(report.competitorBenchmarks) === null,
      JSON.stringify(report.competitorBenchmarks)
    );

    // ---- nothing is presented as measured that we do not measure
    // Regression: every query carried an invented "8,500/mo" search volume, and
    // an audit with no competitors listed a fictional "Competitor A".
    const fabricatedVolume = /\d[\d,]*\s*\/\s*mo/i;
    assert(
      'no invented search volume is returned',
      !fabricatedVolume.test(JSON.stringify(report.queriesTested)),
      JSON.stringify(report.queriesTested).slice(0, 200)
    );

    const noCompetitorOutcome = await runAudit({
      businessName: 'City Sports',
      domain: 'citysports.com',
      industry: 'Gym',
      competitors: [],
      queries: [
        { id: 'q1', intent: 'direct_recommendation', queryText: 'best gym near me', targetPersona: 'Member' },
      ],
    });
    const noCompetitorReport = noCompetitorOutcome.final.report;
    assert(
      'an audit with no competitors invents none',
      containsFabricatedPlaceholder(noCompetitorReport.competitorBenchmarks) === null,
      JSON.stringify(noCompetitorReport.competitorBenchmarks)
    );
    assert(
      'a degraded audit reports no fabricated score history',
      !noCompetitorReport.historicalScores || noCompetitorReport.historicalScores.length === 0,
      JSON.stringify(noCompetitorReport.historicalScores)
    );

    // ---- input the product must survive
    assert(
      'a pasted URL is stored as a bare host, so links are not doubled',
      report.domain === 'citysports.com',
      `domain was: ${report.domain}`
    );

    const missingName = await post('/api/audit/run', { domain: 'example.com' });
    check('an audit with no business name is rejected', missingName.status, 400);
    const missingBody = await missingName.json();
    assert(
      'the missing-name error is a sentence',
      typeof missingBody.error === 'string' && !missingBody.error.includes('{'),
      missingBody.error
    );

    const unknownJob = await fetch(`${BASE}/api/audit/job/job-does-not-exist`);
    check('an unknown job id returns 404', unknownJob.status, 404);
    const unknownBody = await unknownJob.json();
    assert(
      'an expired job explains what to do',
      /run it again|no longer available/i.test(unknownBody.error || ''),
      unknownBody.error
    );

    // Brand names with punctuation, and no competitors supplied at all.
    const awkward = await runAudit({
      businessName: "Ben & Jerry's",
      domain: 'benjerry.com',
      queries: [
        { id: 'q1', intent: 'direct_recommendation', queryText: 'best ice cream', targetPersona: 'Buyer' },
      ],
    });
    assert('a brand name with punctuation completes an audit', awkward.final !== null);
    assert(
      'a punctuated brand name survives into the report',
      awkward.final?.report?.businessName === "Ben & Jerry's",
      awkward.final?.report?.businessName
    );

    // No industry, no competitors, no queries: the minimum a user can submit.
    const minimal = await runAudit({ businessName: 'Poke House', domain: 'https://www.poke.house/' });
    assert('the most minimal submission still completes', minimal.final !== null);
    assert(
      'a minimal submission still normalises the domain',
      minimal.final?.report?.domain === 'poke.house',
      minimal.final?.report?.domain
    );
    assert(
      'a minimal submission invents no industry',
      !/Software & Technology/i.test(JSON.stringify(minimal.final?.report ?? {})),
      'fabricated industry leaked'
    );

    // ---- input the product must refuse or tame
    const blankName = await post('/api/audit/run', { businessName: '   ' });
    check('a whitespace-only business name is rejected', blankName.status, 400);

    const hugeName = await post('/api/audit/run', { businessName: 'A'.repeat(500) });
    check('an absurdly long business name is rejected', hugeName.status, 400);
    const hugeBody = await hugeName.json();
    assert(
      'the too-long error says what to do',
      /shorten/i.test(hugeBody.error || ''),
      hugeBody.error
    );

    const raggedInput = await runAudit({
      businessName: 'Acme',
      competitors: 'Foo, Bar',
      queries: [{ nope: 1 }, null, 'not-an-object'],
    });
    assert('competitors given as a string are accepted', raggedInput.final !== null);
    assert(
      'malformed query objects are discarded rather than crashing',
      Array.isArray(raggedInput.final?.report?.queriesTested),
      JSON.stringify(raggedInput.final?.report?.queriesTested)
    );
    assert(
      'every surviving query has real text',
      (raggedInput.final?.report?.queriesTested || []).every((q: any) => typeof q.queryText === 'string' && q.queryText.length > 0),
      'a query without text survived'
    );

    // ---- the manual-query endpoint must fail loudly rather than fabricate
    const evalRes = await post('/api/audit/evaluate-query', {
      businessName: 'City Sports',
      queryText: 'best gym in town',
    });
    const evalBody = await evalRes.json();
    assert('a manual query that cannot be measured returns an error status', evalRes.status >= 400, String(evalRes.status));
    assert(
      'the manual-query error is human readable',
      typeof evalBody.error === 'string' && !evalBody.error.includes('{"'),
      evalBody.error
    );
  } finally {
    server?.kill();
  }

  console.log(failures === 0 ? '\nAll contract checks passed.' : `\n${failures} contract check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Contract test harness error:', err);
  process.exit(1);
});
