/**
 * A guard on the tests themselves. An end-to-end test that checks its server came up and then does
 * `if (!up) return;` inside main() skips the code after its try/finally, which is the code that sets the exit
 * status: the test prints FAIL and exits 0, and the suite goes green without having run anything (found
 * 2026-10-10, when a server start-up timeout under load made quotaBreakerE2E vanish from a passing run).
 * Every early return after a failed start must set process.exitCode first.
 * Run: npx tsx test/testHarness.test.ts
 */
import fs from 'fs';
import path from 'path';

let failures = 0;
const dir = path.join(process.cwd(), 'test');
const bad: string[] = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
  if (file === 'testHarness.test.ts') continue;
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/if \(!\w+\)\s*return;/.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}
if (bad.length) {
  failures++;
  console.log(`FAIL  a test returns early after a failed check without setting an exit status:\n        ${bad.join('\n        ')}`);
} else {
  console.log('pass  no test returns early after a failed check without setting an exit status');
}
console.log(failures === 0 ? '\nAll test harness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
