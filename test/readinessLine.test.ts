/**
 * How the smoke script reads each entry of the deep readiness answer (scripts/readinessLine.mjs): measured and ok is
 * a pass; ok only because it could not look is a warning; anything not ok FAILS, unverified or not, except the
 * storage entry on a deployment whose lack of durable storage is a known limit flagged with --warn-non-durable.
 * Run: npx tsx test/readinessLine.test.ts
 */
// @ts-ignore - a plain ES module script with no type declarations
import { classifyReadinessCheck } from '../scripts/readinessLine.mjs';

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
const c = (name: string, ok: boolean, verified?: any) => ({ name, ok, verified, detail: 'x' });

check('ok and measured is a pass', classifyReadinessCheck(c('gemini', true, true)), 'pass');
check('ok with no word about being measured is a pass', [classifyReadinessCheck(c('a', true)), classifyReadinessCheck(c('a', true, null)), classifyReadinessCheck(c('a', true, 'false'))], ['pass', 'pass', 'pass']);
check('ok only because it could not look is a warning', classifyReadinessCheck(c('chatgpt', true, false)), 'warn');
check('NOT ok and not verified still FAILS (for example a tripped quota breaker)', classifyReadinessCheck(c('gemini', false, false)), 'fail');
check('not ok and verified FAILS', classifyReadinessCheck(c('gemini', false, true)), 'fail');
check('not ok with nothing said about measuring FAILS', classifyReadinessCheck(c('gemini', false)), 'fail');

const flagged = { warnNonDurable: true, durable: false };
check('storage that is not durable is a warning only when the flag is given and the deployment really is not durable', [classifyReadinessCheck(c('storage', false, true), flagged), classifyReadinessCheck(c('storage', false, true)), classifyReadinessCheck(c('storage', false, true), { warnNonDurable: true, durable: true }), classifyReadinessCheck(c('storage', false, true), { warnNonDurable: false, durable: false })], ['warn', 'fail', 'fail', 'fail']);
check('the flag softens nothing but storage', [classifyReadinessCheck(c('gemini', false, true), flagged), classifyReadinessCheck(c('sign-in', false, true), flagged), classifyReadinessCheck(c('recent trouble', false, true), flagged)], ['fail', 'fail', 'fail']);

console.log(failures === 0 ? '\nAll readiness-line checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
