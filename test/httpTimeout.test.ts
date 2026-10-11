/**
 * The rule for GEMINI_HTTP_TIMEOUT_MS, as a pure function (src/httpTimeout.ts): the setting that bounds one Gemini request
 * must never quietly become "no limit" (NaN, 0) or "abandon at once" (above the largest timer delay). Run: npx tsx test/httpTimeout.test.ts
 */
import { parseMillisecondsSetting } from '../src/httpTimeout';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}
const parse = (raw: string | undefined) => parseMillisecondsSetting('GEMINI_HTTP_TIMEOUT_MS', raw, 90000, 100);

for (const raw of [undefined, '', '   ']) {
  const r = parse(raw);
  check(`${JSON.stringify(raw)} is the default, with no warning`, r.ms === 90000 && !r.warning, JSON.stringify(r));
}
for (const [raw, ms] of [['1500', 1500], ['100', 100], [' 500 ', 500], ['1e3', 1000], ['90000', 90000], ['600000.5', 600000.5], ['2147483647', 2147483647]] as const) {
  const r = parse(raw);
  check(`${JSON.stringify(raw)} is used as ${ms}`, r.ms === ms && !r.warning, JSON.stringify(r));
}
for (const raw of ['soon', 'NaN', '0', '-5', '99', 'Infinity', '-Infinity', '10s', '1,500', 'null', 'undefined', '2147483648', '3000000000', '1e12']) {
  const r = parse(raw);
  check(`${JSON.stringify(raw)} is refused: the default is used and a warning is given`, r.ms === 90000 && typeof r.warning === 'string' && r.warning.includes('GEMINI_HTTP_TIMEOUT_MS') && r.warning.includes(JSON.stringify(raw)), JSON.stringify(r));
}
check('a value above the largest timer delay is refused: a timer would clamp it to 1 ms and abandon every request at once', parse('3000000000').ms === 90000 && !!parse('3000000000').warning);
check('a refused value is never 0, NaN or Infinity (which the SDK would read as no limit)', ['soon', 'NaN', '0', '-5', 'Infinity'].every((raw) => Number.isFinite(parse(raw).ms) && parse(raw).ms > 0));
console.log(failures === 0 ? '\nHTTP timeout setting checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
