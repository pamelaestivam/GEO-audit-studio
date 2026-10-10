/**
 * Contract checks for the durable store. The same suite runs against the
 * in-memory and SQLite implementations, so they cannot drift apart, and a
 * separate check closes and reopens a real SQLite file to prove state survives
 * a restart. Run: npx tsx test/store.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { MIGRATIONS, MemoryStore, SqliteStore, StoreBusyError, openStore, type PlannedStep, type Store, type StoredJob } from '../src/store';

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

const NOW = 1_800_000_000_000;
const job = (over: Partial<StoredJob> = {}): StoredJob => ({
  id: `job-${Math.random().toString(36).slice(2)}`,
  owner: 'a@example.com',
  status: 'running',
  startedAt: NOW,
  ...over,
});
const report = (id: string, owner = 'x', createdAt = '2026-10-09T10:00:00.000Z', extra: any = {}) => ({
  id,
  createdAt,
  businessName: `Biz ${id}`,
  domain: 'biz.com',
  industry: '',
  geoVisibilityScore: 50,
  shareOfVoice: 25,
  leaderShare: 0,
  accuracyRate: null,
  queriesTested: [{ id: 'q1' }, { id: 'q2' }],
  ...extra,
});

async function s5Default(make: () => Promise<Store>) {
  const st = await make();
  await st.createJob(job({ id: 'd1', owner: 'solo@example.com' }));
  return (await st.getJob('d1'))?.budgetKey ?? (await st.countJobsSince(0, 'solo@example.com') === 1 ? 'solo@example.com' : 'MISSING');
}

async function suite(label: string, make: () => Promise<Store>) {
  const s = await make();
  const t = (n: string) => `${label}: ${n}`;

  // --- jobs
  const j1 = job({ idemKey: 'k1' });
  await s.createJob(j1);
  check(t('a created job can be read back'), (await s.getJob(j1.id))?.status, 'running');
  check(t('an unknown job is null'), await s.getJob('nope'), null);
  check(t('a job is found by its owner and idempotency key'), (await s.findJobByKey('a@example.com', 'k1'))?.id, j1.id);
  check(t('another owner cannot find it by that key'), await s.findJobByKey('b@example.com', 'k1'), null);

  let dupRejected = false;
  try {
    await s.createJob(job({ idemKey: 'k1' }));
  } catch {
    dupRejected = true;
  }
  check(t('a second job under the same owner+key is refused'), dupRejected, true);
  await s.createJob(job({ owner: 'b@example.com', idemKey: 'k1' }));
  check(t('the same key under another owner is fine, and finds that owner\'s own job'), (await s.findJobByKey('b@example.com', 'k1'))?.owner, 'b@example.com');
  check(t('...which is a different job from the first owner\'s'), (await s.findJobByKey('b@example.com', 'k1'))?.id !== j1.id, true);

  await s.updateJob(j1.id, { progress: { phase: 'querying', done: 1, total: 3 } });
  check(t('progress round-trips as structured data'), (await s.getJob(j1.id))?.progress, { phase: 'querying', done: 1, total: 3 });
  await s.updateJob(j1.id, { status: 'done', result: { report: { ok: true } }, finishedAt: NOW + 5 });
  const done = await s.getJob(j1.id);
  check(t('a finished job carries its result'), [done?.status, done?.result, done?.finishedAt], ['done', { report: { ok: true } }, NOW + 5]);
  check(t('updating with an empty patch is a no-op'), (await s.updateJob(j1.id, {}), (await s.getJob(j1.id))?.status), 'done');

  // --- running counts, stuck jobs
  const s2 = await make();
  await s2.createJob(job({ id: 'r1', startedAt: NOW }));
  await s2.createJob(job({ id: 'r2', startedAt: NOW - 20 * 60_000 }));
  await s2.createJob(job({ id: 'd1', status: 'done', startedAt: NOW }));
  check(t('only recent running jobs hold a concurrency slot'), await s2.countRunning(15 * 60_000, NOW), 1);
  check(t('a stuck job is failed with the stated reason'), await s2.failStuck(15 * 60_000, 'too slow', NOW), 1);
  const stuck = await s2.getJob('r2');
  check(t('...and is then an error with that reason'), [stuck?.status, stuck?.error], ['error', 'too slow']);
  check(t('a fresh running job is left alone by failStuck'), (await s2.getJob('r1'))?.status, 'running');
  check(t('a job failed as stuck does not use up the budget'), (await s2.getJob('r2'))?.billable, false);
  check(t('failAllRunning fails every live job (boot cleanup)'), await s2.failAllRunning('restarted', NOW), 1);
  check(t('...and an orphaned job (a restart or deploy) does not use up the budget either'), (await s2.getJob('r1'))?.billable, false);
  check(t('...so a deploy cannot cost anyone their daily allowance'), await s2.countJobsSince(NOW - 1000), 1);
  check(t('...and never touches finished jobs'), (await s2.getJob('d1'))?.status, 'done');
  check(t('nothing is running afterwards'), await s2.countRunning(60 * 60_000, NOW), 0);

  // --- budgets
  const s3 = await make();
  await s3.createJob(job({ id: 'b1', owner: 'u1', startedAt: NOW - 3 * 3600_000 }));
  await s3.createJob(job({ id: 'b2', owner: 'u1', startedAt: NOW - 1 * 3600_000 }));
  await s3.createJob(job({ id: 'b3', owner: 'u2', startedAt: NOW - 30 * 3600_000 }));
  const since = NOW - 24 * 3600_000;
  check(t('a user is counted over the window'), await s3.countJobsSince(since, 'u1'), 2);
  check(t('jobs outside the window are not counted'), await s3.countJobsSince(since, 'u2'), 0);
  check(t('everyone is counted when no owner is given'), await s3.countJobsSince(since), 2);
  check(t('the oldest in-window job gives the "try again at" time'), await s3.oldestJobSince(since, 'u1'), NOW - 3 * 3600_000);
  check(t('no jobs means no oldest'), await s3.oldestJobSince(since, 'nobody'), null);
  check(t('pruning drops old jobs only'), await s3.pruneJobs(NOW - 24 * 3600_000), 1);

  // Budgets are per access code (budget key), not per claimed email.
  const s6 = await make();
  await s6.createJob(job({ id: 'e1', owner: 'anna|a@example.com', budgetKey: 'anna', startedAt: NOW - 1000 }));
  await s6.createJob(job({ id: 'e2', owner: 'anna|b@example.com', budgetKey: 'anna', startedAt: NOW - 500 }));
  await s6.createJob(job({ id: 'e3', owner: 'ben|a@example.com', budgetKey: 'ben', startedAt: NOW - 400 }));
  check(t('changing the email under one code does not reset the budget'), await s6.countJobsSince(NOW - 5000, 'anna'), 2);
  check(t('another code is counted separately'), await s6.countJobsSince(NOW - 5000, 'ben'), 1);
  check(t('the budget key defaults to the owner when none is given'), (await s5Default(make)), 'solo@example.com');

  // A job that failed without spending anything must not use up the budget.
  const s5 = await make();
  await s5.createJob(job({ id: 'p1', owner: 'u1', startedAt: NOW - 1000 }));
  await s5.createJob(job({ id: 'p2', owner: 'u1', startedAt: NOW - 500 }));
  await s5.updateJob('p1', { status: 'error', error: 'no evidence', billable: false });
  check(t('a non-billable job is not counted against the budget'), await s5.countJobsSince(NOW - 5000, 'u1'), 1);
  check(t('...nor does it set the "try again at" time'), await s5.oldestJobSince(NOW - 5000, 'u1'), NOW - 500);
  check(t('billable defaults to true'), (await s5.getJob('p2'))?.billable, true);
  check(t('...and false round-trips'), (await s5.getJob('p1'))?.billable, false);

  // --- audits
  const s4 = await make();
  await s4.saveAudit('u1', report('a1', 'u1', '2026-10-01T00:00:00.000Z'));
  await s4.saveAudit('u1', report('a2', 'u1', '2026-10-03T00:00:00.000Z', { narrativeAvailable: false }));
  await s4.saveAudit('u2', report('a3', 'u2'));
  const list = await s4.listAudits('u1');
  check(t('a user lists only their own audits, newest first'), list.map((a) => a.id), ['a2', 'a1']);
  check(t('a summary carries the headline numbers and query count'), [list[0].geoVisibilityScore, list[0].queriesCount, list[0].narrativeAvailable], [50, 2, false]);
  check(t('a summary is small: it carries no evidence'), JSON.stringify(list[0]).includes('queriesTested'), false);
  check(t('the full report round-trips'), (await s4.getAudit('u1', 'a1'))?.queriesTested?.length, 2);
  check(t('another user cannot read it'), await s4.getAudit('u2', 'a1'), null);
  check(t('another user cannot delete it'), await s4.deleteAudit('u2', 'a1'), false);
  let hijackRefused = false;
  try {
    await s4.saveAudit('u2', report('a1', 'u2', '2026-10-01T00:00:00.000Z', { businessName: 'HIJACKED' }));
  } catch {
    hijackRefused = true;
  }
  check(t('saving an id that belongs to another owner is refused'), hijackRefused, true);
  check(t('...and the original is untouched'), (await s4.getAudit('u1', 'a1'))?.businessName, 'Biz a1');
  check(t('the owner can delete it'), await s4.deleteAudit('u1', 'a1'), true);
  check(t('...and it is gone'), await s4.getAudit('u1', 'a1'), null);
  await s4.saveAudit('u1', report('a2', 'u1', '2026-10-03T00:00:00.000Z', { geoVisibilityScore: 99 }));
  check(t('saving an id again replaces it rather than duplicating'), [(await s4.listAudits('u1')).length, (await s4.getAudit('u1', 'a2')).geoVisibilityScore], [1, 99]);
  check(t('limit is honoured'), (await s4.listAudits('u1', 0)).length, 0);

  await stepSuite(t, make);
}

const PLAN: PlannedStep[] = [
  { key: 'collect:0:Gemini', kind: 'collect', queryIndex: 0, engine: 'Gemini' },
  { key: 'narrative', kind: 'narrative' },
  { key: 'finalize', kind: 'finalize' },
];
const LEASE = 60_000;

/** Step-wise audits: ordered steps, leases, bounded attempts, first-writer-wins, incidents (docs/PLAN_STEP_E.md S2). */
async function stepSuite(t: (n: string) => string, make: () => Promise<Store>) {
  const s = await make();

  // --- a planned job and its steps are created together, in order
  await s.createPlannedJob(job({ id: 'p1', idemKey: 'pk1' }), PLAN);
  const steps0 = await s.getJobSteps('p1');
  check(t('a planned job has its steps in plan order, all pending, none attempted'), steps0.map((x) => [x.seq, x.key, x.kind, x.state, x.attempt, x.repeatedCalls]), [
    [0, 'collect:0:Gemini', 'collect', 'pending', 0, 0],
    [1, 'narrative', 'narrative', 'pending', 0, 0],
    [2, 'finalize', 'finalize', 'pending', 0, 0],
  ]);
  check(t('...with the query and engine kept on the collect step'), [steps0[0].queryIndex, steps0[0].engine, steps0[1].queryIndex], [0, 'Gemini', undefined]);
  check(t('the job itself is readable and running'), (await s.getJob('p1'))?.status, 'running');
  let dup: any = null;
  try {
    await s.createPlannedJob(job({ id: 'p1b', idemKey: 'pk1' }), PLAN);
  } catch (e: any) {
    dup = e;
  }
  check(t('a second planned job with the same owner and idempotency key is refused'), dup !== null, true);
  check(t('...and leaves neither a job nor steps behind'), [await s.getJob('p1b'), (await s.getJobSteps('p1b')).length, (await s.getJobSteps('p1')).length], [null, 0, 3]);
  check(t('steps of an unknown job are empty, not an error'), await s.getJobSteps('nope'), []);

  // --- claiming: one holder at a time, in order
  const c1 = await s.claimStep('p1', 'A', LEASE, NOW, 3);
  check(t('the first claim gets the first step, attempt 1, with a lease'), [c1.outcome, (c1 as any).step?.seq, (c1 as any).step?.attempt, (c1 as any).step?.leaseHolder, (c1 as any).step?.leaseUntil, (c1 as any).reclaimedMidCall], ['claimed', 0, 1, 'A', NOW + LEASE, false]);
  const c2 = await s.claimStep('p1', 'B', LEASE, NOW + 1, 3);
  check(t('a second holder asking while the lease is live is told it is busy, on the same step'), [c2.outcome, (c2 as any).step?.seq, (c2 as any).step?.leaseHolder], ['busy', 0, 'A']);
  check(t('...and the stored attempt count did not move'), (await s.getJobSteps('p1'))[0].attempt, 1);
  if (c2.outcome === 'busy') c2.step.attempt = 99;
  check(t('a result handed back is a copy: changing it does not change the stored step'), (await s.getJobSteps('p1'))[0].attempt, 1);
  check(t('a claim on an unknown job is none'), (await s.claimStep('nope', 'A', LEASE, NOW, 3)).outcome, 'none');

  // two callers at the very same moment: exactly one wins
  await s.createPlannedJob(job({ id: 'p2' }), PLAN);
  const race = await Promise.all([s.claimStep('p2', 'X', LEASE, NOW, 3), s.claimStep('p2', 'Y', LEASE, NOW, 3)]);
  check(t('two simultaneous claims give exactly one claimed and one busy'), race.map((r) => r.outcome).sort(), ['busy', 'claimed']);

  // --- completing: first writer wins, and the next claim moves on in order
  check(t('only the current holder can mark the call as started (it is allowed after the lease expired but before anyone reclaimed, so the count stays honest)'), [await s.markCallStarted('p1', 0, 'B', 1, NOW + 2), await s.markCallStarted('p1', 0, 'A', 1, NOW + 2)], [false, true]);
  check(t('the start of the call is recorded'), (await s.getJobSteps('p1'))[0].callStartedAt, NOW + 2);
  check(t('a step is completed once, with its result'), await s.completeStep('p1', 0, 1, { state: 'done', result: { answer: 'first' } }, NOW + 3), true);
  check(t('a second completion of the same step is refused and changes nothing'), [await s.completeStep('p1', 0, 1, { state: 'done', result: { answer: 'second' } }, NOW + 4), (await s.getJobSteps('p1'))[0].result], [false, { answer: 'first' }]);
  check(t('a finished step has no lease left'), [(await s.getJobSteps('p1'))[0].leaseHolder, (await s.getJobSteps('p1'))[0].leaseUntil, (await s.getJobSteps('p1'))[0].finishedAt], [undefined, undefined, NOW + 3]);
  check(t('a pending step cannot be completed without being claimed'), await s.completeStep('p1', 1, 1, { state: 'done' }, NOW + 4), false);
  const c3 = await s.claimStep('p1', 'A', LEASE, NOW + 5, 3);
  check(t('the next claim is the next step in order'), [c3.outcome, (c3 as any).step?.key], ['claimed', 'narrative']);
  check(t('a skipped step keeps its reason'), [await s.completeStep('p1', 1, 1, { state: 'skipped', skipReason: 'breaker' }, NOW + 6), (await s.getJobSteps('p1'))[1].skipReason], [true, 'breaker']);

  // --- an expired lease is reclaimed, and a call that had started is counted as possibly repeated
  await s.createPlannedJob(job({ id: 'p3' }), PLAN);
  await s.claimStep('p3', 'A', LEASE, NOW, 3);
  const early = await s.claimStep('p3', 'B', LEASE, NOW + LEASE - 1, 3);
  check(t('a lease is live until the instant it expires'), early.outcome, 'busy');
  const late = await s.claimStep('p3', 'B', LEASE, NOW + LEASE, 3);
  check(t('after expiry another holder takes the step as attempt 2; no call had started so nothing is repeated'), [late.outcome, (late as any).step?.attempt, (late as any).step?.leaseHolder, (late as any).reclaimedMidCall, (late as any).step?.repeatedCalls], ['claimed', 2, 'B', false, 0]);
  await s.markCallStarted('p3', 0, 'B', 2, NOW + LEASE + 2);
  const third = await s.claimStep('p3', 'C', LEASE, NOW + 3 * LEASE, 3);
  check(t('reclaiming a step whose call had started counts one possibly repeated call and clears the start'), [third.outcome, (third as any).step?.attempt, (third as any).reclaimedMidCall, (third as any).step?.repeatedCalls, (third as any).step?.callStartedAt], ['claimed', 3, true, 1, undefined]);
  check(t('the reclaim cleared the call start on the stored row too, not only in the returned claim'), (await s.getJobSteps('p3'))[0].callStartedAt, undefined);
  check(t('the old holder cannot mark a call started any more'), await s.markCallStarted('p3', 0, 'B', 2, NOW + 3 * LEASE + 1), false);
  check(t('a late result from the older attempt is refused (one attempt owns one result); the current attempt\'s is stored'), [await s.completeStep('p3', 0, 2, { state: 'done', result: 'late' }, NOW + 3 * LEASE + 2), await s.completeStep('p3', 0, 3, { state: 'done', result: 'newer' }, NOW + 3 * LEASE + 3), (await s.getJobSteps('p3'))[0].result], [false, true, 'newer']);

  // --- the same holder name reclaiming after expiry is a different attempt: the stale invocation is fenced out
  await s.createPlannedJob(job({ id: 'p3b' }), PLAN);
  await s.claimStep('p3b', 'proc', LEASE, NOW, 3);
  const again = await s.claimStep('p3b', 'proc', LEASE, NOW + LEASE, 3);
  check(t('the same holder reclaiming after expiry gets attempt 2'), [again.outcome, (again as any).step?.attempt], ['claimed', 2]);
  check(t('...and its earlier invocation (attempt 1) can neither mark a call started nor store a result'), [await s.markCallStarted('p3b', 0, 'proc', 1, NOW + LEASE + 1), await s.completeStep('p3b', 0, 1, { state: 'done', result: 'stale' }, NOW + LEASE + 2), (await s.getJobSteps('p3b'))[0].state], [false, false, 'leased']);

  // --- bounded attempts
  await s.createPlannedJob(job({ id: 'p4' }), PLAN);
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const c = await s.claimStep('p4', `h${i}`, LEASE, NOW + i * (LEASE + 1), 3);
    outcomes.push(c.outcome);
    if (c.outcome === 'claimed') await s.markCallStarted('p4', 0, `h${i}`, i + 1, NOW + i * (LEASE + 1) + 1);
  }
  check(t('a step is claimed three times and the fourth claim reports it exhausted'), outcomes, ['claimed', 'claimed', 'claimed', 'exhausted']);
  const st4 = await s.getJobSteps('p4');
  check(t('...the exhausted step is failed with a code, and the later steps stay pending'), [st4[0].state, st4[0].errorCode, st4[0].attempt, st4[1].state], ['failed', 'step_attempts_exceeded', 3, 'pending']);
  check(t('...and an exhausted step looks the same on both stores (no leftover call start, lease or holder)'), [st4[0].callStartedAt, st4[0].leaseHolder, st4[0].leaseUntil, st4[0].repeatedCalls], [undefined, undefined, undefined, 2]);
  check(t('...and every later claim reports it again until the job is closed (a caller that crashed is reminded)'), [(await s.claimStep('p4', 'z', LEASE, NOW + 10 * LEASE, 3)).outcome, (await s.claimStep('p4', 'z', LEASE, NOW + 11 * LEASE, 3)).outcome], ['exhausted', 'exhausted']);
  await s.updateJob('p4', { status: 'error', error: 'x', finishedAt: NOW, failCode: 'step_attempts_exceeded' });
  check(t('...and once the job is closed there is nothing to claim'), (await s.claimStep('p4', 'z', LEASE, NOW + 12 * LEASE, 3)).outcome, 'none');

  // --- a step failed on purpose is reported the same way, as 'failed'
  await s.createPlannedJob(job({ id: 'p4b' }), PLAN);
  const cf = await s.claimStep('p4b', 'A', LEASE, NOW, 3);
  await s.completeStep('p4b', 0, (cf as any).step.attempt, { state: 'failed', errorCode: 'step_exception' }, NOW + 1);
  check(t('a step completed as failed makes later claims report failed (job still running), not none'), [(await s.claimStep('p4b', 'A', LEASE, NOW + 2, 3)).outcome, ((await s.claimStep('p4b', 'A', LEASE, NOW + 2, 3)) as any).step?.errorCode], ['failed', 'step_exception']);

  // --- a bad attempt limit never means unlimited retries
  await s.createPlannedJob(job({ id: 'p4c' }), PLAN);
  const nan: string[] = [];
  for (let i = 0; i < 3; i++) nan.push((await s.claimStep('p4c', 'A', LEASE, NOW + i * (LEASE + 1), NaN)).outcome);
  check(t('a limit that is not a whole number allows one try, then exhausted'), nan, ['claimed', 'exhausted', 'exhausted']);

  // --- a job that is not running has nothing to claim
  await s.createPlannedJob(job({ id: 'p5' }), PLAN);
  await s.updateJob('p5', { status: 'error', error: 'x', finishedAt: NOW });
  check(t('a finished or failed job cannot have steps claimed'), (await s.claimStep('p5', 'A', LEASE, NOW, 3)).outcome, 'none');
  // all steps in a final state
  await s.createPlannedJob(job({ id: 'p6' }), [PLAN[0]]);
  await s.claimStep('p6', 'A', LEASE, NOW, 3);
  await s.completeStep('p6', 0, 1, { state: 'done' }, NOW);
  check(t('when every step has a final state there is nothing to claim'), (await s.claimStep('p6', 'A', LEASE, NOW, 3)).outcome, 'none');

  // --- heartbeat and instance
  const inst = s.instanceId;
  await s.touchJob('p1', NOW + 50, { phase: 'collecting' });
  const touched = await s.getJob('p1');
  check(t('touching a job records the time, the phase and the instance that did it'), [touched?.heartbeatAt, touched?.phase, touched?.instanceId === inst, typeof inst === 'string' && inst.length > 4], [NOW + 50, 'collecting', true, true]);
  await s.touchJob('p1', NOW + 60);
  check(t('touching without a phase keeps the phase'), [(await s.getJob('p1'))?.heartbeatAt, (await s.getJob('p1'))?.phase], [NOW + 60, 'collecting']);
  await s.updateJob('p1', { failCode: 'step_attempts_exceeded' });
  check(t('a failure code is stored beside the sentence'), (await s.getJob('p1'))?.failCode, 'step_attempts_exceeded');
  check(t('a plan stored on the job comes back as it was written'), await (async () => { await s.createPlannedJob(job({ id: 'p7', plan: { queries: 2, engines: ['Gemini'] } }), PLAN); return (await s.getJob('p7'))?.plan; })(), { queries: 2, engines: ['Gemini'] });

  // --- incidents
  await s.recordIncident({ jobId: 'p1', at: NOW + 1, kind: 'lease_expired_midcall', detail: 'one' });
  await s.recordIncident({ jobId: 'p3', at: NOW + 2, kind: 'step_attempts_exceeded', detail: 'two' });
  await s.recordIncident({ at: NOW + 3, kind: 'invariant', detail: 'three' });
  check(t('incidents are listed newest first'), (await s.listIncidents()).map((i) => i.detail), ['three', 'two', 'one']);
  await s.recordIncident({ jobId: 'p3', at: NOW + 4, kind: 'lease_expired_midcall', detail: 'four' });
  check(t('...a job\'s own incidents are newest first too'), (await s.listIncidents({ jobId: 'p3' })).map((i) => i.detail), ['four', 'two']);
  check(t('...can be filtered to one job, and limited'), [(await s.listIncidents({ jobId: 'p1' })).map((i) => i.kind), (await s.listIncidents({ limit: 2 })).length], [['lease_expired_midcall'], 2]);

  // --- the two stores must accept and refuse the same things
  let dupId = false;
  try {
    await s.createPlannedJob(job({ id: 'p7' }), PLAN);
  } catch {
    dupId = true;
  }
  check(t('a planned job whose id already exists is refused'), dupId, true);
  check(t('...and the existing job\'s steps and lease state are untouched'), [(await s.getJobSteps('p7')).length, (await s.getJobSteps('p7'))[0].state], [3, 'pending']);
  let bad = false;
  try {
    await s.createPlannedJob(job({ id: 'bad1' }), [PLAN[0], { key: '', kind: 'collect' } as any]);
  } catch {
    bad = true;
  }
  check(t('a plan with a malformed step is refused as a whole: no job, no steps'), [bad, await s.getJob('bad1'), (await s.getJobSteps('bad1')).length], [true, null, 0]);
  check(t('the instance id is not part of the public info()'), Object.keys(s.info()).includes('instanceId'), false);

  // a stored result is a copy in both directions, and reads back the way the database would
  await s.createPlannedJob(job({ id: 'p8' }), PLAN);
  const cl8 = await s.claimStep('p8', 'A', LEASE, NOW, 3);
  const mine: any = { list: [1], n: NaN };
  await s.completeStep('p8', 0, (cl8 as any).step.attempt, { state: 'done', result: mine }, NOW + 1);
  mine.list.push(2);
  const read: any = (await s.getJobSteps('p8'))[0].result;
  read.list.push(3);
  check(t('changing the object after storing it, or the object read back, does not change the stored result'), (await s.getJobSteps('p8'))[0].result, { list: [1], n: null });

  // incidents are bounded sentences, and a limit that is not a whole number is not an error
  await s.recordIncident({ jobId: 'p8', at: NOW + 9, kind: 'invariant', detail: 'x'.repeat(5000) });
  check(t('an incident detail is cut to 500 characters'), (await s.listIncidents({ jobId: 'p8' }))[0].detail.length, 500);
  const allCount = (await s.listIncidents()).length;
  check(t('a negative, fractional or NaN limit means the default, on both stores'), [(await s.listIncidents({ limit: -1 })).length, (await s.listIncidents({ limit: 2.5 })).length, (await s.listIncidents({ limit: NaN })).length], [allCount, allCount, allCount]);

  // job fields set at creation come back, and a touch without a phase still records the instance
  await s.createPlannedJob(job({ id: 'p9', phase: 'planned', heartbeatAt: NOW, instanceId: 'inst-x', failCode: 'none-yet' }), PLAN);
  const p9 = await s.getJob('p9');
  check(t('phase, heartbeat, instance and failure code given at creation come back'), [p9?.phase, p9?.heartbeatAt, p9?.instanceId, p9?.failCode], ['planned', NOW, 'inst-x', 'none-yet']);
  await s.touchJob('p9', NOW + 5);
  check(t('a touch without a phase still records the time and this instance, and keeps the phase'), [(await s.getJob('p9'))?.heartbeatAt, (await s.getJob('p9'))?.instanceId === s.instanceId, (await s.getJob('p9'))?.phase], [NOW + 5, true, 'planned']);
  await s.updateJob('p9', { phase: 'analysing', failCode: null });
  check(t('a phase can be updated and a failure code cleared'), [(await s.getJob('p9'))?.phase, (await s.getJob('p9'))?.failCode], ['analysing', undefined]);

  // --- pruning removes a pruned job's steps and old incidents
  const before = NOW + 1000;
  await s.createPlannedJob(job({ id: 'old1', startedAt: NOW - 10 * DAY }), PLAN);
  await s.recordIncident({ jobId: 'old1', at: NOW - 10 * DAY, kind: 'invariant', detail: 'old' });
  await s.pruneJobs(NOW - DAY);
  check(t('pruning a job removes its steps and its old incidents too'), [await s.getJob('old1'), (await s.getJobSteps('old1')).length, (await s.listIncidents()).some((i) => i.detail === 'old'), (await s.getJobSteps('p1')).length], [null, 0, false, 3]);
  void before;
}

const DAY = 24 * 3600 * 1000;

let tmpRoot: string | null = null;
function dir0() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-store-mig-'));
  return tmpRoot;
}

async function main() {
  await suite('memory', async () => new MemoryStore());
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  await suite('sqlite', async () => new SqliteStore(DatabaseSync, ':memory:'));

  // --- durability: a real file, closed and reopened
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-store-'));
  try {
    const first = await openStore({ dataDir: dir });
    check('openStore with a directory yields a durable sqlite store', [first.info().kind, first.info().durable], ['sqlite', true]);
    await first.saveAudit('u1', report('keep-me', 'u1'));
    await first.createJob(job({ id: 'inflight', owner: 'u1' }));
    first.close();

    const second = await openStore({ dataDir: dir });
    check('a saved audit survives close and reopen', (await second.getAudit('u1', 'keep-me'))?.id, 'keep-me');
    check('a running job survives too (so boot can fail it honestly)', (await second.getJob('inflight'))?.status, 'running');
    check('boot cleanup marks it failed', await second.failAllRunning('The server restarted.'), 1);
    check('...and the failure is what a poll then reads', (await second.getJob('inflight'))?.error, 'The server restarted.');
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- honest fallbacks
  const noDir = await openStore({});
  check('without DATA_DIR the store says it is not durable', [noDir.info().kind, noDir.info().durable], ['memory', false]);
  check('...and says why', /DATA_DIR/.test(noDir.info().note || ''), true);
  const serverless = await openStore({ dataDir: '/tmp/ignored', serverless: true });
  check('serverless never claims durability, even with a directory', serverless.info().durable, false);
  // A directory that cannot exist because its parent is a regular file.
  const blocker = path.join(os.tmpdir(), `geo-blocker-${process.pid}`);
  fs.writeFileSync(blocker, 'x');
  const logged: string[] = [];
  const unwritable = await openStore({ dataDir: path.join(blocker, 'data'), log: (m) => logged.push(m) });
  fs.rmSync(blocker, { force: true });
  check('an unusable directory falls back to memory instead of crashing', [unwritable.info().kind, unwritable.info().durable], ['memory', false]);
  check('...and the public note says the database could not be opened', /could not be opened/.test(unwritable.info().note || ''), true);
  check('...without leaking the filesystem path or the OS error (it is shown on a public endpoint)', /geo-blocker|ENOTDIR|ENOENT|\//.test(unwritable.info().note || ''), false);
  check('...while the server log does get the detail', logged.some((m) => /geo-blocker/.test(m) && /ENOTDIR|ENOENT/.test(m)), true);

  // --- migration 3 backfills budget keys on a database created before it existed
  {
    const old = path.join(dir0(), 'old.sqlite');
    const raw = new DatabaseSync(old);
    raw.exec(MIGRATIONS[0]);
    raw.exec(MIGRATIONS[1]);
    raw.exec('PRAGMA user_version = 2');
    raw.prepare("INSERT INTO jobs (id, owner, status, started_at) VALUES ('m1','anna|x@example.com','done',1),('m2','plain@example.com','done',2)").run();
    raw.close();
    const upgraded = new SqliteStore(DatabaseSync, old);
    check('an existing database upgrades in place', (upgraded as any).db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    check('...and a labelled owner is backfilled with its label', await upgraded.countJobsSince(0, 'anna'), 1);
    check('...and an unlabelled owner with itself', await upgraded.countJobsSince(0, 'plain@example.com'), 1);
    upgraded.close();
  }

  // --- steps across two connections to one file (two processes would behave the same: BEGIN IMMEDIATE)
  {
    const shared = path.join(dir0(), 'shared.sqlite');
    const a = new SqliteStore(DatabaseSync, shared);
    const b = new SqliteStore(DatabaseSync, shared);
    await a.createPlannedJob(job({ id: 'x1' }), PLAN);
    check('a second connection sees the planned steps', (await b.getJobSteps('x1')).length, 3);
    const first = await a.claimStep('x1', 'A', LEASE, NOW, 3);
    const second = await b.claimStep('x1', 'B', LEASE, NOW + 1, 3);
    check('a claim on one connection makes the other connection busy', [first.outcome, second.outcome, (second as any).step?.leaseHolder], ['claimed', 'busy', 'A']);
    await a.createPlannedJob(job({ id: 'x2' }), PLAN);
    const race = await Promise.all([a.claimStep('x2', 'A', LEASE, NOW, 3), b.claimStep('x2', 'B', LEASE, NOW, 3)]);
    check('two connections claiming at once give exactly one claimed', race.map((r) => r.outcome).sort(), ['busy', 'claimed']);
    check('the two connections have different instance ids', a.instanceId !== b.instanceId, true);
    check('a completion on one connection is the first writer; the other is refused', [await a.completeStep('x1', 0, 1, { state: 'done', result: 1 }, NOW + 2), await b.completeStep('x1', 0, 1, { state: 'done', result: 2 }, NOW + 3), (await b.getJobSteps('x1'))[0].result], [true, false, 1]);
    // closing and reopening keeps steps, attempts and leases
    await a.claimStep('x1', 'A', LEASE, NOW + 4, 3);
    a.close();
    b.close();
    const reopened = new SqliteStore(DatabaseSync, shared);
    const rs = await reopened.getJobSteps('x1');
    check('steps survive close and reopen with their state, attempt and lease', [rs[0].state, rs[1].state, rs[1].attempt, rs[1].leaseHolder, rs[1].leaseUntil], ['done', 'leased', 1, 'A', NOW + 4 + LEASE]);
    check('...and the restarted process can take the step over once the lease has expired', [(await reopened.claimStep('x1', 'C', LEASE, NOW + 4 + LEASE, 3)).outcome, (await reopened.getJobSteps('x1'))[1].attempt], ['claimed', 2]);
    reopened.close();
  }

  // --- real processes: eight of them claim one step on one file at the same moment; exactly one may win
  {
    const file = path.join(dir0(), 'procs.sqlite');
    const seed = new SqliteStore(DatabaseSync, file);
    await seed.createPlannedJob(job({ id: 'race' }), PLAN);
    seed.close();
    const script = path.join(dir0(), 'claim.mts');
    fs.writeFileSync(
      script,
      `import { SqliteStore } from ${JSON.stringify(path.resolve('src/store.ts'))};
       const { DatabaseSync } = await import('node:sqlite');
       const st = new SqliteStore(DatabaseSync, process.argv[2]);
       const go = Number(process.argv[3]);
       while (Date.now() < go) {}
       const r = await st.claimStep('race', 'proc-' + process.pid, 60000, ${NOW}, 3);
       console.log(JSON.stringify({ outcome: r.outcome, attempt: r.step?.attempt }));
       st.close();`
    );
    const go = Date.now() + 2500;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<string>((resolve) => {
          let out = '';
          const child = spawn('node', ['--import', 'tsx', script, file, String(go)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
          child.stdout.on('data', (d) => (out += d));
          child.on('close', () => resolve(out.trim().split('\n').pop() || ''));
        })
      )
    );
    const parsed = results.map((r) => { try { return JSON.parse(r); } catch { return { outcome: 'no-output:' + r }; } });
    check('eight real processes claiming one step at once: exactly one claimed, the rest busy', [parsed.filter((r) => r.outcome === 'claimed').length, parsed.filter((r) => r.outcome === 'busy').length], [1, 7]);
    const after = new SqliteStore(DatabaseSync, file);
    check('...and the step was attempted exactly once', (await after.getJobSteps('race'))[0].attempt, 1);
    after.close();
  }

  // --- a writer lock held by someone else is a typed, recoverable error, not a raw one or a half-written state
  {
    const lockFile = path.join(dir0(), 'busy.sqlite');
    const holder = new SqliteStore(DatabaseSync, lockFile);
    const waiter = new SqliteStore(DatabaseSync, lockFile);
    await holder.createPlannedJob(job({ id: 'bz' }), PLAN);
    (waiter as any).db.exec('PRAGMA busy_timeout = 50');
    (holder as any).db.exec('BEGIN IMMEDIATE');
    let err: any = null;
    try {
      await waiter.claimStep('bz', 'A', LEASE, NOW, 3);
    } catch (e) {
      err = e;
    }
    check('a held writer lock gives a typed store_busy error', [err instanceof StoreBusyError, err?.code, /database is busy/.test(err?.message || '')], [true, 'store_busy', true]);
    (holder as any).db.exec('ROLLBACK');
    check('...and nothing was half written: the next claim works as attempt 1', [(await waiter.claimStep('bz', 'A', LEASE, NOW, 3) as any).outcome, (await waiter.getJobSteps('bz'))[0].attempt], ['claimed', 1]);
    holder.close();
    waiter.close();
  }

  // --- four real processes opening one old database at the same moment: every one starts, the schema is upgraded once
  {
    const file = path.join(dir0(), 'upgrade-race.sqlite');
    const raw = new DatabaseSync(file);
    for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
    raw.exec('PRAGMA user_version = 3');
    raw.close();
    const script = path.join(dir0(), 'open.mts');
    fs.writeFileSync(
      script,
      `import { SqliteStore } from ${JSON.stringify(path.resolve('src/store.ts'))};
       const { DatabaseSync } = await import('node:sqlite');
       while (Date.now() < Number(process.argv[3])) {}
       try { const st = new SqliteStore(DatabaseSync, process.argv[2]); st.close(); console.log('ok'); } catch (e) { console.log('FAILED ' + e.message); }`
    );
    const go = Date.now() + 2500;
    const outs = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<string>((resolve) => {
          let out = '';
          const child = spawn('node', ['--import', 'tsx', script, file, String(go)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
          child.stdout.on('data', (d) => (out += d));
          child.on('close', () => resolve(out.trim()));
        })
      )
    );
    check('four processes opening a version-3 database at once all start', outs, ['ok', 'ok', 'ok', 'ok']);
    const after = new DatabaseSync(file);
    check('...and the schema ends at the current version', after.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    after.close();
  }

  // --- migrations 4 and 5 upgrade a version-3 database in place and keep its jobs
  {
    const old = path.join(dir0(), 'v3.sqlite');
    const raw = new DatabaseSync(old);
    for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]);
    raw.exec('PRAGMA user_version = 3');
    raw.prepare("INSERT INTO jobs (id, owner, status, started_at, budget_key) VALUES ('v3job','a@example.com','done',1,'a@example.com')").run();
    raw.close();
    const up = new SqliteStore(DatabaseSync, old);
    check('a version-3 database upgrades to the current version', (up as any).db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const v3 = await up.getJob('v3job');
    check('...its old job reads back with no plan, phase or heartbeat', [v3?.status, v3?.plan, v3?.phase, v3?.heartbeatAt, v3?.failCode], ['done', undefined, undefined, undefined, undefined]);
    await up.createPlannedJob(job({ id: 'v3new' }), PLAN);
    check('...and can take a planned job straight away', (await up.getJobSteps('v3new')).length, 3);
    up.close();
  }

  // --- schema is versioned, so a later migration has something to build on
  const versioned = new SqliteStore(DatabaseSync, ':memory:');
  const v = (versioned as any).db.prepare('PRAGMA user_version').get().user_version;
  check('the schema version is recorded', v >= 1, true);

  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nAll store checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Store test harness error:', err);
  process.exit(1);
});
