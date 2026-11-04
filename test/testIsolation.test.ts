/**
 * A guard on the tests themselves: a test that starts the built server must not pick up the developer's DATABASE_URL.
 * `openStore` prefers DATABASE_URL to DATA_DIR, so a suite run in a shell that has the real address exported would
 * write test audits into the real database, and the SQLite durability suites would silently test PostgreSQL. Found by
 * the independent review of the PostgreSQL store: 17 suites spread `process.env` into the server's environment.
 *
 * Source scan, as test/testHarness.test.ts is: every test file that starts `dist/server.cjs` must spread TEST_AUTH_ENV
 * (which blanks DATABASE_URL) or set DATABASE_URL itself, and TEST_AUTH_ENV must keep blanking it. Checked against
 * fixtures of each shape so the guard itself can fail. Run: npx tsx test/testIsolation.test.ts
 */
import fs from 'fs';
import path from 'path';

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

/**
 * Does this source start the server, in a child process or in its own, without isolating it from DATABASE_URL?
 *  - a child process (spawn/exec/fork of the built bundle, in any spelling that names server.cjs) must spread TEST_AUTH_ENV
 *    into the child's environment (mentioning the word DATABASE_URL, even in a comment, is not enough);
 *  - an import of ../server or ../api builds the app in THIS process, which reads this process's environment, so the file
 *    must delete DATABASE_URL from it.
 */
function startsServerUnisolated(raw: string): boolean {
  // Comments are not code: a file that only mentions the bundle, or the variable, in a comment does not start anything.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  // (a method call such as RegExp.exec( is not a process start, hence the look-behind)
  const spawnsBundle = /server\.cjs/.test(src) && /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/.test(src);
  if (spawnsBundle) {
    // One spread per place that starts a process: a second start that forgets it must not hide behind the first.
    // (only calls that name the bundle before the statement ends: a spawn of `node -e` or of a script is not a server start)
    const starts = (src.match(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\([^;]{0,300}?server\.cjs/g) || []).length;
    const spreads = (src.match(/\.\.\.\s*TEST_AUTH_ENV/g) || []).length;
    if (spreads < starts) return true;
  }
  const buildsInProcess = /(?:from|import\s*\(|require\s*\()\s*['"]\.\.\/(?:server|api)(?:\/[^'"]*)?['"]/.test(src);
  if (buildsInProcess && !/delete\s+process\.env\.DATABASE_URL|process\.env\.DATABASE_URL\s*=\s*['"]{2}/.test(src)) return true;
  return false;
}

// fixtures: the guard must be able to fail
check('a suite that spawns the server with process.env and nothing else is flagged', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, PORT: '1' } })`), true);
check('...one that spreads TEST_AUTH_ENV is not', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, ...TEST_AUTH_ENV } })`), false);
check('...the word DATABASE_URL in a comment does not isolate it', startsServerUnisolated(`// DATABASE_URL\nspawn('node', ['dist/server.cjs'], { env: { ...process.env } })`), true);
check('...a file that only mentions the bundle in a comment and calls RegExp.exec is not a start', startsServerUnisolated(`// esbuild does for dist/server.cjs\nwhile ((m = RE.exec(src))) {}`), false);
check('...a second start that forgets the spread is flagged even though the first has it', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, ...TEST_AUTH_ENV } });\nspawn('node', ['dist/server.cjs'], { env: { ...process.env } });`), true);
check('...two starts that both spread it are not', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...TEST_AUTH_ENV } });\nspawn('node', ['dist/server.cjs'], { env: { ...TEST_AUTH_ENV } });`), false);
check('...a spread inside a comment does not isolate it', startsServerUnisolated(`// ...TEST_AUTH_ENV\nspawn('node', ['dist/server.cjs'], { env: { ...process.env } })`), true);
check('...a path built with path.join is still a start of the server', startsServerUnisolated(`spawn('node', [path.join(cwd, 'dist', 'server.cjs')], { env: { ...process.env } })`), true);
check('...so is exec of the bundle', startsServerUnisolated(`exec('node dist/server.cjs')`), true);
check('...a file that does not start the server is not', startsServerUnisolated(`console.log('dist/server.cjs is the bundle')`), false);
check('building the app in this process without removing DATABASE_URL is flagged', startsServerUnisolated(`const { default: buildApp } = await import('../server');`), true);
check('...as is importing the api entry', startsServerUnisolated(`import handler from '../api/index';`), true);
check('...removing it first is not', startsServerUnisolated(`delete process.env.DATABASE_URL;\nconst { default: buildApp } = await import('../server');`), false);
check('...a relative import of something else is not', startsServerUnisolated(`import { x } from '../src/store';`), false);

const dir = path.resolve('test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'testIsolation.test.ts');
const flagged = files.filter((f) => startsServerUnisolated(fs.readFileSync(path.join(dir, f), 'utf8')));
check('every test that starts the built server is isolated from DATABASE_URL', flagged, []);
check('the scan found the test sources to read', files.length > 20, true);

const helper = fs.readFileSync(path.join(dir, 'authHelper.ts'), 'utf8');
check('TEST_AUTH_ENV blanks DATABASE_URL', /TEST_AUTH_ENV\s*=\s*\{[\s\S]*?DATABASE_URL:\s*''[\s\S]*?\};/.test(helper), true);

const prod = fs.readFileSync(path.resolve('scripts/prod-install-check.sh'), 'utf8');
const starts = prod.replace(/\\\n/g, ' ').split('\n').filter((l) => /node dist\/server\.cjs|dist\/server\.cjs/.test(l) && /NODE_ENV=production/.test(l));
check('the production-install check blanks DATABASE_URL on every server start it makes', [starts.length >= 1, starts.every((l) => /DATABASE_URL=/.test(l))], [true, true]);

console.log(failures === 0 ? '\nAll test isolation checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
