/**
 * The test manifest and the runner (item G1.5 of docs/ENGINEERING_BACKLOG.md): the manifest lists every test file; the runner, as a real
 * process against fake tests, keeps going after a failure, counts a FAIL line with exit 0 as a failure, shows a skip as a skip and never
 * a pass, honours --tier and explicit files, builds only when something needs it; --changed maps a diff to tests; CLAUDE.md's list is current.
 */
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { selectChanged } from '../scripts/run-tests-lib.mjs';
import { testList } from '../scripts/gen-test-list.mjs';

let failures = 0;
function check(name: string, ok: boolean, detail = '') { if (!ok) failures++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`); }

// ---- the manifest is complete and well formed
const manifest = JSON.parse(readFileSync('test/manifest.json', 'utf8')).tests as any[];
const onDisk = readdirSync('test').filter((f) => /\.test\.(ts|sh)$/.test(f)).map((f) => `test/${f}`).sort();
const listed = manifest.map((t) => t.file).sort();
check('every test file on disk is in the manifest', onDisk.every((f) => listed.includes(f)), onDisk.filter((f) => !listed.includes(f)).join(', '));
check('...and every manifest entry exists, once', listed.every((f) => onDisk.includes(f)) && new Set(listed).size === listed.length, listed.filter((f) => !onDisk.includes(f)).join(', '));
check('...each with a tier, a runner and a summary', manifest.every((t) => ['unit', 'server', 'browser', 'postgres'].includes(t.tier) && ['tsx', 'bash'].includes(t.runner) && typeof t.needsBuild === 'boolean' && t.what.length > 5));
check('npm test is the runner', JSON.parse(readFileSync('package.json', 'utf8')).scripts.test === 'node scripts/run-tests.mjs');
const claude = readFileSync('CLAUDE.md', 'utf8');
check('the list in CLAUDE.md is the one generated from the manifest', claude.includes(`<!-- tests:start -->\n${testList()}\n<!-- tests:end -->`), 'run: node scripts/gen-test-list.mjs --write');

// ---- --changed
const sample = [
  { file: 'test/a.test.ts', tier: 'unit' }, { file: 'test/b.test.ts', tier: 'server' },
];
const dir0 = mkdtempSync(`${os.tmpdir()}/sel-`);
const picked = (changed: string[]) => selectChanged(manifest, changed).map((t: any) => t.file);
check('--changed: a changed test file selects itself', picked(['test/auth.test.ts']).join() === 'test/auth.test.ts');
check('--changed: a changed src module selects the tests that import it', picked(['src/rateLimit.ts']).includes('test/rateLimit.test.ts'));
check('--changed: the server, config or the runner select everything', picked(['server.ts']).length === manifest.length && picked(['package.json']).length === manifest.length && picked(['scripts/run-tests.mjs']).length === manifest.length);
check('--changed: a docs-only change selects nothing', picked(['docs/PROGRAM.md']).length === 0);
void sample; void dir0;

// ---- the runner against fake tests, as a real process
function fakeRoot(tests: Record<string, { tier: string; body: string }>) {
  const d = mkdtempSync(`${os.tmpdir()}/runner-`); mkdirSync(`${d}/test`);
  const entries = Object.entries(tests).map(([name, t]) => { writeFileSync(`${d}/test/${name}`, `#!/usr/bin/env bash\n${t.body}\n`); return { file: `test/${name}`, runner: 'bash', tier: t.tier, needsBuild: false, what: 'fake test' }; });
  writeFileSync(`${d}/test/manifest.json`, JSON.stringify({ tests: entries }));
  return d;
}
function run(d: string, extra: string[] = []) {
  const r = spawnSync('node', [`${process.cwd()}/scripts/run-tests.mjs`, ...extra], { env: { ...process.env, RUN_TESTS_ROOT: d, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const fake = fakeRoot({
  'good.test.sh': { tier: 'unit', body: 'echo "pass  one"; echo "pass  two"' },
  'bad.test.sh': { tier: 'unit', body: 'echo "pass  x"; echo "boom"; exit 1' },
  'quiet-fail.test.sh': { tier: 'unit', body: 'echo "FAIL  a check failed"; exit 0' },
  'skip.test.sh': { tier: 'server', body: 'echo "SKIP ... NOT RUN: no database"' },
  'last.test.sh': { tier: 'server', body: 'echo "pass  after the failures"' },
});
const all = run(fake);
check('the runner exits 1 when any file failed', all.code === 1, all.out.slice(-400));
check('...and keeps going: a file after the failures still ran', /last\.test\.sh[^\n]*1 checks/.test(all.out));
check('a file that prints FAIL but exits 0 is counted as failed (the early-exit trap)', /FAIL +unit +test\/quiet-fail\.test\.sh/.test(all.out));
check('a skipped file is shown as skipped, never as ok', /SKIP +server +test\/skip\.test\.sh/.test(all.out) && /skipped \(not run\)/.test(all.out));
check('the failing file\'s output is printed', /boom/.test(all.out));
check('the timing table and the total check count are printed (4 checks: 2 + 1 + 1)', /File \(slowest first\)/.test(all.out) && /5 file\(s\), 4 checks, 2 failed, 1 skipped/.test(all.out), all.out.slice(-300));
const onlyServer = run(fake, ['--tier', 'server']);
check('--tier selects only that tier', onlyServer.code === 0 && !/good\.test\.sh/.test(onlyServer.out) && /last\.test\.sh/.test(onlyServer.out));
check('an unknown tier is refused with a sentence', run(fake, ['--tier', 'fast']).code === 2);
const one = run(fake, ['test/good.test.sh']);
check('naming a file runs exactly that file', one.code === 0 && /2 checks/.test(one.out) && !/bad\.test\.sh/.test(one.out));
check('naming a file that is not in the manifest is refused', run(fake, ['test/nope.test.sh']).code === 2);
check('--list prints the selection and runs nothing', /unit +test\/good\.test\.sh/.test(run(fake, ['--list']).out) && !/pass/.test(run(fake, ['--list']).out));
const green = run(fakeRoot({ 'ok.test.sh': { tier: 'unit', body: 'echo "pass  fine"' } }));
check('an all-green run exits 0 and does not build when nothing needs it', green.code === 0 && !/Building once/.test(green.out));

console.log(failures === 0 ? '\nAll manifest and runner checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
