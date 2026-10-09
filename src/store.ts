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
}

export interface Store {
  info(): StoreInfo;

  createJob(job: StoredJob): Promise<void>;
  getJob(id: string): Promise<StoredJob | null>;
  findJobByKey(owner: string, idemKey: string): Promise<StoredJob | null>;
  updateJob(
    id: string,
    patch: Partial<Pick<StoredJob, 'status' | 'progress' | 'result' | 'error' | 'finishedAt' | 'billable'>>
  ): Promise<void>;
  /** Jobs still running that started within `maxAgeMs`. */
  countRunning(maxAgeMs: number, now?: number): Promise<number>;
  /** Jobs started at or after `sinceMs`, by one owner or (owner omitted) everyone. */
  countJobsSince(sinceMs: number, owner?: string): Promise<number>;
  /** Start time of the oldest job at or after `sinceMs`, for "try again at". */
  oldestJobSince(sinceMs: number, owner?: string): Promise<number | null>;
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

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private jobs = new Map<string, StoredJob>();
  private audits = new Map<string, { owner: string; createdAtMs: number; report: any }>();

  constructor(private readonly note?: string) {}

  info(): StoreInfo {
    return { kind: 'memory', durable: false, note: this.note };
  }

  async createJob(job: StoredJob) {
    if (job.idemKey && (await this.findJobByKey(job.owner, job.idemKey))) {
      throw new Error('duplicate idempotency key');
    }
    this.jobs.set(job.id, { ...job, billable: job.billable ?? true });
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
  async countRunning(maxAgeMs: number, now = Date.now()) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'running' && now - j.startedAt <= maxAgeMs) n++;
    return n;
  }
  async countJobsSince(sinceMs: number, owner?: string) {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.startedAt >= sinceMs && j.billable !== false && (!owner || j.owner === owner)) n++;
    }
    return n;
  }
  async oldestJobSince(sinceMs: number, owner?: string) {
    let oldest: number | null = null;
    for (const j of this.jobs.values()) {
      if (j.startedAt >= sinceMs && j.billable !== false && (!owner || j.owner === owner)) {
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
        n++;
      }
    }
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
const MIGRATIONS: string[] = [
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
  };
}

export class SqliteStore implements Store {
  private db: any;

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
    return { kind: 'sqlite', durable: this.filePath !== ':memory:' };
  }

  async createJob(job: StoredJob) {
    this.db
      .prepare(
        'INSERT INTO jobs (id, owner, idem_key, status, started_at, finished_at, progress, result, error, billable) VALUES (?,?,?,?,?,?,?,?,?,?)'
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
        job.billable === false ? 0 : 1
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
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  async countRunning(maxAgeMs: number, now = Date.now()) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND started_at >= ?")
      .get(now - maxAgeMs).n;
  }
  async countJobsSince(sinceMs: number, owner?: string) {
    return owner
      ? this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= ? AND owner = ? AND billable = 1').get(sinceMs, owner).n
      : this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE started_at >= ? AND billable = 1').get(sinceMs).n;
  }
  async oldestJobSince(sinceMs: number, owner?: string) {
    const r = owner
      ? this.db.prepare('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= ? AND owner = ? AND billable = 1').get(sinceMs, owner)
      : this.db.prepare('SELECT MIN(started_at) AS t FROM jobs WHERE started_at >= ? AND billable = 1').get(sinceMs);
    return r.t ?? null;
  }
  async failStuck(maxAgeMs: number, reason: string, now = Date.now()) {
    return Number(
      this.db
        .prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE status = 'running' AND started_at < ?")
        .run(reason, now, now - maxAgeMs).changes
    );
  }
  async failAllRunning(reason: string, now = Date.now()) {
    return Number(
      this.db
        .prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE status = 'running'")
        .run(reason, now).changes
    );
  }
  async pruneJobs(beforeMs: number) {
    return Number(this.db.prepare('DELETE FROM jobs WHERE started_at < ?').run(beforeMs).changes);
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
    const note = `Could not open the SQLite database in ${opts.dataDir} (${err?.message || err}); falling back to memory, so nothing is saved.`;
    log(`[store] ${note}`);
    return new MemoryStore(note);
  }
}
