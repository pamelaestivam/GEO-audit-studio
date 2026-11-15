/**
 * The protections ledger runner (G2.8): scripts/mutate.mjs as a real process against a tiny fixture repository, never this one. A guarantee whose
 * test catches the break is DEFENDED; one whose test still passes is UNDEFENDED; a change that no longer applies is STALE; a test that already
 * fails on the unbroken copy is an ERROR; the fixture itself is never modified; the real ledger is well formed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

let failures = 0;
function check(name: string, ok: boolean, detail = '') { if (!ok) failures++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`); }

const d = mkdtempSync(`${os.tmpdir()}/mut-fixture-`); mkdirSync(`${d}/src`); mkdirSync(`${d}/test`);
writeFileSync(`${d}/src/a.ts`, 'export const guarded = true;\nexport const other = 1;\n');
writeFileSync(`${d}/test/guards-a.test.sh`, '#!/usr/bin/env bash\ngrep -q "guarded = true" src/a.ts && echo "pass  a is guarded" || { echo "FAIL  a is not guarded"; exit 1; }\n');
writeFileSync(`${d}/test/blind.test.sh`, '#!/usr/bin/env bash\necho "pass  looks at nothing that matters"\n');
writeFileSync(`${d}/test/dies.test.sh`, '#!/usr/bin/env bash\ngrep -q "guarded = true" src/a.ts && echo "pass  fine" || exit 3\n');
writeFileSync(`${d}/test/already-red.test.sh`, '#!/usr/bin/env bash\necho "FAIL  red already"; exit 1\n');
const ledger = { protections: [
  { id: 'defended', guarantee: 'a is guarded', file: 'src/a.ts', find: 'guarded = true', replace: 'guarded = false', tests: ['test/guards-a.test.sh'] },
  { id: 'undefended', guarantee: 'other is one', file: 'src/a.ts', find: 'other = 1', replace: 'other = 2', tests: ['test/blind.test.sh'] },
  { id: 'stale', guarantee: 'gone', file: 'src/a.ts', find: 'this text is not in the file', replace: 'x', tests: ['test/blind.test.sh'] },
  { id: 'dies-without-a-failed-check', guarantee: 'a', file: 'src/a.ts', find: 'guarded = true', replace: 'guarded = false', tests: ['test/dies.test.sh'] },
  { id: 'escapes', guarantee: 'x', file: '../../etc/x', find: 'a', replace: 'b', tests: ['test/blind.test.sh'] },
  { id: 'red-already', guarantee: 'a', file: 'src/a.ts', find: 'guarded = true', replace: 'guarded = false', tests: ['test/already-red.test.sh'] },
] };
writeFileSync(`${d}/ledger.json`, JSON.stringify(ledger));
const run = (extra: string[] = []) => { const r = spawnSync('node', [`${process.cwd()}/scripts/mutate.mjs`, ...extra], { env: { ...process.env, MUTATE_ROOT: d, MUTATE_LEDGER: `${d}/ledger.json` }, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };

const tmpBefore = readdirSync(os.tmpdir()).filter((f) => f.startsWith('mutate-')).length;
const all = run();
check('a guarantee whose test fails when it is broken is DEFENDED, and the line names the test', /DEFENDED +defended:.*test\/guards-a\.test\.sh/.test(all.out), all.out);
check('one whose test still passes is UNDEFENDED', /UNDEFENDED +undefended:/.test(all.out));
check('a change that no longer applies is STALE', /STALE +stale:/.test(all.out));
check('a test that already fails on the unbroken copy is an ERROR, not a pass for the guarantee', /ERROR +red-already:/.test(all.out));
check('a test that dies WITHOUT printing a failed check (a syntax error, a crash) is INCONCLUSIVE, never DEFENDED', /INCONCLUSIVE +dies-without-a-failed-check:/.test(all.out) && !/DEFENDED +dies-without/.test(all.out), all.out);
check('a row that names a path outside the repository is refused, nothing written there', /ERROR +escapes: "..\/..\/etc\/x" is not a path inside/.test(all.out));
check('the run exits 1 when any row is not defended, and says how many', all.code === 1 && /6 guarantee\(s\): 1 defended, 5 not\./.test(all.out), all.out.slice(-200));
check('no temporary copy is left behind', readdirSync(os.tmpdir()).filter((f) => f.startsWith('mutate-')).length === tmpBefore);
check('the fixture itself is never modified (the break was made in a copy)', readFileSync(`${d}/src/a.ts`, 'utf8') === 'export const guarded = true;\nexport const other = 1;\n');
const one = run(['defended']);
check('one id runs one row and exits 0 when it is defended', one.code === 0 && /1 guarantee\(s\): 1 defended, 0 not\./.test(one.out));
check('an unknown id is refused', run(['nope']).code === 2);
check('--list prints the rows and runs nothing', /defended +src\/a\.ts/.test(run(['--list']).out) && !/DEFENDED/.test(run(['--list']).out));

// the real ledger
const real = JSON.parse(readFileSync('test/protections.json', 'utf8')).protections as Array<any>;
check('the real ledger has unique ids and every row has a guarantee, a file that exists, a find text that is in it, and tests that exist', new Set(real.map((p) => p.id)).size === real.length && real.length >= 6 && real.every((p) => p.guarantee && existsSync(p.file) && readFileSync(p.file, 'utf8').includes(p.find) && p.find !== p.replace && p.tests.every((t: string) => existsSync(t))), 'a row is stale or malformed');

console.log(failures === 0 ? '\nAll protections-ledger checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
