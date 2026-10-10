/**
 * scripts/backup.mjs makes a restorable copy of a database that a server still
 * has open in WAL mode - and a plain file copy of the same database does not.
 * Run: npx tsx test/backup.test.ts
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/store';

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

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-backup-'));
  // The "server": a store left OPEN, with a finished audit in it.
  const store = new SqliteStore(DatabaseSync as any, path.join(dir, 'geo-audit.sqlite'));
  await store.saveAudit('anna|a@x.com', { id: 'audit-1', createdAt: new Date().toISOString(), businessName: 'Acme', geoVisibilityScore: 50, shareOfVoice: 50, leaderShare: 0, queriesTested: [] });

  // The obvious backup: copy the .sqlite file. It restores no audit.
  const naive = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-naive-'));
  fs.copyFileSync(path.join(dir, 'geo-audit.sqlite'), path.join(naive, 'geo-audit.sqlite'));
  const naiveDb = new DatabaseSync(path.join(naive, 'geo-audit.sqlite'));
  const naiveRows = (() => {
    try {
      return (naiveDb.prepare('SELECT COUNT(*) AS n FROM audits').get() as any).n;
    } catch {
      return 0; // schema itself still in the WAL
    }
  })();
  naiveDb.close();
  check('copying only geo-audit.sqlite of a running database loses the audit (why the script exists)', naiveRows, 0);

  const out = path.join(dir, 'backups', 'b.sqlite');
  const run = spawnSync('node', ['scripts/backup.mjs', dir, out], { encoding: 'utf8' });
  check('the script exits 0', run.status, 0);
  check('it reports the audit count', /1 saved audits/.test(run.stdout), true);

  const restored = new SqliteStore(DatabaseSync as any, out);
  check('the restored database has the audit', (await restored.listAudits('anna|a@x.com')).map((a) => a.id), ['audit-1']);
  check('...and its report', (await restored.getAudit('anna|a@x.com', 'audit-1'))?.businessName, 'Acme');
  restored.close();

  const sizeBefore = fs.statSync(out).size;
  const again = spawnSync('node', ['scripts/backup.mjs', dir, out], { encoding: 'utf8' });
  check('it refuses to overwrite an existing backup', [again.status, /already exists/.test(again.stderr)], [1, true]);
  const survivor = new SqliteStore(DatabaseSync as any, out);
  check('...and the existing backup survives the refused run, intact (it used to be deleted by the failed run)', [fs.statSync(out).size === sizeBefore, (await survivor.listAudits('anna|a@x.com')).length], [true, 1]);
  survivor.close();
  const leftovers = () => fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.includes('.tmp-'));
  check('no temporary file is left after a REFUSED run either (a failed run used to leave a full copy of the database)', leftovers(), []);

  // Backups racing for the same name: exactly one wins per trial, its file is there,
  // and the losers leave nothing behind (they used to leak a full copy each).
  let winnersOk = true;
  let leaked: string[] = [];
  for (let trial = 0; trial < 8; trial++) {
    const race = path.join(dir, 'backups', `race-${trial}.sqlite`);
    const racers = await Promise.all([1, 2, 3].map(() => new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const c = spawn('node', ['scripts/backup.mjs', dir, race]);
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', (status) => resolve({ status, stdout }));
    })));
    if (racers.filter((r) => r.status === 0 && /backup ok/.test(r.stdout)).length !== 1 || !fs.existsSync(race)) winnersOk = false;
    leaked = leaked.concat(leftovers());
  }
  check('racing runs: exactly one reports success each time, and its file exists', winnersOk, true);
  check('no temporary file is left after racing runs', leaked, []);

  // A filesystem without hard links: the script still makes the backup, exclusively.
  const noLink = path.join(dir, 'preload-nolink.cjs');
  fs.writeFileSync(noLink, "const fs = require('fs'); fs.linkSync = () => { const e = new Error('EPERM: operation not permitted, link'); e.code = 'EPERM'; throw e; };");
  const viaCopy = path.join(dir, 'backups', 'via-copy.sqlite');
  const copyRun = spawnSync('node', ['--require', noLink, 'scripts/backup.mjs', dir, viaCopy], { encoding: 'utf8' });
  check('without hard-link support the backup is still made (exclusive copy)', [copyRun.status, fs.existsSync(viaCopy)], [0, true]);
  // A racing run that passed the up-front existence check: make that check lie, so
  // the exclusive copy itself has to refuse to replace the file.
  const lie = path.join(dir, 'preload-lie.cjs');
  fs.writeFileSync(lie, "const fs = require('fs'); const real = fs.existsSync; fs.existsSync = (p) => (String(p) === process.env.LIE_OUT ? false : real(p));");
  const before = fs.readFileSync(viaCopy);
  const copyAgain = spawnSync('node', ['--require', noLink, '--require', lie, 'scripts/backup.mjs', dir, viaCopy], { encoding: 'utf8', env: { ...process.env, LIE_OUT: viaCopy } });
  check('...and the exclusive copy refuses to overwrite, leaving the file untouched and no temporary file', [copyAgain.status, /already exists/.test(copyAgain.stderr), fs.readFileSync(viaCopy).equals(before), leftovers()], [1, true, true, []]);

  // A path with quotes, spaces and a semicolon is just a path.
  const odd = path.join(dir, "o'; DROP TABLE audits; -- x.sqlite");
  const oddRun = spawnSync('node', ['scripts/backup.mjs', dir, odd], { encoding: 'utf8' });
  check('a quote/semicolon/space in the output path is only a path', [oddRun.status, fs.existsSync(odd)], [0, true]);
  // `file:` is a SQLite URI prefix: it must stay a file NAME, not redirect the write elsewhere.
  const uriDir = path.join(dir, 'uri-cwd');
  fs.mkdirSync(uriDir);
  const uriRun = spawnSync('node', [path.resolve('scripts/backup.mjs'), dir, 'file:uri-name.sqlite'], { encoding: 'utf8', cwd: uriDir });
  check('an output name starting with "file:" is a file name: written there, nothing stray elsewhere', [uriRun.status, fs.existsSync(path.join(uriDir, 'file:uri-name.sqlite')), fs.readdirSync(uriDir).filter((f) => f.includes('.tmp-')), fs.readdirSync(dir).filter((f) => f.includes('uri-name'))], [0, true, [], []]);
  const missing = spawnSync('node', ['scripts/backup.mjs', path.join(dir, 'nope'), path.join(dir, 'x.sqlite')], { encoding: 'utf8' });
  check('a wrong DATA_DIR is a sentence, not a stack trace', [missing.status, /no database at/.test(missing.stderr), /\n\s+at /.test(missing.stderr)], [1, true, false]);
  fs.writeFileSync(path.join(dir, 'a-file'), 'x');
  const underFile = spawnSync('node', ['scripts/backup.mjs', dir, path.join(dir, 'a-file', 'x.sqlite')], { encoding: 'utf8' });
  check('an unusable output location is a sentence with a next step, not a stack trace', [underFile.status, /^backup failed: /.test(underFile.stderr), /\n\s+at /.test(underFile.stderr)], [1, true, false]);

  store.close();
  console.log(failures === 0 ? '\nBackup checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
