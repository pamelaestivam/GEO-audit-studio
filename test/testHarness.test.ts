/**
 * A guard on the tests themselves. An end-to-end test that checks its server came up and then does
 * `if (!up) return;` inside main() skips the code after its try/finally, which is the code that sets the exit
 * status: the test prints FAIL and exits 0, and the suite goes green without having run anything (found
 * 2026-10-10, when a server start-up timeout under load made quotaBreakerE2E vanish from a passing run).
 * Every early return after a failed check must set a non-zero process.exitCode (or exit non-zero, or throw) first.
 *
 * How the scan decides: for each bare `return;` it finds the block the return sits in (the nearest earlier line
 * indented less than the return, or the same line for `if (!up) return;`), reads back to the `if (` that opens it
 * (a condition split over several lines is read whole), and flags the return when that condition is a negation
 * (`!`, `!=`, `== false`, `== null`, `== undefined`) and nothing between the `if` and the `return` sets a failing
 * exit status. Comments are ignored, so a comment that mentions process.exitCode does not count. A return that is
 * correct for a reason the scan cannot see (a fake-server handler that ends the response and returns) is marked
 * with `// harness-ok: <why>` on the `if` line or the return line.
 * The scan is itself checked against fixtures below, so it cannot quietly stop recognising a shape.
 * Run: npx tsx test/testHarness.test.ts
 */
import fs from 'fs';
import path from 'path';

const IF_HEAD = /\bif\s*\(/;
const NEGATED = /!|(?:==|===)\s*(?:false|null|undefined)\b/;
const FAILING_STATUS = /process\.exitCode\s*=\s*[1-9]|process\.exit\(\s*[1-9]|\bthrow\b/;
const BARE_RETURN = /\breturn\s*(?:undefined\s*)?;/;
const MARKER = 'harness-ok';
const MAX_LOOKBACK = 60;

const indentOf = (line: string) => line.length - line.trimStart().length;
const stripComment = (line: string) => line.replace(/\/\/.*$/, '');

/** Line numbers (1-based) of bare returns that follow a negated check without setting a failing exit status. */
function findSilentEarlyReturns(source: string): number[] {
  const raw = source.split('\n');
  const code = raw.map(stripComment);
  const found: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!BARE_RETURN.test(code[i])) continue;
    // 1. locate the line that opens the block this return sits in
    let head = -1;
    const before = code[i].slice(0, code[i].search(BARE_RETURN));
    if (IF_HEAD.test(before)) {
      head = i; // `if (!up) return;` or `if (!up) { return; }`
    } else {
      const ind = indentOf(raw[i]);
      for (let j = i - 1; j >= Math.max(0, i - MAX_LOOKBACK); j--) {
        if (code[j].trim() === '') continue;
        if (indentOf(raw[j]) >= ind) continue;
        head = j;
        // a condition split over lines closes with `) {` at the indent of its `if (`: walk up to that line
        if (code[j].trim().startsWith(')')) {
          for (let k = j - 1; k >= Math.max(0, j - MAX_LOOKBACK); k--) {
            if (IF_HEAD.test(code[k]) && indentOf(raw[k]) === indentOf(raw[j])) {
              head = k;
              break;
            }
          }
        }
        break;
      }
    }
    if (head < 0 || !IF_HEAD.test(code[head])) continue; // not directly inside an `if` (else, loop, function body)
    // 2. the condition: everything from `if (` up to the block's opening brace or the return
    const span = code.slice(head, i + 1).join('\n');
    const condition = span.slice(span.search(IF_HEAD)).split(/\{|\breturn\b/)[0];
    if (!NEGATED.test(condition)) continue;
    if (raw.slice(head, i + 1).some((l) => l.includes(MARKER))) continue;
    if (!FAILING_STATUS.test(span)) found.push(i + 1);
  }
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
  'a long block of work and comments before the return':
    'if (!up) {\n  // the server never came up;\n  // nothing below can run\n  console.error("no server");\n  await stopAll();\n  await closeFake();\n  log("done");\n  return;\n}',
  'return on the next line': 'if (!up)\n  return;',
  'dotted name': 'if (!server.up) return;',
  'no space': 'if(!up) return;',
  'awaited check': 'if (!(await waitForServer())) return;',
  'explicit false': 'if (up === false) return;',
  'a call before === false': 'if ((await waitForServer()) === false) return;',
  'a call result compared to false': 'if (check(x) === false) return;',
  'loose equality to false': 'if (up == false) return;',
  'null result of a failed start': 'if (A === null) return;',
  'loose null': 'if (A == null) return;',
  'undefined': 'if (A === undefined) return;',
  'not-equal to true': 'if (up !== true) return;',
  'a condition split over lines': 'if (\n  !(await waitForServer(20000))\n) {\n  return;\n}',
  'return ;': 'if (!up) {\n  return ;\n}',
  'return undefined': 'if (!up) {\n  return undefined;\n}',
  'a comment that mentions the status': 'if (!up) {\n  // TODO set process.exitCode = 1\n  return;\n}',
  'a status of zero': 'if (!up) {\n  process.exitCode = 0;\n  return;\n}',
  'the status set after the return': 'if (!up) {\n  return;\n  process.exitCode = 1;\n}',
};
for (const [name, src] of Object.entries(mustFlag)) {
  check(`the scan flags a silent early return: ${name}`, findSilentEarlyReturns(src).length === 1, JSON.stringify(src));
}
const mustLeave: Record<string, string> = {
  'exit code set in the block': 'if (!up) {\n  process.exitCode = 1;\n  return;\n}',
  'exit code set on the same line': 'if (!up) { process.exitCode = 1; return; }',
  'exit code set before a long block':
    'if (!up) {\n  process.exitCode = 1;\n  log("a");\n  log("b");\n  log("c");\n  log("d");\n  return;\n}',
  'process.exit(1)': 'if (!up) {\n  process.exit(1);\n  return;\n}',
  'a throw instead of a return': 'if (!up) throw new Error("no server");',
  'a handler return after a positive check': "if (mode === 'unauthorized') {\n  res.end('x');\n  return;\n}",
  'a return with a value': 'if (!up) return null;',
  'an earlier closed negated block': 'if (!a) {\n  cleanup();\n}\nlog("x");\nreturn;',
  'a return in a plain function body': 'function f() {\n  log("x");\n  return;\n}',
  'a return under an else': 'if (!a) {\n  process.exitCode = 1;\n} else {\n  return;\n}',
  'a handler return marked harness-ok': 'if (!req.url) {\n  res.end();\n  return; // harness-ok: fake-server handler\n}',
  'a marker on the if line': 'if (!body) return; // harness-ok: handler has already answered',
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
