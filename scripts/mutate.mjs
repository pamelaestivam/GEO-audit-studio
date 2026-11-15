#!/usr/bin/env node
// The protections ledger runner (G2.8). For each row of test/protections.json: copy the repository to a temporary directory, apply the one
// change there, run ONLY the named test files there, and report. It never touches this repository (it works in the copy and removes it).
//
//   node scripts/mutate.mjs                 every row
//   node scripts/mutate.mjs paid-engines-off   one row by id
//   node scripts/mutate.mjs --list
//
// Results per row: DEFENDED (a named test failed when the guarantee was broken), UNDEFENDED (every named test still passed: the guarantee has no
// defender), STALE (the find text is not in the file any more: the ledger needs a new row), ERROR (the copy or the test could not run).
// Exit 1 when any row is not DEFENDED. No dependency; node_modules is linked into the copy, not copied.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = process.env.MUTATE_ROOT || new URL('..', import.meta.url).pathname;
const ledger = JSON.parse(readFileSync(path.join(process.env.MUTATE_LEDGER || `${root}/test/protections.json`), 'utf8')).protections;
const args = process.argv.slice(2);
if (args.includes('--list')) { for (const p of ledger) console.log(`${p.id.padEnd(24)} ${p.file}  ->  ${p.tests.join(', ')}`); process.exit(0); }
const only = args.filter((a) => !a.startsWith('--'));
const rows = only.length ? ledger.filter((p) => only.includes(p.id)) : ledger;
if (only.length && rows.length !== only.length) { console.error(`Unknown id: ${only.filter((i) => !ledger.some((p) => p.id === i)).join(', ')}`); process.exit(2); }

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function copyRepo() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mutate-'));
  cpSync(root, tmp, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  if (existsSync(path.join(root, 'node_modules'))) symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  return tmp;
}
function runTest(dir, file) {
  const cmd = file.endsWith('.sh') ? ['bash', [file]] : ['npx', ['tsx', file]];
  const r = spawnSync(cmd[0], cmd[1], { cwd: dir, encoding: 'utf8', timeout: 300_000, env: { ...process.env, CI: '' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { failed: r.status !== 0 || /^FAIL\b/m.test(out), status: r.status, out };
}

let bad = 0;
for (const p of rows) {
  const dir = copyRepo();
  try {
    const target = path.join(dir, p.file);
    const text = readFileSync(target, 'utf8');
    if (!text.includes(p.find)) { console.log(`STALE       ${p.id}: the text to break is no longer in ${p.file}; update the row`); bad++; continue; }
    // the unbroken copy must pass first, or "a test failed" proves nothing
    const clean = p.tests.map((t) => runTest(dir, t));
    if (clean.some((c) => c.failed)) { console.log(`ERROR       ${p.id}: a named test already fails on the unmodified copy (${p.tests.join(', ')}); fix that first`); bad++; continue; }
    writeFileSync(target, text.replace(p.find, p.replace));
    const results = p.tests.map((t) => ({ t, ...runTest(dir, t) }));
    const caught = results.filter((r) => r.failed).map((r) => r.t);
    if (caught.length) console.log(`DEFENDED    ${p.id}: breaking "${p.guarantee}" fails ${caught.join(', ')}`);
    else { console.log(`UNDEFENDED  ${p.id}: breaking "${p.guarantee}" fails NO test (${p.tests.join(', ')} still pass)`); bad++; }
  } catch (e) { console.log(`ERROR       ${p.id}: ${e.message}`); bad++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${rows.length} guarantee(s): ${rows.length - bad} defended, ${bad} not.`);
process.exit(bad === 0 ? 0 : 1);
