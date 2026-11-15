#!/usr/bin/env node
// The test runner (item G1.5 of docs/ENGINEERING_BACKLOG.md). `npm test` calls it. No dependency: Node only.
//
//   node scripts/run-tests.mjs                 every test: one build, then unit files in parallel, server files in a small pool,
//                                              browser and postgres files one at a time; a timing table at the end
//   node scripts/run-tests.mjs --tier unit,server   only those tiers (unit | server | browser | postgres)
//   node scripts/run-tests.mjs --changed [base]     only tests that touch what the diff touches (see below; a fast check, never a
//                                              substitute for the full run, which CI does)
//   node scripts/run-tests.mjs --shard 1/2     every 2nd file of the selection, starting at the 1st (CI splits the server tier this way)
//   node scripts/run-tests.mjs --list          print the selection and exit
//   node scripts/run-tests.mjs --no-build      do not build first (dist/ must be current)
//   node scripts/run-tests.mjs --jobs N        parallel unit files (default: CPU count, at most 8)
//   node scripts/run-tests.mjs test/auth.test.ts ...   exactly these files
//
// What it guarantees: it builds ONCE before anything (two builds in one checkout collide on dist/, docs/INSIGHTS.md I-17); it keeps
// going after a failure and exits non-zero at the end; a test file that prints a FAIL line but exits 0 counts as failed (the
// early-exit trap, I-31); a file that prints SKIP ... NOT RUN is shown as skipped, never as passed. The server tests draw their
// ports at random through test/ports.ts, so the server pool stays small (2) to keep a collision rare (I-53).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { selectChanged } from './run-tests-lib.mjs';

const root = process.env.RUN_TESTS_ROOT ? `${process.env.RUN_TESTS_ROOT.replace(/\/$/, '')}/` : new URL('..', import.meta.url).pathname; // RUN_TESTS_ROOT: for the runner's own test
const manifest = JSON.parse(readFileSync(`${root}test/manifest.json`, 'utf8')).tests;
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') && !args[i + 1].startsWith('test/') ? args[i + 1] : undefined; };
const files = args.filter((a) => a.startsWith('test/'));
const TIERS = ['unit', 'server', 'browser', 'postgres'];
const POOL = { unit: Math.max(1, Math.min(Number(opt('jobs')) || os.cpus().length, 8)), server: 2, browser: 1, postgres: 1 };

// ---- selection
let selected = manifest;
if (flag('tier') && !opt('tier')) { console.error(`--tier needs a value: one or more of ${TIERS.join(', ')}, comma-separated.`); process.exit(2); }
if (opt('tier')) {
  const want = opt('tier').split(',');
  const bad = want.filter((t) => !TIERS.includes(t));
  if (bad.length) { console.error(`Unknown tier ${bad.join(', ')}; the tiers are ${TIERS.join(', ')}.`); process.exit(2); }
  selected = selected.filter((t) => want.includes(t.tier));
}
if (files.length) {
  const unknown = files.filter((f) => !manifest.some((t) => t.file === f));
  if (unknown.length) { console.error(`Not in test/manifest.json: ${unknown.join(', ')}. Add it there first.`); process.exit(2); }
  selected = manifest.filter((t) => files.includes(t.file));
}
if (flag('changed')) {
  const base = opt('changed') || 'origin/main';
  const sh = (c) => { const r = spawnSync('git', c, { cwd: root, encoding: 'utf8' }); if (r.status !== 0) { console.error(`--changed could not ask git (git ${c.join(' ')}): ${(r.stderr || r.error?.message || 'unknown error').trim()}\nGive a base that exists (for example origin/main; a shallow clone may need: git fetch --unshallow origin), or run without --changed.`); process.exit(2); } return r; };
  const names = new Set([
    ...sh(['diff', '--name-only', `${base}...HEAD`]).stdout.split('\n'),
    ...sh(['diff', '--name-only']).stdout.split('\n'),
    ...sh(['diff', '--name-only', '--cached']).stdout.split('\n'),
    ...sh(['ls-files', '--others', '--exclude-standard']).stdout.split('\n'),
  ].filter(Boolean));
  selected = selectChanged(selected, [...names], root);
  console.log(`--changed against ${base}: ${names.size} changed path(s) -> ${selected.length} test file(s). (An approximation: CI runs everything.)`);
}

if (flag('shard')) {
  const m = /^(\d+)\/(\d+)$/.exec(opt('shard') || '');
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) { console.error('--shard needs i/n with 1 <= i <= n, for example --shard 1/2.'); process.exit(2); }
  selected = selected.filter((_, i) => i % Number(m[2]) === Number(m[1]) - 1);
}
if (flag('list')) { for (const t of selected) console.log(`${t.tier.padEnd(8)} ${t.file}`); console.log(`${selected.length} file(s)`); process.exit(0); }
if (selected.length === 0) { console.log('No test file selected.'); process.exit(0); }

// ---- build once
const t0 = Date.now();
if (!flag('no-build') && selected.some((t) => t.needsBuild)) {
  console.log('Building once before any test ...');
  const b = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) { console.error('The build failed, so no test was run.'); process.exit(1); }
} else if (selected.some((t) => t.needsBuild) && !existsSync(`${root}dist/server.cjs`)) {
  console.error('--no-build was given but dist/server.cjs does not exist.'); process.exit(1);
}

// ---- run
function runOne(t) {
  return new Promise((resolve) => {
    const started = Date.now();
    const cmd = t.runner === 'bash' ? ['bash', [t.file]] : ['npx', ['tsx', t.file]];
    const child = spawn(cmd[0], cmd[1], { cwd: root, env: { ...process.env, ...(t.env || {}) }, detached: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    const limit = Number(process.env.RUN_TESTS_TIMEOUT_MS) || 600_000;
    const timer = setTimeout(() => { out += `\nFAIL  the runner stopped this file after ${Math.round(limit / 1000)} seconds\n`; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, limit); // the whole process group: a hung server the test started must not keep the pipes open
    child.on('error', (e) => { clearTimeout(timer); resolve({ ...t, ms: Date.now() - started, code: -1, checks: 0, failLines: 1, skipped: false, failed: true, out: `FAIL  could not start ${cmd[0]}: ${e.message}\n` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const checks = (out.match(/^pass\b/gm) || []).length;
      const failLines = (out.match(/^FAIL\b/gm) || []).length;
      const skipped = /SKIP[^\n]*NOT RUN|^skip\b/m.test(out) && checks === 0;
      const failed = code !== 0 || failLines > 0 || (skipped && !!process.env.CI); // in CI a skipped file is a failure (a missing database must not pass)
      resolve({ ...t, ms: Date.now() - started, code, checks, failLines, skipped, failed, out });
    });
  });
}
async function pool(items, size) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const t = items[next++];
      const r = await runOne(t);
      results.push(r);
      console.log(`${r.failed ? 'FAIL' : r.skipped ? 'SKIP' : 'ok  '}  ${t.tier.padEnd(8)} ${t.file}  ${(r.ms / 1000).toFixed(1)}s${r.checks ? `  ${r.checks} checks` : ''}`);
    }
  }));
  return results;
}
const results = [];
for (const tier of TIERS) {
  const items = selected.filter((t) => t.tier === tier);
  if (items.length) { console.log(`\n== ${tier}: ${items.length} file(s), ${POOL[tier]} at a time`); results.push(...await pool(items, POOL[tier])); }
}

// ---- report
const failed = results.filter((r) => r.failed);
for (const r of failed) { console.log(`\n===== ${r.file} (exit ${r.code}, ${r.failLines} FAIL line(s)) =====`); console.log(r.out.split('\n').slice(-80).join('\n')); }
const table = [...results].sort((a, b) => b.ms - a.ms).map((r) => `| ${r.file} | ${r.tier} | ${(r.ms / 1000).toFixed(1)} s | ${r.checks} | ${r.failed ? 'FAILED' : r.skipped ? 'skipped (not run)' : 'ok'} |`);
const total = results.reduce((n, r) => n + r.checks, 0);
const summary = `\n| File (slowest first) | Tier | Time | Checks | Result |\n|---|---|---|---|---|\n${table.join('\n')}\n\n${results.length} file(s), ${total} checks, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped, ${((Date.now() - t0) / 1000).toFixed(0)} s in all.\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Test run\n${summary}`); } catch { /* the summary is a convenience */ } }
process.exit(failed.length === 0 ? 0 : 1);
