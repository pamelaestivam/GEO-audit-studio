/**
 * A guard on the tests themselves. An end-to-end test that checks its server came up and then does
 * `if (!up) return;` inside main() skips the code after its try/finally, which is the code that sets the exit
 * status: the test prints FAIL and exits 0, and the suite goes green without having run anything (found
 * 2026-10-10, when a server start-up timeout under load made quotaBreakerE2E vanish from a passing run).
 * Every early return after a failed check must set process.exitCode (or exit, or throw) first.
 *
 * The scan looks at each bare `return;` and at the closest `if (!...)` or `if (... === false)` within the four
 * lines up to it, whatever the brace style, and flags it unless exitCode / process.exit / throw appears between
 * the two. The scan is itself checked against fixtures below, so it cannot quietly stop recognising a shape.
 * Run: npx tsx test/testHarness.test.ts
 */
import fs from 'fs';
import path from 'path';

const NEGATED_CHECK = /\bif\s*\(\s*(?:!|[^)]*===\s*false\b)/;
const SETS_STATUS = /process\.exitCode|process\.exit\(|\bthrow\b/;
const WINDOW = 4;

/** Line numbers (1-based) of bare returns that follow a negated check without setting an exit status. */
function findSilentEarlyReturns(source: string): number[] {
  const lines = source.split('\n');
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!/\breturn;/.test(line)) return;
    for (let j = i; j >= Math.max(0, i - WINDOW); j--) {
      if (!NEGATED_CHECK.test(lines[j])) continue;
      // the status may sit anywhere from the check through the return, including on the return line itself
      const between = lines.slice(j, i + 1).join('\n');
      if (!SETS_STATUS.test(between)) found.push(i + 1);
      return;
    }
  });
  return found;
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

// ---- the scan, against the shapes it must catch and the shapes it must leave alone
const mustFlag: Record<string, string> = {
  'one-liner': 'if (!up) return;',
  'braced': 'if (!up) {\n  return;\n}',
  'braced on one line': 'if (!up) { return; }',
  'work before the return': 'if (!up) {\n  cleanup();\n  return;\n}',
  'return on the next line': 'if (!up)\n  return;',
  'dotted name': 'if (!server.up) return;',
  'no space': 'if(!up) return;',
  'awaited check': 'if (!(await waitForServer())) return;',
  'explicit false': 'if (up === false) return;',
};
for (const [name, src] of Object.entries(mustFlag)) {
  check(`the scan flags a silent early return: ${name}`, findSilentEarlyReturns(src).length === 1, JSON.stringify(src));
}
const mustLeave: Record<string, string> = {
  'exit code set in the block': 'if (!up) {\n  process.exitCode = 1;\n  return;\n}',
  'exit code set on the same line': 'if (!up) { process.exitCode = 1; return; }',
  'process.exit': 'if (!up) {\n  process.exit(1);\n  return;\n}',
  'a throw instead of a return': 'if (!up) throw new Error("no server");',
  'a handler return after a positive check': "if (mode === 'unauthorized') {\n  res.end('x');\n  return;\n}",
  'a return with a value': 'if (!up) return null;',
};
for (const [name, src] of Object.entries(mustLeave)) {
  check(`the scan leaves alone: ${name}`, findSilentEarlyReturns(src).length === 0, JSON.stringify(src));
}

// ---- the real test sources
const dir = path.join(process.cwd(), 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'testHarness.test.ts');
check('the scan found the test sources to read', files.length > 10, `found ${files.length} files in ${dir}`);
const bad: string[] = [];
for (const file of files) {
  for (const n of findSilentEarlyReturns(fs.readFileSync(path.join(dir, file), 'utf8'))) bad.push(`${file}:${n}`);
}
check('no test returns early after a failed check without setting an exit status', bad.length === 0, bad.join('\n        '));

console.log(failures === 0 ? '\nAll test harness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
