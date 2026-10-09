/**
 * Contract checks for the durable store. The same suite runs against the
 * in-memory and SQLite implementations, so they cannot drift apart, and a
 * separate check closes and reopens a real SQLite file to prove state survives
 * a restart. Run: npx tsx test/store.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryStore, SqliteStore, openStore, type Store, type StoredJob } from '../src/store';

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
  check(t('the same key under another owner is fine'), true, true);

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
  check(t('failAllRunning fails every live job (boot cleanup)'), await s2.failAllRunning('restarted', NOW), 1);
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
  const unwritable = await openStore({ dataDir: path.join(blocker, 'data'), log: () => {} });
  fs.rmSync(blocker, { force: true });
  check('an unusable directory falls back to memory instead of crashing', [unwritable.info().kind, unwritable.info().durable], ['memory', false]);
  check('...and the note names the problem', /Could not open/.test(unwritable.info().note || ''), true);

  // --- schema is versioned, so a later migration has something to build on
  const versioned = new SqliteStore(DatabaseSync, ':memory:');
  const v = (versioned as any).db.prepare('PRAGMA user_version').get().user_version;
  check('the schema version is recorded', v >= 1, true);

  console.log(failures === 0 ? '\nAll store checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Store test harness error:', err);
  process.exit(1);
});
