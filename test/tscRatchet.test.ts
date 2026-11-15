/**
 * The compiler ratchet (G2.4, first step): the pure rules, plus the real script as a process against this repository (the stored baseline must
 * match what the compiler says today, or CI would be red for the wrong reason).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { countErrors, verdict, lowered } from '../scripts/tsc-ratchet-lib.mjs';

let failures = 0;
function check(name: string, ok: boolean, detail = '') { if (!ok) failures++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`); }

check('errors are counted from tsc output lines', countErrors("a.ts(1,2): error TS2322: x\nb.ts(3,4): error TS7006: y\nFound 2 errors.") === 2 && countErrors('') === 0 && countErrors('Found 0 errors') === 0);
check('a count above the baseline fails and says by how much', (() => { const v = verdict({ a: 12 }, { a: 10 }); return !v.ok && /up from the baseline of 10/.test(v.problems[0]) && /added 2/.test(v.problems[0]); })());
check('a count equal to the baseline holds', verdict({ a: 10 }, { a: 10 }).ok);
check('a count BELOW the baseline is flagged until the file is lowered (the gain must be written down)', (() => { const v = verdict({ a: 8 }, { a: 10 }); return !v.ok && v.improved.length === 1 && /--update/.test(v.improved[0]); })());
check('a flag with no stored baseline fails, and so does a stored one that is not measured', !verdict({ b: 1 }, {}).ok && !verdict({}, { a: 1 }).ok);
check('--update never raises a count and starts a new flag at its measured value', (() => { const n = lowered({ a: 12, b: 5, c: 3 }, { a: 10, b: 9 }); return n.a === 10 && n.b === 5 && n.c === 3; })());

const stored = JSON.parse(readFileSync('test/tsc-baseline.json', 'utf8')).counts as Record<string, number>;
check('the stored baseline names both flags with whole numbers', ['strictNullChecks', 'noImplicitAny'].every((f) => Number.isInteger(stored[f]) && stored[f] >= 0));
const r = spawnSync('node', ['scripts/tsc-ratchet.mjs'], { encoding: 'utf8' });
check('the real compiler, run through the script, matches the stored baseline exactly (exit 0)', r.status === 0, `${r.stdout}${r.stderr}`.slice(-400));

console.log(failures === 0 ? '\nAll compiler-ratchet checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
