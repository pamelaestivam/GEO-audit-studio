#!/usr/bin/env node
/**
 * Consistent snapshot of the SQLite database - safe to run while the server is up.
 *
 *   node scripts/backup.mjs [DATA_DIR] [OUT_FILE]
 *   docker exec <container> node scripts/backup.mjs /data /data/backups/now.sqlite
 *
 * Why this exists: the database runs in WAL mode, so a running server's recent
 * writes live in `geo-audit.sqlite-wal`, not in `geo-audit.sqlite`. Copying only
 * the .sqlite file (the obvious backup) restores an EMPTY or stale database -
 * measured: one finished audit, a 4 KB main file, 119 KB in the WAL, and a
 * restore from the copied main file showed no audits. `VACUUM INTO` writes one
 * self-contained file from a consistent view, and needs no `sqlite3` CLI (the
 * slim Node image does not ship one). Restore = stop the server, put this file
 * at DATA_DIR/geo-audit.sqlite, delete any -wal/-shm beside it, start.
 *
 * The copy is opened and checked before this reports success.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.argv[2] || process.env.DATA_DIR || './data';
const source = path.join(dataDir, 'geo-audit.sqlite');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// Absolute, so a path such as `file:x.sqlite` is a file name here and never a SQLite URI.
const out = path.resolve(process.argv[3] || path.join(dataDir, 'backups', `geo-audit-${stamp}.sqlite`));

let tmp = '';
/** Remove the temporary copy; never throws (the directory may not even exist). */
function cleanup() {
  try {
    if (tmp) fs.rmSync(tmp, { force: true });
  } catch {
    /* nothing to clean */
  }
}
function fail(message) {
  // process.exit() skips `finally`, so the temporary copy is removed here.
  cleanup();
  console.error(`backup failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(source)) fail(`no database at ${source} (is DATA_DIR right?)`);
if (fs.existsSync(out)) fail(`${out} already exists; refusing to overwrite a backup`);

// Written to a temporary name this process alone owns, checked, and only then
// given its final name with link() - which, unlike rename(), refuses to replace an
// existing file. So a failed or racing run can never delete or overwrite a good
// backup. (The hard-link path never leaves a half-written file under the final name; the
// no-hard-link fallback is a plain copy and can, if the process is killed mid-copy.)
tmp = `${out}.tmp-${process.pid}`;
try {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const db = new DatabaseSync(source);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  db.close();

  const copy = new DatabaseSync(tmp);
  const integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  const audits = copy.prepare('SELECT COUNT(*) AS n FROM audits').get().n;
  const jobs = copy.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const version = copy.prepare('PRAGMA user_version').get().user_version;
  copy.close();
  if (integrity !== 'ok') throw new Error(`the copy failed its integrity check: ${integrity}`);

  try {
    fs.linkSync(tmp, out);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`${out} already exists; refusing to overwrite a backup`);
    // Some filesystems (FAT/exFAT, certain network and Docker Desktop mounts) cannot
    // make hard links. Fall back to an exclusive copy, which also refuses to replace.
    if (['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(err?.code)) {
      try {
        fs.copyFileSync(tmp, out, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (copyErr?.code === 'EEXIST') throw new Error(`${out} already exists; refusing to overwrite a backup`);
        fs.rmSync(out, { force: true }); // a copy this process started and could not finish
        throw copyErr;
      }
    } else {
      throw err;
    }
  }
  console.log(`backup ok: ${out} (${fs.statSync(out).size} bytes, schema v${version}, ${audits} saved audits, ${jobs} job records)`);
} catch (err) {
  const raw = String(err?.message || err);
  if (err?.code === 'EACCES' || err?.code === 'EROFS' || /readonly|read-only/i.test(raw)) {
    fail(`${path.dirname(out)} or the database is not writable by this user (${raw}). Run it as the user that runs the server, or pass a writable output path.`);
  }
  fail(raw);
}
cleanup();
