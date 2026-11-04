/**
 * PostgreSQL store (the durable store for hosts with no disk, e.g. Vercel + Supabase).
 *
 * It implements the same `Store` contract as `MemoryStore` and `SqliteStore` and runs the same contract suite
 * (`test/store.test.ts`, against a real server when `TEST_DATABASE_URL` is set). Differences that matter:
 *
 *  - Several processes share one database (every serverless instance is its own process), so the two places the
 *    SQLite store leans on "one process owns the file" are done with the database's own locks instead: schema
 *    migrations run under an advisory lock, and `claimStep` locks the job's row (`FOR UPDATE`) while it decides.
 *  - Timestamps are BIGINT milliseconds, as in SQLite; the pool turns them into numbers (see `createPgPool`).
 *  - JSON is kept as TEXT, as in SQLite, so a row means the same thing in both stores.
 *  - Only plain queries and transactions are used (no named prepared statements, no session state), so the
 *    connection can go through a transaction-mode pooler such as Supabase's.
 */
import type { Pool, PoolClient, PoolConfig } from 'pg';
import {
  READINESS_PROBE_OWNER,
  RESTARTED_FAIL_CODE,
  STUCK_FAIL_CODE,
  assertPlannedSteps,
  clampLimit,
  cutIncident,
  decideClaim,
  newInstanceId,
  rowToJob,
  rowToStep,
  summariseAudit,
  type AuditSummary,
  type ClaimResult,
  type Incident,
  type JobStatus,
  type JobStep,
  type PlannedStep,
  type Store,
  type StoreInfo,
  type StepCompletion,
  type StoredJob,
} from './store.js';

/** Each entry upgrades the schema by one version; never edit an applied one. The columns mirror the SQLite schema. */
export const PG_MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    idem_key TEXT,
    status TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    progress TEXT,
    result TEXT,
    error TEXT,
    billable INTEGER NOT NULL DEFAULT 1,
    budget_key TEXT,
    plan TEXT,
    phase TEXT,
    heartbeat_at BIGINT,
    instance_id TEXT,
    fail_code TEXT
  );
  CREATE INDEX jobs_started ON jobs(started_at);
  CREATE INDEX jobs_owner_started ON jobs(owner, started_at);
  CREATE UNIQUE INDEX jobs_owner_idem ON jobs(owner, idem_key) WHERE idem_key IS NOT NULL;
  CREATE INDEX jobs_budget_started ON jobs(budget_key, started_at);
  CREATE TABLE audits (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    summary TEXT NOT NULL,
    report TEXT NOT NULL
  );
  CREATE INDEX audits_owner_created ON audits(owner, created_at DESC);
  CREATE TABLE job_steps (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    query_index INTEGER,
    engine TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_until BIGINT,
    lease_holder TEXT,
    call_started_at BIGINT,
    finished_at BIGINT,
    result TEXT,
    skip_reason TEXT,
    error_code TEXT,
    repeated_calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, seq)
  );
  CREATE TABLE incidents (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT,
    at BIGINT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX incidents_at ON incidents(at);
  CREATE INDEX incidents_job ON incidents(job_id);
  -- Who drives a job, read from its plan text. A plan holds what a person typed, and JSONB refuses some text that is
  -- valid JSON (a NUL, a lone surrogate): one such plan must not make every later count fail, so an unreadable plan
  -- answers NULL (which counts as a job that holds its slot, the safe side).
  CREATE FUNCTION geo_plan_driver(t TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $fn$
  BEGIN
    RETURN (t::jsonb) ->> 'driver';
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  $fn$;
  `,
];

/** Any constant: every process that migrates takes the same advisory lock, so they run one after another. */
const MIGRATION_LOCK_KEY = 7_242_001;

/** Something that runs a query: a pool or one connection of it. */
interface Queryable {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Turn a DATABASE_URL into a pool configuration without ever putting the address (it carries the password) in
 * an error message. The `sslmode` query parameter is read here and not left to the driver, whose reading of it
 * has changed between versions: `verify-full` and `verify-ca` verify the server's certificate; `disable` and a
 * local host use no TLS; anything else (and the default for a remote host) encrypts without verifying the
 * certificate, because the pooler's certificate chain is not in Node's trust store (TECH_DEBT records this).
 */
export function pgConfigFromUrl(raw: string): PoolConfig {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('DATABASE_URL is not a valid address (user, password, host, port and database name in the usual postgresql:// form)');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must start with postgresql://');
  }
  const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  u.searchParams.delete('sslmode');
  let ssl: PoolConfig['ssl'];
  if (mode === 'disable' || (mode === '' && LOCAL_HOSTS.has(u.hostname))) ssl = false;
  else if (mode === 'verify-full' || mode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else ssl = { rejectUnauthorized: false };
  return { connectionString: u.toString(), ssl };
}

/** Remove the address and anything that looks like a credential from text that is going to a log. */
export function scrubDbText(text: string, raw?: string): string {
  let out = text;
  if (raw) out = out.split(raw).join('[database address]');
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database address]');
}

/**
 * The pool the server uses. Small on purpose (a serverless instance serves one request at a time and a pooler
 * has its own limit), with time limits so a database that stops answering becomes an error instead of a hang.
 */
export async function createPgPool(connectionString: string, overrides: Partial<PoolConfig> = {}, log: (m: string) => void = (m) => console.warn(m)): Promise<Pool> {
  const mod: any = await import('pg');
  const pg = mod.default ?? mod;
  const config: PoolConfig = {
    ...pgConfigFromUrl(connectionString),
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Client-side: a startup parameter such as statement_timeout can be refused by a transaction pooler.
    query_timeout: 15_000,
    allowExitOnIdle: true,
    // BIGINT arrives as text by default; every timestamp here is a millisecond count well inside 2^53.
    types: { getTypeParser: (oid: number, format?: any) => (oid === 20 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format)) } as any,
    ...overrides,
  };
  const pool: Pool = new pg.Pool(config);
  // An idle connection that the server drops raises 'error' on the pool; unhandled, that would end the process.
  pool.on('error', (err: Error) => log(`[store] a database connection failed while idle: ${scrubDbText(String(err?.message || err), connectionString)}`));
  return pool;
}

/** A fractional number (an operator's AUDIT_LEASE_MS=1500.5, say) is not a BIGINT: round it instead of failing the query. */
function wholeNumber(v: any): any {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v) : v;
}

export class PostgresStore implements Store {
  readonly instanceId = newInstanceId();
  /** Every query goes through here, so parameters are normalised in one place. */
  private readonly db: Queryable;

  private constructor(private readonly pool: Pool) {
    this.db = { query: (text, values) => pool.query(text, values?.map(wholeNumber)) as Promise<{ rows: any[]; rowCount: number | null }> };
  }

  /** Connect, bring the schema up to date (safe when several processes start at once), and return the store. */
  static async open(pool: Pool): Promise<PostgresStore> {
    // Timestamps are BIGINT and are read as numbers; a pool that was not made by createPgPool would hand back text,
    // which would corrupt every comparison later. Say so now rather than then.
    const probe = await pool.query('SELECT 1::bigint AS n');
    if (typeof probe.rows[0]?.n !== 'number') throw new Error('the connection pool does not return BIGINT values as numbers; create it with createPgPool');
    const store = new PostgresStore(pool);
    await store.migrate();
    return store;
  }

  private async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c: PoolClient = await this.pool.connect();
    // pg-pool takes its own 'error' listener off a client while it is checked out. Without one here, a connection that
    // dies mid-transaction (a pooler restart, an idle cut, a network blip) raises an unhandled 'error' event and ends
    // the whole process. It is an error for this call only; the broken connection is thrown away, not reused.
    let destroy = false;
    const onError = () => {
      destroy = true;
    };
    c.on('error', onError);
    const q: Queryable = { query: (text, values) => c.query(text, values?.map(wholeNumber)) as Promise<{ rows: any[]; rowCount: number | null }> };
    try {
      await q.query('BEGIN');
      const out = await fn(q);
      await q.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await q.query('ROLLBACK');
      } catch {
        destroy = true; // the connection cannot even roll back; the original error is the one to report
      }
      throw err;
    } finally {
      c.removeListener('error', onError);
      c.release(destroy ? true : undefined);
    }
  }

  private async migrate() {
    await this.tx(async (c) => {
      // Held until this transaction ends: a second process starting now waits here, then finds the work done.
      await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await c.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const r = await c.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
      const current = Number(r.rows[0].v);
      if (current > PG_MIGRATIONS.length) {
        throw new Error(`the database schema is version ${current}, newer than this server understands (${PG_MIGRATIONS.length}); deploy a newer server`);
      }
      if (current === PG_MIGRATIONS.length) return;
      for (let v = current; v < PG_MIGRATIONS.length; v++) await c.query(PG_MIGRATIONS[v]);
      await c.query('DELETE FROM schema_version');
      await c.query('INSERT INTO schema_version (version) VALUES ($1)', [PG_MIGRATIONS.length]);
    });
  }

  info(): StoreInfo {
    return { kind: 'postgres', durable: true };
  }

  // --- jobs

  private async insertJob(q: Queryable, job: StoredJob) {
    await q.query(
      `INSERT INTO jobs (id, owner, idem_key, status, started_at, finished_at, progress, result, error, billable, budget_key, plan, phase, heartbeat_at, instance_id, fail_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        job.id,
        job.owner,
        job.idemKey ?? null,
        job.status,
        job.startedAt,
        job.finishedAt ?? null,
        job.progress === undefined ? null : JSON.stringify(job.progress),
        job.result === undefined ? null : JSON.stringify(job.result),
        job.error ?? null,
        job.billable === false ? 0 : 1,
        job.budgetKey ?? job.owner,
        job.plan === undefined ? null : JSON.stringify(job.plan),
        job.phase ?? null,
        job.heartbeatAt ?? null,
        job.instanceId ?? null,
        job.failCode ?? null,
      ]
    );
  }
  async createJob(job: StoredJob) {
    await this.insertJob(this.db, job);
  }
  async getJob(id: string) {
    const r = await this.db.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }
  async findJobByKey(owner: string, idemKey: string) {
    const r = await this.db.query('SELECT * FROM jobs WHERE owner = $1 AND idem_key = $2', [owner, idemKey]);
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }
  async updateJob(id: string, patch: Parameters<Store['updateJob']>[1]) {
    const sets: string[] = [];
    const vals: any[] = [];
    const add = (col: string, v: any) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.progress !== undefined) add('progress', JSON.stringify(patch.progress));
    if (patch.result !== undefined) add('result', JSON.stringify(patch.result));
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
    if (patch.billable !== undefined) add('billable', patch.billable ? 1 : 0);
    if (patch.phase !== undefined) add('phase', patch.phase);
    if (patch.failCode !== undefined) add('fail_code', patch.failCode);
    if (sets.length === 0) return;
    vals.push(id);
    await this.db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
  async touchJob(id: string, now: number, patch: { phase?: string } = {}) {
    if (patch.phase !== undefined) {
      await this.db.query('UPDATE jobs SET heartbeat_at = $1, instance_id = $2, phase = $3 WHERE id = $4', [now, this.instanceId, patch.phase, id]);
    } else {
      await this.db.query('UPDATE jobs SET heartbeat_at = $1, instance_id = $2 WHERE id = $3', [now, this.instanceId, id]);
    }
  }

  // --- steps

  async createPlannedJob(job: StoredJob, steps: PlannedStep[]) {
    assertPlannedSteps(steps);
    await this.tx(async (c) => {
      await this.insertJob(c, job);
      if (steps.length === 0) return;
      const vals: any[] = [];
      const rows = steps.map((st, seq) => {
        const base = vals.length;
        vals.push(job.id, seq, st.key, st.kind, st.queryIndex ?? null, st.engine ?? null);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
      });
      await c.query(`INSERT INTO job_steps (job_id, seq, key, kind, query_index, engine) VALUES ${rows.join(',')}`, vals);
    });
  }
  async getJobSteps(jobId: string) {
    const r = await this.db.query('SELECT * FROM job_steps WHERE job_id = $1 ORDER BY seq', [jobId]);
    return r.rows.map(rowToStep);
  }
  async compactJobSteps(jobId: string) {
    await this.db.query("UPDATE job_steps SET result = NULL WHERE job_id = $1 AND state IN ('done', 'skipped')", [jobId]);
  }
  async claimStep(jobId: string, holder: string, leaseMs: number, now: number, maxAttempts: number): Promise<ClaimResult> {
    return this.tx(async (c) => {
      // The job's row is locked until this transaction ends, so two processes deciding on the same job take
      // turns and the second sees the first one's claim.
      const jr = await c.query('SELECT status, fail_code FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const row = jr.rows[0];
      const jobInfo = row ? { status: row.status as JobStatus, failCode: row.fail_code ?? undefined } : undefined;
      const steps: JobStep[] = (await c.query('SELECT * FROM job_steps WHERE job_id = $1 ORDER BY seq', [jobId])).rows.map(rowToStep);
      const d = decideClaim(jobInfo, steps, holder, leaseMs, now, maxAttempts);
      if (d.patch) {
        const p = d.patch;
        await c.query(
          `UPDATE job_steps SET state = $1, attempt = COALESCE($2, attempt), lease_until = $3, lease_holder = $4, call_started_at = $5,
             finished_at = COALESCE($6, finished_at), error_code = COALESCE($7, error_code), repeated_calls = COALESCE($8, repeated_calls)
           WHERE job_id = $9 AND seq = $10`,
          [p.state, p.attempt ?? null, p.leaseUntil ?? null, p.leaseHolder ?? null, p.callStartedAt ?? null, p.finishedAt ?? null, p.errorCode ?? null, p.repeatedCalls ?? null, jobId, steps[d.index].seq]
        );
      }
      return d.result;
    });
  }
  async markCallStarted(jobId: string, seq: number, holder: string, attempt: number, now: number) {
    const r = await this.db.query(
      "UPDATE job_steps SET call_started_at = $1 WHERE job_id = $2 AND seq = $3 AND state = 'leased' AND lease_holder = $4 AND attempt = $5",
      [now, jobId, seq, holder, attempt]
    );
    return (r.rowCount ?? 0) > 0;
  }
  async completeStep(jobId: string, seq: number, attempt: number, c: StepCompletion, now: number) {
    const r = await this.db.query(
      `UPDATE job_steps SET state = $1, result = $2, skip_reason = $3, error_code = $4, finished_at = $5, lease_until = NULL, lease_holder = NULL
       WHERE job_id = $6 AND seq = $7 AND state = 'leased' AND attempt = $8`,
      [c.state, c.result === undefined ? null : JSON.stringify(c.result), c.skipReason ?? null, c.errorCode ?? null, now, jobId, seq, attempt]
    );
    return (r.rowCount ?? 0) > 0;
  }

  // --- incidents and outcomes

  async recordIncident(incident: Omit<Incident, 'id'>) {
    await this.db.query('INSERT INTO incidents (job_id, at, kind, detail) VALUES ($1,$2,$3,$4)', [incident.jobId ?? null, incident.at, incident.kind, cutIncident(incident.detail)]);
  }
  async listIncidents(opts: { jobId?: string; limit?: number } = {}) {
    const r = opts.jobId
      ? await this.db.query('SELECT * FROM incidents WHERE job_id = $1 ORDER BY id DESC LIMIT $2', [opts.jobId, clampLimit(opts.limit)])
      : await this.db.query('SELECT * FROM incidents ORDER BY id DESC LIMIT $1', [clampLimit(opts.limit)]);
    return r.rows.map((x: any) => ({ id: Number(x.id), jobId: x.job_id ?? undefined, at: Number(x.at), kind: x.kind, detail: x.detail }) as Incident);
  }
  async countJobOutcomesSince(sinceMs: number) {
    const r = await this.db.query(
      `SELECT status, COALESCE(fail_code, 'none') AS code, billable, COUNT(*) AS n FROM jobs
       WHERE owner <> $1 AND status IN ('error', 'done') AND COALESCE(finished_at, started_at) >= $2
       GROUP BY status, COALESCE(fail_code, 'none'), billable`,
      [READINESS_PROBE_OWNER, sinceMs]
    );
    const failed: Record<string, number> = {};
    let degraded = 0;
    let succeeded = 0;
    for (const x of r.rows) {
      if (x.status === 'error') failed[x.code] = (failed[x.code] ?? 0) + Number(x.n);
      else if (Number(x.billable) === 0) degraded += Number(x.n);
      else succeeded += Number(x.n);
    }
    return { failed: Object.fromEntries(Object.entries(failed).sort(([a], [b]) => a.localeCompare(b))), degraded, succeeded };
  }

  // --- counts and sweeps

  async countRunning(maxAgeMs: number, now = Date.now(), staleAfterMs?: number) {
    const r =
      staleAfterMs === undefined
        ? await this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND started_at >= $1", [now - maxAgeMs])
        : await this.db.query(
            "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND started_at >= $1 AND (COALESCE(geo_plan_driver(plan), '') <> 'client' OR COALESCE(heartbeat_at, started_at) >= $2)",
            [now - maxAgeMs, now - staleAfterMs]
          );
    return Number(r.rows[0].n);
  }
  async countJobsSince(sinceMs: number, owner?: string) {
    const r = owner
      ? await this.db.query('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= $1 AND budget_key = $2 AND billable = 1', [sinceMs, owner])
      : await this.db.query('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= $1 AND billable = 1', [sinceMs]);
    return Number(r.rows[0].n);
  }
  async oldestJobSince(sinceMs: number, owner?: string) {
    const r = owner
      ? await this.db.query('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= $1 AND budget_key = $2 AND billable = 1', [sinceMs, owner])
      : await this.db.query('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= $1 AND billable = 1', [sinceMs]);
    return r.rows[0].t === null || r.rows[0].t === undefined ? null : Number(r.rows[0].t);
  }
  async failStuck(maxAgeMs: number, reason: string, now = Date.now()) {
    const r = await this.db.query(
      `UPDATE jobs SET status = 'error', error = $1, finished_at = $2, fail_code = $3,
         billable = CASE WHEN EXISTS (SELECT 1 FROM job_steps s WHERE s.job_id = jobs.id AND (s.call_started_at IS NOT NULL OR s.repeated_calls > 0)) THEN 1 ELSE 0 END
       WHERE status = 'running' AND started_at < $4`,
      [reason, now, STUCK_FAIL_CODE, now - maxAgeMs]
    );
    return r.rowCount ?? 0;
  }
  async failAllRunning(reason: string, now = Date.now()) {
    const r = await this.db.query("UPDATE jobs SET status = 'error', error = $1, finished_at = $2, billable = 0, fail_code = $3 WHERE status = 'running'", [reason, now, RESTARTED_FAIL_CODE]);
    return r.rowCount ?? 0;
  }
  async failRunningWithoutPlan(reason: string, now = Date.now()) {
    const r = await this.db.query("UPDATE jobs SET status = 'error', error = $1, finished_at = $2, billable = 0, fail_code = $3 WHERE status = 'running' AND plan IS NULL", [reason, now, RESTARTED_FAIL_CODE]);
    return r.rowCount ?? 0;
  }
  async releaseLeasesNotHeldBy(instanceId: string) {
    const r = await this.db.query("UPDATE job_steps SET lease_until = 0 WHERE state = 'leased' AND position($1::text in COALESCE(lease_holder, '')) = 0", [`:${instanceId}:`]);
    return r.rowCount ?? 0;
  }
  async listRunningPlanned() {
    const r = await this.db.query("SELECT * FROM jobs WHERE status = 'running' AND plan IS NOT NULL ORDER BY started_at");
    return r.rows.map(rowToJob);
  }
  async pruneJobs(beforeMs: number) {
    return this.tx(async (c) => {
      await c.query('DELETE FROM job_steps WHERE job_id IN (SELECT id FROM jobs WHERE started_at < $1)', [beforeMs]);
      await c.query('DELETE FROM incidents WHERE at < $1', [beforeMs]);
      const r = await c.query('DELETE FROM jobs WHERE started_at < $1', [beforeMs]);
      return r.rowCount ?? 0;
    });
  }

  // --- audits

  async saveAudit(owner: string, report: any) {
    // Re-saving an id replaces it, but only for the same owner: the WHERE leaves another owner's row untouched,
    // and the read-back below turns that into an error rather than a silent drop.
    await this.db.query(
      `INSERT INTO audits (id, owner, created_at, summary, report) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, summary = EXCLUDED.summary, report = EXCLUDED.report
       WHERE audits.owner = EXCLUDED.owner`,
      [report.id, owner, Date.parse(report.createdAt) || Date.now(), JSON.stringify(summariseAudit(report)), JSON.stringify(report)]
    );
    if (!(await this.getAudit(owner, report.id))) throw new Error('audit id belongs to another owner');
  }
  async listAudits(owner: string, limit = 50) {
    const r = await this.db.query('SELECT summary FROM audits WHERE owner = $1 ORDER BY created_at DESC LIMIT $2', [owner, limit]);
    return r.rows.map((x: any) => JSON.parse(x.summary) as AuditSummary);
  }
  async getAudit(owner: string, id: string) {
    const r = await this.db.query('SELECT report FROM audits WHERE owner = $1 AND id = $2', [owner, id]);
    return r.rows[0] ? JSON.parse(r.rows[0].report) : null;
  }
  async deleteAudit(owner: string, id: string) {
    const r = await this.db.query('DELETE FROM audits WHERE owner = $1 AND id = $2', [owner, id]);
    return (r.rowCount ?? 0) > 0;
  }

  close() {
    void this.pool.end().catch(() => undefined);
  }
}
