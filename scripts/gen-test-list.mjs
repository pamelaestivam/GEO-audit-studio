#!/usr/bin/env node
// Prints the markdown list of test files from test/manifest.json; `--write` puts it into CLAUDE.md between the tests:start and tests:end markers.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
export function testList() {
  const tests = JSON.parse(readFileSync(`${root}test/manifest.json`, 'utf8')).tests;
  return tests.map((t) => `- \`${t.file}\` (${t.tier}${t.needsBuild ? ', needs dist/' : ''}) — ${t.what || 'no summary yet'}`).join('\n');
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const list = testList();
  if (process.argv.includes('--write')) {
    const p = `${root}CLAUDE.md`; const s = readFileSync(p, 'utf8');
    const a = s.indexOf('<!-- tests:start -->') + '<!-- tests:start -->'.length; const b = s.indexOf('<!-- tests:end -->');
    writeFileSync(p, `${s.slice(0, a)}\n${list}\n${s.slice(b)}`);
    console.log('CLAUDE.md updated.');
  } else console.log(list);
}
