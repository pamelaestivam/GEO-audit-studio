/**
 * "Which commit is live?" (item G1.7 of docs/ENGINEERING_BACKLOG.md): scripts/smoke.mjs --expect-commit against a stand-in site
 * that serves /api/health with a chosen commit. Only the commit line is asserted (the rest of the smoke test fails against a stand-in).
 * No build, no network beyond localhost.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { commitVerdict } from '../scripts/commitCheck.mjs';
import { PortRange } from './ports.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

// ---- the pure rule
const A = 'a'.repeat(40), B = 'b'.repeat(40);
check('the same commit matches', commitVerdict(A, A).ok);
check('an abbreviated id matches the full one, either way round', commitVerdict(A.slice(0, 7), A).ok && commitVerdict(A, A.slice(0, 7)).ok);
check('upper case and spaces do not matter', commitVerdict(` ${A.toUpperCase()} `, A).ok);
const behind = commitVerdict(A, B);
check('a different commit is a failure that names both and says what to look at', !behind.ok && behind.sentence.includes('aaaaaaa') && behind.sentence.includes('bbbbbbb') && /Deployments/.test(behind.sentence), behind.sentence);
const none = commitVerdict(undefined, A);
check('a site that reports no commit is a failure, said as "could not be compared", never a match', !none.ok && /could not be compared/.test(none.sentence), none.sentence);
check('an expected value that is not a commit id is refused with a sentence', !commitVerdict(A, 'main').ok && /not a commit id/.test(commitVerdict(A, 'main').sentence));
check('a too-short id is refused (a 3-character prefix would match almost anything)', !commitVerdict(A, 'aaa').ok);
check('a REPORTED commit that is not a commit id never matches (one character, a number, an array, garbage after a sha)', ['a', 'ab', 'abc', 123, [A.slice(0, 7)], A + 'extra', true].every((r) => !commitVerdict(r as any, A).ok));
check('...and the sentence says the site reported something that is not a commit id', /not a commit id/.test(commitVerdict('a', A).sentence));
check('no expected commit at all says so in a sentence', /No expected commit/.test(commitVerdict(A, '').sentence) && /No expected commit/.test(commitVerdict(A, undefined).sentence));
check('the sentence for a different commit does not claim the site is behind (it cannot know the order)', /cannot tell which/.test(behind.sentence) && !/is not running the latest/.test(behind.sentence));

// ---- the script, as a real process, against a stand-in site
const ports = new PortRange(4600, 300);
function site(commit: string | undefined) {
  const port = ports.take();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', ...(commit ? { commit } : {}) })); return; }
    res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise<{ base: string; close: () => void }>((resolve) => server.listen(port, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })));
}
function smoke(base: string, extra: string[]) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn('node', ['scripts/smoke.mjs', base, ...extra], { env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' } });
    let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}
// The rest of smoke.mjs fails against a stand-in, so the exit code cannot show the commit check: compare the count of FAIL lines
// with and without the flag instead (the commit check must add exactly one, or none when it passes).
const failCount = (out: string) => out.split('\n').filter((l) => l.startsWith('FAIL')).length;
for (const [label, reported, expected, wantPass, sentence] of [
  ['the site runs the expected commit', A, A, true, /./],
  ['the site is behind main', A, B, false, /not the expected bbbbbbb/],
  ['the site reports no commit', undefined, A, false, /does not say which commit/],
  ['the site reports garbage as its commit', 'a', A, false, /not a commit id/],
  ['--expect-commit has no value', A, '', false, /No expected commit/],
] as const) {
  const s = await site(reported);
  const withFlag = await smoke(s.base, expected === '' ? ['--expect-commit'] : ['--expect-commit', expected]);
  const without = await smoke(s.base, []);
  s.close();
  const line = withFlag.out.split('\n').find((l) => l.includes('the live site runs the expected commit')) || '';
  check(`${label}: the commit line is ${wantPass ? 'pass' : 'FAIL'}`, line.startsWith(wantPass ? 'pass' : 'FAIL'), withFlag.out.slice(0, 600));
  check(`${label}: the flag adds ${wantPass ? 'no failure' : 'exactly one failure'} to the run`, failCount(withFlag.out) - failCount(without.out) === (wantPass ? 0 : 1), `${failCount(withFlag.out)} vs ${failCount(without.out)}`);
  if (!wantPass) check(`${label}: the failing line carries its own sentence`, sentence.test(withFlag.out), withFlag.out.slice(0, 600));
}
{
  const s = await site(A);
  const r = await smoke(s.base, []);
  s.close();
  check('without --expect-commit nothing is compared (no commit line at all)', !r.out.includes('the live site runs the expected commit'));
}

// ---- the workflow passes it
const wf = readFileSync('.github/workflows/live-check.yml', 'utf8');
check('live-check.yml passes --expect-commit to the smoke script', /--expect-commit "\$head"/.test(wf) && /smoke\.mjs "\$LIVE_URL"[^\n]*"\$\{expect\[@\]\}"/.test(wf));
check('...from the finished deployment (the env line is set from the event), else the head of main read from the remote', /DEPLOYED_SHA: \$\{\{ github\.event\.deployment\.sha \}\}/.test(wf) && /DEPLOYED_SHA:-\$\(git ls-remote origin refs\/heads\/main/.test(wf));
check('...and an unreadable head fails the check instead of skipping it (the flag is always passed)', /expect=\(--expect-commit "\$head"\)/.test(wf) && !/if \[ -n "\$head" \]/.test(wf));

console.log(failures === 0 ? '\nAll live-commit checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
