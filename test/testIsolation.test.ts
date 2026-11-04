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

/** Does this source start the server without isolating it from DATABASE_URL? */
function startsServerUnisolated(src: string): boolean {
  const starts = /spawn\(\s*['"]node['"]\s*,\s*\[\s*['"]dist\/server\.cjs['"]/.test(src) || /['"]dist\/server\.cjs['"]/.test(src) && /\bspawn\b|execFile|fork/.test(src);
  if (!starts) return false;
  return !(/\.\.\.\s*TEST_AUTH_ENV/.test(src) || /\bDATABASE_URL\b/.test(src));
}

// fixtures: the guard must be able to fail
check('a suite that spawns the server with process.env and nothing else is flagged', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, PORT: '1' } })`), true);
check('...one that spreads TEST_AUTH_ENV is not', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, ...TEST_AUTH_ENV } })`), false);
check('...one that sets DATABASE_URL itself is not', startsServerUnisolated(`spawn('node', ['dist/server.cjs'], { env: { ...process.env, DATABASE_URL: '' } })`), false);
check('...a file that does not start the server is not', startsServerUnisolated(`console.log('dist/server.cjs is the bundle')`), false);

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
