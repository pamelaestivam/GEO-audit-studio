/**
 * CI in parallel under the same required name (item G1.6 of docs/ENGINEERING_BACKLOG.md): the workflow is read as text (there is no
 * YAML library here, and none is wanted). What must stay true: the last job is named `test`, needs every other job, and runs even when
 * one failed (so a failure cannot leave it skipped); every test tier is run by some job; the server tier is split into shards that
 * cover each other; the PostgreSQL job requires its database; every job has a time limit.
 */
import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean, detail = '') { if (!ok) failures++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`); }

// comments are removed before any match (a commented-out `if: always()` must not count)
const wf = readFileSync('.github/workflows/ci.yml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');
const jobsText = wf.slice(wf.indexOf('\njobs:') + 6);
// job id -> its text (a job starts at two-space indent `id:`)
const jobs: Record<string, string> = {};
const re = /^  ([a-z][a-z0-9_-]*):\n/gm; let m: RegExpExecArray | null; const starts: Array<[string, number]> = [];
while ((m = re.exec(jobsText))) starts.push([m[1], m.index]);
starts.forEach(([id, at], i) => { jobs[id] = jobsText.slice(at, i + 1 < starts.length ? starts[i + 1][1] : undefined); });
const ids = Object.keys(jobs);
const others = ids.filter((i) => i !== 'test');

check('the workflow has the gate job `test` and other jobs', ids.includes('test') && others.length >= 4, ids.join());
check('the gate job is named exactly `test` (the name the repository\'s rules wait for)', /name: test\n/.test(jobs.test));
check('...needs every other job', others.every((j) => new RegExp(`needs:\\s*\\[[^\\]]*\\b${j}\\b`).test(jobs.test)), others.join());
check('...runs even when another job failed or was cancelled (a skipped gate can read as passing)', /^    if: always\(\)$/m.test(jobs.test));
check('...and exits 1 unless every result is "success"', /if \[ "\$r" != "success" \]; then[^\n]*exit 1; fi/.test(jobs.test) && others.every((j) => jobs.test.includes(`needs.${j}.result`)));
check('no job may carry continue-on-error (it would turn a failure into "success")', !/continue-on-error/.test(wf));
check('no other job has a job-level `if:` (a skipped job is not a green one)', others.every((j) => !/^    if:/m.test(jobs[j])));
check('every other job has a time limit', others.every((j) => /timeout-minutes:/.test(jobs[j])));
const manifest = JSON.parse(readFileSync('test/manifest.json', 'utf8')).tests as Array<{ tier: string }>;
const tiers = [...new Set(manifest.map((t) => t.tier))];
check('every test tier in the manifest is run by some job', tiers.every((t) => others.some((j) => new RegExp(`^\\s+- run: node scripts/run-tests\\.mjs --tier ${t}\\b`, 'm').test(jobs[j]))), tiers.join());
check('the server tier is run as two shards that cover each other (1/2 and 2/2 through a matrix)', /--tier server --shard \$\{\{ matrix\.shard \}\}\/2/.test(wf) && /shard: \[1, 2\]/.test(wf));
check('the PostgreSQL job requires its database and the browser job installs Chromium', /REQUIRE_POSTGRES: '1'/.test(jobs.postgres || '') && /playwright install --with-deps chromium/.test(jobs.browser || ''));
check('the unit job has the symlink guard, the audit and the type check', /git ls-files -s/.test(jobs.unit) && /npm audit --omit=dev/.test(jobs.unit) && /npm run lint/.test(jobs.unit));
check('the production install check still runs, after a build', /npm run build/.test(jobs.install || '') && /prod-install-check\.sh/.test(jobs.install || ''));
check('every job that runs tests sets CI (a skipped test file fails there)', others.filter((j) => /run-tests\.mjs/.test(jobs[j])).every((j) => /CI: 'true'/.test(jobs[j])));
check('the shared setup is a local action that exists, and every job uses it', existsSync('.github/actions/setup/action.yml') && others.every((j) => /uses: \.\/\.github\/actions\/setup/.test(jobs[j])));
check('third-party actions are pinned to a commit (no tag-only uses)', [...wf.matchAll(/uses: ([^\s]+)/g)].map((x) => x[1]).filter((u) => !u.startsWith('./')).every((u) => /@[0-9a-f]{40}$/.test(u)));

console.log(failures === 0 ? '\nAll CI workflow checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
