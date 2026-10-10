/**
 * The $0 guard (src/spendGuard.ts): paid engines are off unless allowed, the per-day call counter and
 * cap, and what configuredEngines() therefore returns. Run with: npx tsx test/spendGuard.test.ts
 */
import { paidEnginesAllowed, paidEnginesBlocked, dailyCallCap, CallCounter, capReachedMessage } from '../src/spendGuard';
import { configuredEngines } from '../src/providers';
import { paidEngineNotice } from '../src/statusView';

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

// ---- paid engines are off unless allowed ---------------------------------------------------
check('paid engines are not allowed by default', paidEnginesAllowed({}), false);
check('only the exact value 1 allows them', [paidEnginesAllowed({ ALLOW_PAID_ENGINES: '1' }), paidEnginesAllowed({ ALLOW_PAID_ENGINES: 'true' }), paidEnginesAllowed({ ALLOW_PAID_ENGINES: '0' }), paidEnginesAllowed({ ALLOW_PAID_ENGINES: '' })], [true, false, false, false]);
const keys = { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', PERPLEXITY_API_KEY: 'p', ANTHROPIC_API_KEY: 'a' };
check('every paid engine with a key is reported as blocked, Gemini never', paidEnginesBlocked(keys), ['ChatGPT', 'Perplexity', 'Claude']);
check('a paid engine without a key is not "blocked"', paidEnginesBlocked({ OPENAI_API_KEY: 'o' }), ['ChatGPT']);
check('nothing is blocked once spending is allowed', paidEnginesBlocked({ ...keys, ALLOW_PAID_ENGINES: '1' }), []);

// configuredEngines reads process.env: set it for each case and restore.
const saved = { ...process.env };
function withEnv(env: Record<string, string | undefined>, fn: () => any) {
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'ANTHROPIC_API_KEY', 'ALLOW_PAID_ENGINES']) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
check('with every key set and no opt-in, only Gemini is queried', withEnv(keys, configuredEngines), ['Gemini']);
check('with the opt-in, every engine that has a key is queried', withEnv({ ...keys, ALLOW_PAID_ENGINES: '1' }, configuredEngines), ['Gemini', 'ChatGPT', 'Perplexity', 'Claude']);
check('a paid key alone and no opt-in leaves no engine at all (not a simulation)', withEnv({ OPENAI_API_KEY: 'o' }, configuredEngines), []);
check('no key, no engine', withEnv({}, configuredEngines), []);

// ---- the daily cap value -----------------------------------------------------------------
check('no cap unless a positive whole number is given', [dailyCallCap({}), dailyCallCap({ GEMINI_DAILY_CALL_CAP: '' }), dailyCallCap({ GEMINI_DAILY_CALL_CAP: '0' }), dailyCallCap({ GEMINI_DAILY_CALL_CAP: '-5' }), dailyCallCap({ GEMINI_DAILY_CALL_CAP: '2.5' }), dailyCallCap({ GEMINI_DAILY_CALL_CAP: 'lots' })], [null, null, null, null, null, null]);
check('a positive whole number is the cap', dailyCallCap({ GEMINI_DAILY_CALL_CAP: '40' }), 40);

// ---- the counter ---------------------------------------------------------------------------
let now = Date.parse('2026-10-10T12:00:00Z');
const counter = new CallCounter(() => now);
check('starts at zero', counter.today(), 0);
counter.record();
counter.record();
check('counts calls made today', counter.today(), 2);
check('no cap never blocks', counter.wouldExceed(null), false);
check('below the cap does not block', counter.wouldExceed(3), false);
check('at the cap blocks the next call', counter.wouldExceed(2), true);
now = Date.parse('2026-10-10T23:59:59Z');
check('still the same UTC day', counter.today(), 2);
now = Date.parse('2026-10-11T00:00:01Z');
check('a new UTC day starts from zero', counter.today(), 0);
check('...and the cap no longer blocks', counter.wouldExceed(2), false);
for (let d = 0; d < 12; d++) {
  now = Date.parse('2026-10-12T00:00:00Z') + d * 86400000;
  counter.record();
}
check('old days are dropped (memory stays bounded)', (counter as any).byDay.size <= 7, true);
check('the cap sentence says what happened, what was kept and what to do', /at most 2 .* calls a day \(UTC\).*measured results were kept.*GEMINI_DAILY_CALL_CAP/.test(capReachedMessage(2)), true);

// ---- the notice ---------------------------------------------------------------------------
check('no notice when nothing is blocked or unknown', [paidEngineNotice([]), paidEngineNotice(null), paidEngineNotice(undefined)], [null, null, null]);
check('one blocked engine is named', paidEngineNotice(['ChatGPT']), 'ChatGPT is set up on this server but switched off, because it is a paid service and paid engines are not switched on for this server. Nothing from it is measured or simulated.');
check('several are named in a list', paidEngineNotice(['ChatGPT', 'Perplexity', 'Claude']), 'ChatGPT, Perplexity and Claude are set up on this server but switched off, because they are paid services and paid engines are not switched on for this server. Nothing from them is measured or simulated.');

console.log(failures === 0 ? '\nAll spend guard checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
