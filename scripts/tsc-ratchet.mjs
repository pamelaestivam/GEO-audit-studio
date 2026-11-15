#!/usr/bin/env node
// The compiler ratchet (item G2.4 of docs/ENGINEERING_BACKLOG.md). tsconfig.json is not strict, so the stricter flags are measured here: the
// number of errors each would give is stored in test/tsc-baseline.json and CI fails when a count rises, so the type quality only goes up.
//
//   node scripts/tsc-ratchet.mjs            measure and compare (exit 1 on a rise, and also when a count FELL and the file was not updated)
//   node scripts/tsc-ratchet.mjs --update   lower the stored counts to the measured ones (refuses to raise anything)
// Each flag set is a separate tsc run over everything tsconfig.json covers (tests included).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { countErrors, verdict, lowered } from './tsc-ratchet-lib.mjs';

const root = new URL('..', import.meta.url).pathname;
const FLAGS = ['strictNullChecks', 'noImplicitAny'];
const file = `${root}test/tsc-baseline.json`;
const baseline = JSON.parse(readFileSync(file, 'utf8')).counts;

const measured = {};
for (const f of FLAGS) {
  const r = spawnSync('npx', ['tsc', '--noEmit', `--${f}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error || (r.status !== 0 && countErrors(out) === 0)) { console.error(`tsc --${f} could not run: ${r.error?.message || out.slice(0, 300)}`); process.exit(2); }
  measured[f] = countErrors(out);
  console.log(`${f}: ${measured[f]} error(s) (baseline ${baseline[f] ?? 'none'})`);
}
if (process.argv.includes('--update')) {
  const next = lowered(measured, baseline);
  writeFileSync(file, `${JSON.stringify({ comment: 'Compiler errors each stricter flag would give over everything tsconfig.json covers. CI fails when a count rises; this file is lowered with: node scripts/tsc-ratchet.mjs --update', counts: next }, null, 2)}\n`);
  console.log('Baseline lowered where it improved:', JSON.stringify(next));
  process.exit(0);
}
const v = verdict(measured, baseline);
for (const p of v.problems) console.log(`FAIL  ${p}`);
for (const g of v.improved) console.log(`FAIL  ${g}`);
console.log(v.ok ? 'The compiler ratchet holds.' : 'The compiler ratchet failed.');
process.exit(v.ok ? 0 : 1);
