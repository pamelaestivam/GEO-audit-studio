/**
 * What the server's own status becomes on screen. Run with: npx tsx test/statusView.test.ts
 */
import { TEMPORARY_STORAGE_NOTICE, NO_ENGINE_NOTICE, storageNotice, hasNoEngine, noEngineNotice } from '../src/statusView';

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

check('storage that is not durable says so', storageNotice({ durable: false }), TEMPORARY_STORAGE_NOTICE);
check('durable storage shows nothing', storageNotice({ durable: true }), null);
check('unknown storage (status not loaded yet, or failed) shows nothing rather than a guess', [storageNotice(null), storageNotice(undefined)], [null, null]);
check('the storage notice tells the person what to do', /Export your report/.test(TEMPORARY_STORAGE_NOTICE), true);
check('...and does not promise anything about durability or availability', /durable|guarantee|never/i.test(TEMPORARY_STORAGE_NOTICE), false);

check('an empty engine list means none is configured', [hasNoEngine([]), noEngineNotice([])], [true, NO_ENGINE_NOTICE]);
check('an engine means measurement is possible', [hasNoEngine(['Gemini']), noEngineNotice(['Gemini'])], [false, null]);
check('unknown engines (not yet loaded) is NOT treated as none, so the button is not disabled by a slow status call', [hasNoEngine(null), noEngineNotice(null), hasNoEngine(undefined)], [false, null, false]);
check('the no-engine notice says nothing is simulated', /Nothing is simulated/.test(NO_ENGINE_NOTICE), true);

console.log(failures === 0 ? '\nAll status view checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
