/**
 * Durable state: audit jobs and saved audits.
 *
 * Until now every piece of server state was a process-global Map, so a restart
 * lost in-flight audits, a second instance could not see the first one's jobs,
 * and a refresh destroyed a finished (paid-for) audit (TECH_DEBT.md 2.1, 2.3,
 * 1.4c). This module is the one place that state lives.
 *
 * Two implementations behind one interface:
 *  - SQLite (`node:sqlite`, built into Node 22 - no dependency): survives
 *    restarts. Right for one always-on process with a persistent disk.
 *  - Memory: honest about being non-durable (`durable: false`), used on
 *    serverless hosts that have no disk and in tests.
 * The interface is async so a Postgres implementation can replace SQLite
 * later without touching callers (a second *instance* needs that; SQLite is
 * single-host by nature).
 */

import fs from 'fs';
import path from 'path';

export type JobStatus = 'running' | 'done' | 'error';

export interface StoredJob {
  id: string;
  /** Normalised email of the signed-in user who started it. */
  owner: string;
  /** The client's Idempotency-Key for the click that started it, if any. */
  idemKey?: string;
  /** What the daily budget is counted against (the access code's label). Defaults to owner. */
  budgetKey?: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  progress?: unknown;
  result?: any;
  error?: string;
  /**
   * Whether this job counts against the daily audit budget. An audit that
   * failed without collecting any evidence spent nothing and must not use up
   * someone's allowance. Defaults to true.
   */
  billable?: boolean;
  /** Step-wise audits (docs/PLAN_STEP_E.md): the planned work, what it is doing, and who last touched it. */
  plan?: unknown;
  phase?: string;
  heartbeatAt?: number;
  instanceId?: string;
  /** A short machine code for why a job failed (e.g. `step_attempts_exceeded`), beside the sentence in `error`. */
  failCode?: string;
}

// ---- step-wise audits ------------------------------------------------------------------------
// A job can be planned as an ordered list of steps (one answer-engine call each, then the narrative, then
// the finish). A step is claimed under a lease, so two callers never run one step at the same time, and an
// unfinished step is retried only a bounded number of times. Exactly-once is impossible for a call to an
// outside service; what is recorded is when a call STARTED, so a step that died mid-call is counted as a
// possibly repeated call instead of being hidden. Nothing in the server uses this yet (slice S2).

export type StepKind = 'collect' | 'narrative' | 'finalize';
export type StepState = 'pending' | 'leased' | 'done' | 'skipped' | 'failed';

export interface PlannedStep {
  /** Stable name, e.g. `collect:0:Gemini`. */
  key: string;
  kind: StepKind;
  queryIndex?: number;
  engine?: string;
}

export interface JobStep extends PlannedStep {
  jobId: string;
  /** Position in the plan; steps run in this order. */
  seq: number;
  state: StepState;
  /** How many times it has been claimed. */
  attempt: number;
  leaseUntil?: number;
  leaseHolder?: string;
  /** Set just before the outside call; empty when the step has not reached it. */
  callStartedAt?: number;
  finishedAt?: number;
  result?: any;
  skipReason?: string;
  errorCode?: string;
  /** Times a step was re-claimed after its lease expired with a call already started. */
  repeatedCalls: number;
}

export interface StepCompletion {
  state: 'done' | 'skipped' | 'failed';
  result?: any;
  skipReason?: string;
  errorCode?: string;
}

export type ClaimResult =
  | { outcome: 'claimed'; step: JobStep; reclaimedMidCall: boolean }
  /** Another holder has the step and its lease has not expired. */
  | { outcome: 'busy'; step: JobStep }
  /** The step was claimed `maxAttempts` times and never finished: it is now failed. */
  | { outcome: 'exhausted'; step: JobStep }
  /** Nothing to claim: the job is finished, failed, unknown, or all its steps are in a final state. */
  | { outcome: 'none' };

export type IncidentKind = 'lease_expired_midcall' | 'step_attempts_exceeded' | 'invariant';

export interface Incident {
  id: number;
  jobId?: string;
  at: number;
  kind: IncidentKind;
  /** A sentence for the owner. Never a provider payload or a secret. */
  detail: string;
}

/**
 * The one definition of "may this step be claimed now" (both stores call it, so they cannot drift).
 * Steps run in order: only the first step that is not finished is ever considered.
 */
export function decideClaim(
  jobStatus: JobStatus | undefined,
  steps: JobStep[],
  holder: string,
  leaseMs: number,
  now: number,
  maxAttempts: number
): { result: ClaimResult; index: number; patch?: Partial<JobStep> } {
  const none = { result: { outcome: 'none' } as ClaimResult, index: -1 };
  if (jobStatus !== 'running') return none;
  if (steps.some((st) => st.state === 'failed')) return none;
  const index = steps.findIndex((st) => st.state === 'pending' || st.state === 'leased');
  if (index < 0) return none;
  const step = steps[index];
  if (step.state === 'leased' && (step.leaseUntil ?? 0) > now) return { result: { outcome: 'busy', step }, index };
  if (step.attempt >= maxAttempts) {
    const patch: Partial<JobStep> = { state: 'failed', errorCode: 'step_attempts_exceeded', finishedAt: now, leaseUntil: undefined, leaseHolder: undefined };
    return { result: { outcome: 'exhausted', step: { ...step, ...patch } }, index, patch };
  }
  const reclaimedMidCall = step.state === 'leased' && step.callStartedAt !== undefined;
  const patch: Partial<JobStep> = {
    state: 'leased',
    attempt: step.attempt + 1,
    leaseUntil: now + leaseMs,
    leaseHolder: holder,
    callStartedAt: undefined,
    repeatedCalls: step.repeatedCalls + (reclaimedMidCall ? 1 : 0),
  };
  return { result: { outcome: 'claimed', step: { ...step, ...patch }, reclaimedMidCall }, index, patch };
}

export interface AuditSummary {
  id: string;
  createdAt: string;
  businessName: string;
  domain: string;
  industry: string;
  geoVisibilityScore: number;
  shareOfVoice: number;
  leaderShare: number;
  accuracyRate: number | null;
  observationsWithEvidence?: number;
  observationsMentioned?: number;
  observationsAttempted?: number;
  measuredEngines?: string[];
  narrativeAvailable?: boolean;
  queriesCount: number;
}

export interface StoreInfo {
  kind: 'sqlite' | 'memory';
  /** True only when state survives a process restart. */
  durable: boolean;
  /** Why this is not the store the operator probably wanted, when it is not. */
  note?: string;
  /** Names this running store, so a job can say which instance last touched it. New on every start. */
  instanceId: string;
}

export interface Store {
  info(): StoreInfo;

  createJob(job: StoredJob): Promise<void>;
  getJob(id: string): Promise<StoredJob | null>;
  findJobByKey(owner: string, idemKey: string): Promise<StoredJob | null>;
  updateJob(
    id: string,
    patch: Partial<Pick<StoredJob, 'status' | 'progress' | 'result' | 'error' | 'finishedAt' | 'billable' | 'phase' | 'failCode'>>
  ): Promise<void>;
  /** Record that something is working on the job now (and which instance), optionally with a phase. */
  touchJob(id: string, now: number, patch?: { phase?: string }): Promise<void>;

  /** Create a job and its ordered steps in one atomic write; the same idempotency rule as createJob. */
  createPlannedJob(job: StoredJob, steps: PlannedStep[]): Promise<void>;
  getJobSteps(jobId: string): Promise<JobStep[]>;
  /** Claim the next step under a lease. See `decideClaim` for the rules. */
  claimStep(jobId: string, holder: string, leaseMs: number, now: number, maxAttempts: number): Promise<ClaimResult>;
  /** Record that the outside call is about to start. False when the caller no longer holds the lease. */
  markCallStarted(jobId: string, seq: number, holder: string, now: number): Promise<boolean>;
  /** Store a step's outcome. The first writer wins: false when the step already has a final state. */
  completeStep(jobId: string, seq: number, completion: StepCompletion, now: number): Promise<boolean>;
  recordIncident(incident: Omit<Incident, 'id'>): Promise<void>;
  /** Newest first. */
  listIncidents(opts?: { jobId?: string; limit?: number }): Promise<Incident[]>;
  /** Jobs still running that started within `maxAgeMs`. */
  countRunning(maxAgeMs: number, now?: number): Promise<number>;
  /** Billable jobs started at or after `sinceMs` under one budget key, or (omitted) everyone's. */
  countJobsSince(sinceMs: number, budgetKey?: string): Promise<number>;
  /** Start time of the oldest such job, for "try again at". */
  oldestJobSince(sinceMs: number, budgetKey?: string): Promise<number | null>;
  /** Mark running jobs older than `maxAgeMs` as failed. Returns how many. */
  failStuck(maxAgeMs: number, reason: string, now?: number): Promise<number>;
  /** Mark EVERY running job failed - run once at boot, when none can still be alive. */
  failAllRunning(reason: string, now?: number): Promise<number>;
  /** Delete jobs that started before `beforeMs`. */
  pruneJobs(beforeMs: number): Promise<number>;

  saveAudit(owner: string, report: any): Promise<void>;
  listAudits(owner: string, limit?: number): Promise<AuditSummary[]>;
  getAudit(owner: string, id: string): Promise<any | null>;
  deleteAudit(owner: string, id: string): Promise<boolean>;

  close(): void;
}

export function summariseAudit(report: any): AuditSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    businessName: report.businessName,
    domain: report.domain || '',
    industry: report.industry || '',
    geoVisibilityScore: report.geoVisibilityScore,
    shareOfVoice: report.shareOfVoice,
    leaderShare: report.leaderShare,
    accuracyRate: report.accuracyRate ?? null,
    observationsWithEvidence: report.observationsWithEvidence,
    observationsMentioned: report.observationsMentioned,
    observationsAttempted: report.observationsAttempted,
    measuredEngines: report.measuredEngines,
    narrativeAvailable: report.narrativeAvailable,
    queriesCount: Array.isArray(report.queriesTested) ? report.queriesTested.length : 0,
  };
}

function newInstanceId(): string {
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A claim result that shares no object with the stored rows. */
function cloneClaim(r: ClaimResult): ClaimResult {
  return r.outcome === 'none' ? r : { ...r, step: { ...r.step } };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private jobs = new Map<string, StoredJob>();
  private audits = new Map<string, { owner: string; createdAtMs: number; report: any }>();
  private steps = new Map<string, JobStep[]>();
  private incidents: Incident[] = [];
  private nextIncidentId = 1;
  private readonly instanceId = newInstanceId();

  constructor(private readonly note?: string) {}

  info(): StoreInfo {
    return { kind: 'memory', durable: false, note: this.note, instanceId: this.instanceId };
  }

  async createJob(job: StoredJob) {
    if (job.idemKey && (await this.findJobByKey(job.owner, job.idemKey))) {
      throw new Error('duplicate idempotency key');
    }
    this.jobs.set(job.id, { ...job, billable: job.billable ?? true, budgetKey: job.budgetKey ?? job.owner });
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }
  async findJobByKey(owner: string, idemKey: string) {
    for (const j of this.jobs.values()) {
      if (j.owner === owner && j.idemKey === idemKey) return { ...j };
    }
    return null;
  }
  async updateJob(id: string, patch: Parameters<Store['updateJob']>[1]) {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, patch);
  }
  async touchJob(id: string, now: number, patch: { phase?: string } = {}) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.heartbeatAt = now;
    j.instanceId = this.instanceId;
    if (patch.phase !== undefined) j.phase = patch.phase;
  }
  async createPlannedJob(job: StoredJob, steps: PlannedStep[]) {
    await this.createJob(job);
    this.steps.set(
      job.id,
      steps.map((st, seq) => ({ ...st, jobId: job.id, seq, state: 'pending' as const, attempt: 0, repeatedCalls: 0 }))
    );
  }
  async getJobSteps(jobId: string) {
    return (this.steps.get(jobId) || []).map((st) => ({ ...st }));
  }
  async claimStep(jobId: string, holder: string, leaseMs: number, now: number, maxAttempts: number) {
    const list = this.steps.get(jobId) || [];
    const d = decideClaim(this.jobs.get(jobId)?.status, list, holder, leaseMs, now, maxAttempts);
    if (d.patch) Object.assign(list[d.index], d.patch);
    return cloneClaim(d.result);
  }
  async markCallStarted(jobId: string, seq: number, holder: string, now: number) {
    const st = (this.steps.get(jobId) || [])[seq];
    if (!st || st.state !== 'leased' || st.leaseHolder !== holder) return false;
    st.callStartedAt = now;
    return true;
  }
  async completeStep(jobId: string, seq: number, c: StepCompletion, now: number) {
    const st = (this.steps.get(jobId) || [])[seq];
    if (!st || st.state !== 'leased') return false;
    st.state = c.state;
    st.result = c.result;
    st.skipReason = c.skipReason;
    st.errorCode = c.errorCode;
    st.finishedAt = now;
    st.leaseUntil = undefined;
    st.leaseHolder = undefined;
    return true;
  }
  async recordIncident(incident: Omit<Incident, 'id'>) {
    this.incidents.push({ ...incident, id: this.nextIncidentId++ });
  }
  async listIncidents(opts: { jobId?: string; limit?: number } = {}) {
    return this.incidents
      .filter((i) => !opts.jobId || i.jobId === opts.jobId)
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 50)
      .map((i) => ({ ...i }));
  }
  async countRunning(maxAgeMs: number, now = Date.now()) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'running' && now - j.startedAt <= maxAgeMs) n++;
    return n;
  }
  async countJobsSince(sinceMs: number, owner?: string) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.startedAt >= sinceMs && j.billable !== false && (!owner || j.budgetKey === owner)) n++;
    }
    return n;
  }
  async oldestJobSince(sinceMs: number, owner?: string) {
    let oldest: number | null = null;
    for (const j of this.jobs.values()) {
      if (j.startedAt >= sinceMs && j.billable !== false && (!owner || j.budgetKey === owner)) {
        if (oldest === null || j.startedAt < oldest) oldest = j.startedAt;
      }
    }
    return oldest;
  }
  async failStuck(maxAgeMs: number, reason: string, now = Date.now()) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'running' && now - j.startedAt > maxAgeMs) {
        j.status = 'error';
        j.error = reason;
        j.finishedAt = now;
        j.billable = false;
        n++;
      }
    }
    return n;
  }
  async failAllRunning(reason: string, now = Date.now()) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'running') {
        j.status = 'error';
        j.error = reason;
        j.finishedAt = now;
        j.billable = false;
        n++;
      }
    }
    return n;
  }
  async pruneJobs(beforeMs: number) {
    let n = 0;
    for (const [id, j] of this.jobs) {
      if (j.startedAt < beforeMs) {
        this.jobs.delete(id);
        this.steps.delete(id);
        n++;
      }
    }
    this.incidents = this.incidents.filter((i) => i.at >= beforeMs);
    return n;
  }

  async saveAudit(owner: string, report: any) {
    const existing = this.audits.get(report.id);
    if (existing && existing.owner !== owner) throw new Error('audit id belongs to another owner');
    this.audits.set(report.id, { owner, createdAtMs: Date.parse(report.createdAt) || Date.now(), report });
  }
  async listAudits(owner: string, limit = 50) {
    return Array.from(this.audits.values())
      .filter((a) => a.owner === owner)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit)
      .map((a) => summariseAudit(a.report));
  }
  async getAudit(owner: string, id: string) {
    const a = this.audits.get(id);
    return a && a.owner === owner ? a.report : null;
  }
  async deleteAudit(owner: string, id: string) {
    const a = this.audits.get(id);
    if (!a || a.owner !== owner) return false;
    this.audits.delete(id);
    return true;
  }
  close() {}
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/** Each entry upgrades the schema by one version; never edit an applied one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    idem_key TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    progress TEXT,
    result TEXT,
    error TEXT
  );
  CREATE INDEX jobs_started ON jobs(started_at);
  CREATE INDEX jobs_owner_started ON jobs(owner, started_at);
  CREATE UNIQUE INDEX jobs_owner_idem ON jobs(owner, idem_key) WHERE idem_key IS NOT NULL;
  CREATE TABLE audits (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    summary TEXT NOT NULL,
    report TEXT NOT NULL
  );
  CREATE INDEX audits_owner_created ON audits(owner, created_at DESC);
  `,
  // 2: failed-without-evidence jobs must not consume the daily budget.
  `ALTER TABLE jobs ADD COLUMN billable INTEGER NOT NULL DEFAULT 1;`,
  // 3: budgets are counted per access code (label), not per claimed email.
  `ALTER TABLE jobs ADD COLUMN budget_key TEXT;
   UPDATE jobs SET budget_key = CASE WHEN instr(owner, '|') > 0 THEN substr(owner, 1, instr(owner, '|') - 1) ELSE owner END;
   CREATE INDEX jobs_budget_started ON jobs(budget_key, started_at);`,
  // 4: step-wise audits - what a job is doing and who last touched it.
  `ALTER TABLE jobs ADD COLUMN plan TEXT;
   ALTER TABLE jobs ADD COLUMN phase TEXT;
   ALTER TABLE jobs ADD COLUMN heartbeat_at INTEGER;
   ALTER TABLE jobs ADD COLUMN instance_id TEXT;
   ALTER TABLE jobs ADD COLUMN fail_code TEXT;`,
  // 5: the ordered steps of a job, and incidents the owner can read.
  `CREATE TABLE job_steps (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    query_index INTEGER,
    engine TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    lease_holder TEXT,
    call_started_at INTEGER,
    finished_at INTEGER,
    result TEXT,
    skip_reason TEXT,
    error_code TEXT,
    repeated_calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, seq)
   );
   CREATE TABLE incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
   );
   CREATE INDEX incidents_at ON incidents(at);
   CREATE INDEX incidents_job ON incidents(job_id);`,
];

type Row = Record<string, any>;

function rowToJob(r: Row): StoredJob {
  return {
    id: r.id,
    owner: r.owner,
    idemKey: r.idem_key ?? undefined,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    progress: r.progress ? JSON.parse(r.progress) : undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error ?? undefined,
    billable: r.billable === 0 ? false : true,
    plan: r.plan ? JSON.parse(r.plan) : undefined,
    phase: r.phase ?? undefined,
    heartbeatAt: r.heartbeat_at ?? undefined,
    instanceId: r.instance_id ?? undefined,
    failCode: r.fail_code ?? undefined,
  };
}

function rowToStep(r: Row): JobStep {
  return {
    jobId: r.job_id,
    seq: r.seq,
    key: r.key,
    kind: r.kind,
    queryIndex: r.query_index ?? undefined,
    engine: r.engine ?? undefined,
    state: r.state,
    attempt: r.attempt,
    leaseUntil: r.lease_until ?? undefined,
    leaseHolder: r.lease_holder ?? undefined,
    callStartedAt: r.call_started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
    skipReason: r.skip_reason ?? undefined,
    errorCode: r.error_code ?? undefined,
    repeatedCalls: r.repeated_calls,
  };
}

export class SqliteStore implements Store {
  private db: any;
  private readonly instanceId = newInstanceId();

  constructor(
    DatabaseSync: new (p: string) => any,
    readonly filePath: string
  ) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate() {
    const current: number = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  info(): StoreInfo {
    return { kind: 'sqlite', durable: this.filePath !== ':memory:', instanceId: this.instanceId };
  }

  async createJob(job: StoredJob) {
    this.insertJob(job);
  }
  /** Synchronous on purpose: createPlannedJob must see a duplicate-key error INSIDE its transaction. */
  private insertJob(job: StoredJob) {
    this.db
      .prepare(
        'INSERT INTO jobs (id, owner, idem_key, status, started_at, finished_at, progress, result, error, billable, budget_key, plan, phase, heartbeat_at, instance_id, fail_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
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
        job.failCode ?? null
      );
  }
  async getJob(id: string) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? rowToJob(r) : null;
  }
  async findJobByKey(owner: string, idemKey: string) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE owner = ? AND idem_key = ?').get(owner, idemKey);
    return r ? rowToJob(r) : null;
  }
  async updateJob(id: string, patch: Parameters<Store['updateJob']>[1]) {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status));
    if (patch.progress !== undefined) (sets.push('progress = ?'), vals.push(JSON.stringify(patch.progress)));
    if (patch.result !== undefined) (sets.push('result = ?'), vals.push(JSON.stringify(patch.result)));
    if (patch.error !== undefined) (sets.push('error = ?'), vals.push(patch.error));
    if (patch.finishedAt !== undefined) (sets.push('finished_at = ?'), vals.push(patch.finishedAt));
    if (patch.billable !== undefined) (sets.push('billable = ?'), vals.push(patch.billable ? 1 : 0));
    if (patch.phase !== undefined) (sets.push('phase = ?'), vals.push(patch.phase));
    if (patch.failCode !== undefined) (sets.push('fail_code = ?'), vals.push(patch.failCode));
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  async touchJob(id: string, now: number, patch: { phase?: string } = {}) {
    if (patch.phase !== undefined) {
      this.db.prepare('UPDATE jobs SET heartbeat_at = ?, instance_id = ?, phase = ? WHERE id = ?').run(now, this.instanceId, patch.phase, id);
    } else {
      this.db.prepare('UPDATE jobs SET heartbeat_at = ?, instance_id = ? WHERE id = ?').run(now, this.instanceId, id);
    }
  }
  /** Run `fn` as one write transaction that no other connection can interleave with. */
  private immediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  async createPlannedJob(job: StoredJob, steps: PlannedStep[]) {
    this.immediate(() => {
      this.insertJob(job);
      const insert = this.db.prepare('INSERT INTO job_steps (job_id, seq, key, kind, query_index, engine) VALUES (?,?,?,?,?,?)');
      steps.forEach((st, seq) => insert.run(job.id, seq, st.key, st.kind, st.queryIndex ?? null, st.engine ?? null));
    });
  }
  async getJobSteps(jobId: string) {
    return this.db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq').all(jobId).map(rowToStep);
  }
  async claimStep(jobId: string, holder: string, leaseMs: number, now: number, maxAttempts: number) {
    return this.immediate(() => {
      const status = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status as JobStatus | undefined;
      const steps: JobStep[] = this.db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq').all(jobId).map(rowToStep);
      const d = decideClaim(status, steps, holder, leaseMs, now, maxAttempts);
      if (d.patch) {
        const p = d.patch;
        const seq = steps[d.index].seq;
        this.db
          .prepare(
            'UPDATE job_steps SET state = ?, attempt = COALESCE(?, attempt), lease_until = ?, lease_holder = ?, call_started_at = ?, finished_at = COALESCE(?, finished_at), error_code = COALESCE(?, error_code), repeated_calls = COALESCE(?, repeated_calls) WHERE job_id = ? AND seq = ?'
          )
          .run(p.state, p.attempt ?? null, p.leaseUntil ?? null, p.leaseHolder ?? null, p.callStartedAt ?? null, p.finishedAt ?? null, p.errorCode ?? null, p.repeatedCalls ?? null, jobId, seq);
      }
      return d.result;
    });
  }
  async markCallStarted(jobId: string, seq: number, holder: string, now: number) {
    return (
      Number(
        this.db
          .prepare("UPDATE job_steps SET call_started_at = ? WHERE job_id = ? AND seq = ? AND state = 'leased' AND lease_holder = ?")
          .run(now, jobId, seq, holder).changes
      ) > 0
    );
  }
  async completeStep(jobId: string, seq: number, c: StepCompletion, now: number) {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE job_steps SET state = ?, result = ?, skip_reason = ?, error_code = ?, finished_at = ?, lease_until = NULL, lease_holder = NULL WHERE job_id = ? AND seq = ? AND state = 'leased'"
          )
          .run(c.state, c.result === undefined ? null : JSON.stringify(c.result), c.skipReason ?? null, c.errorCode ?? null, now, jobId, seq).changes
      ) > 0
    );
  }
  async recordIncident(incident: Omit<Incident, 'id'>) {
    this.db.prepare('INSERT INTO incidents (job_id, at, kind, detail) VALUES (?,?,?,?)').run(incident.jobId ?? null, incident.at, incident.kind, incident.detail);
  }
  async listIncidents(opts: { jobId?: string; limit?: number } = {}) {
    const rows = opts.jobId
      ? this.db.prepare('SELECT * FROM incidents WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(opts.jobId, opts.limit ?? 50)
      : this.db.prepare('SELECT * FROM incidents ORDER BY id DESC LIMIT ?').all(opts.limit ?? 50);
    return rows.map((r: Row) => ({ id: r.id, jobId: r.job_id ?? undefined, at: r.at, kind: r.kind, detail: r.detail }) as Incident);
  }
  async countRunning(maxAgeMs: number, now = Date.now()) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND started_at >= ?")
      .get(now - maxAgeMs).n;
  }
  async countJobsSince(sinceMs: number, owner?: string) {
    return owner
      ? this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= ? AND budget_key = ? AND billable = 1').get(sinceMs, owner).n
      : this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= ? AND billable = 1').get(sinceMs).n;
  }
  async oldestJobSince(sinceMs: number, owner?: string) {
    const r = owner
      ? this.db.prepare('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= ? AND budget_key = ? AND billable = 1').get(sinceMs, owner)
      : this.db.prepare('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= ? AND billable = 1').get(sinceMs);
    return r.t ?? null;
  }
  async failStuck(maxAgeMs: number, reason: string, now = Date.now()) {
    return Number(
      this.db
        .prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ?, billable = 0 WHERE status = 'running' AND started_at < ?")
        .run(reason, now, now - maxAgeMs).changes
    );
  }
  async failAllRunning(reason: string, now = Date.now()) {
    return Number(
      this.db
        .prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ?, billable = 0 WHERE status = 'running'")
        .run(reason, now).changes
    );
  }
  async pruneJobs(beforeMs: number) {
    return this.immediate(() => {
      this.db.prepare('DELETE FROM job_steps WHERE job_id IN (SELECT id FROM jobs WHERE started_at < ?)').run(beforeMs);
      this.db.prepare('DELETE FROM incidents WHERE at < ?').run(beforeMs);
      return Number(this.db.prepare('DELETE FROM jobs WHERE started_at < ?').run(beforeMs).changes);
    });
  }

  async saveAudit(owner: string, report: any) {
    this.db
      // Re-saving an id replaces it, but only for the same owner: ON CONFLICT
      // with a WHERE leaves another owner's row untouched, and `changes` of 0
      // is then reported as an error rather than silently dropped.
      .prepare(
        `INSERT INTO audits (id, owner, created_at, summary, report) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, summary = excluded.summary, report = excluded.report
         WHERE audits.owner = excluded.owner`
      )
      .run(
        report.id,
        owner,
        Date.parse(report.createdAt) || Date.now(),
        JSON.stringify(summariseAudit(report)),
        JSON.stringify(report)
      );
    if (!(await this.getAudit(owner, report.id))) throw new Error('audit id belongs to another owner');
  }
  async listAudits(owner: string, limit = 50) {
    return this.db
      .prepare('SELECT summary FROM audits WHERE owner = ? ORDER BY created_at DESC LIMIT ?')
      .all(owner, limit)
      .map((r: Row) => JSON.parse(r.summary) as AuditSummary);
  }
  async getAudit(owner: string, id: string) {
    const r = this.db.prepare('SELECT report FROM audits WHERE owner = ? AND id = ?').get(owner, id);
    return r ? JSON.parse(r.report) : null;
  }
  async deleteAudit(owner: string, id: string) {
    return Number(this.db.prepare('DELETE FROM audits WHERE owner = ? AND id = ?').run(owner, id).changes) > 0;
  }
  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface OpenStoreOptions {
  /** Directory for the database file. Unset means "no durable storage configured". */
  dataDir?: string;
  /** Hosts with no usable disk (Vercel) cannot be durable; say so instead of failing. */
  serverless?: boolean;
  log?: (message: string) => void;
}

/**
 * Open the best store this environment can honestly offer. Never throws: a
 * missing disk or an old Node falls back to memory with a `note`, because an
 * audit tool that cannot start is worse than one that says it cannot save.
 */
export async function openStore(opts: OpenStoreOptions = {}): Promise<Store> {
  const log = opts.log ?? ((m: string) => console.warn(m));

  if (opts.serverless) {
    return new MemoryStore(
      'Serverless hosts have no persistent disk, so audits and jobs are not saved here. Use an always-on host with a disk (see docs/DEPLOYMENT.md).'
    );
  }
  if (!opts.dataDir) {
    return new MemoryStore(
      'DATA_DIR is not set, so audits and jobs are kept in memory only and are lost on restart. Set DATA_DIR to a persistent directory.'
    );
  }

  try {
    const sqlite: any = await import('node:sqlite');
    return new SqliteStore(sqlite.DatabaseSync, path.join(opts.dataDir, 'geo-audit.sqlite'));
  } catch (err: any) {
    // The detail (a filesystem path and an OS error) goes to the server log only:
    // the note is shown on the public status endpoint and must not leak either.
    log(`[store] could not open the SQLite database in ${opts.dataDir}: ${err?.message || err}`);
    return new MemoryStore(
      'The database could not be opened, so storage fell back to memory and nothing is saved. The server log has the detail; check that DATA_DIR exists and is writable.'
    );
  }
}
