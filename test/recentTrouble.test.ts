/**
 * Pure checks for the "recent trouble" sentence the deep readiness check reports (`src/recentTrouble.ts`):
 * quiet is healthy, a broken step or an exhausted step is a fault, restarts and slow audits are noted but are not.
 * Run: npx tsx test/recentTrouble.test.ts
 */
import { summariseRecentTrouble } from '../src/recentTrouble';

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
const base = { windowHours: 24, durable: true };

const quiet = summariseRecentTrouble({ ...base, failedByCode: {}, incidents: [] });
check('nothing recorded is healthy and says so', [quiet.ok, quiet.serious, quiet.detail], [true, 0, 'No audit failed and no incident was recorded in the last 24 hours.']);

const notDurable = summariseRecentTrouble({ ...base, durable: false, failedByCode: {}, incidents: [] });
check('...and on a server that keeps nothing it says it only covers what it has seen', /keeps nothing across restarts/.test(notDurable.detail), true);

const benign = summariseRecentTrouble({ ...base, failedByCode: { stuck: 2, restarted: 1 }, incidents: [{ kind: 'lease_expired_midcall' }] });
check('audits stopped for taking too long, a restart and a repeated call are noted but are not a fault', [benign.ok, benign.serious], [true, 0]);
check('...and the sentence names each one', benign.detail, 'In the last 24 hours: 3 audits ended in error (2 took too long and were stopped, 1 was interrupted by a restart); 1 incident was recorded (1 lease expired midcall). None of this is a fault in the server: restarts, slow audits and repeated calls are expected now and then.');

const broken = summariseRecentTrouble({ ...base, failedByCode: { step_attempts_exceeded: 1 }, incidents: [{ kind: 'step_attempts_exceeded' }] });
check('a step that ran out of tries is a fault, counted once although it left both a failure code and an incident', [broken.ok, broken.serious], [false, 1]);
check('...and the sentence points at the incidents', /look at the incidents/.test(broken.detail), true);

const thrown = summariseRecentTrouble({ ...base, failedByCode: {}, incidents: [{ kind: 'step_exception' }, { kind: 'step_exception' }] });
check('a step that threw is a fault even when the audit itself ended as a (failed) report', [thrown.ok, thrown.serious], [false, 2]);

const invariant = summariseRecentTrouble({ ...base, failedByCode: {}, incidents: [{ kind: 'invariant' }] });
check('a failed invariant is a fault', invariant.ok, false);

const unexplained = summariseRecentTrouble({ ...base, failedByCode: { none: 1 }, incidents: [] });
check('an audit that ended in error with no recorded reason is a fault', [unexplained.ok, /without a recorded reason/.test(unexplained.detail)], [false, true]);

const driver = summariseRecentTrouble({ ...base, failedByCode: { driver_error: 1 }, incidents: [] });
check('a failure inside the driver is a fault', driver.ok, false);

const odd = summariseRecentTrouble({ ...base, failedByCode: { something_new: 1 }, incidents: [] });
check('a code this version does not know is shown, not hidden, and is not assumed to be a fault', [odd.ok, /something_new/.test(odd.detail)], [true, true]);

check('one hour reads as one hour', summariseRecentTrouble({ windowHours: 1, durable: true, failedByCode: {}, incidents: [] }).detail, 'No audit failed and no incident was recorded in the last 1 hour.');

console.log(failures === 0 ? '\nAll recent-trouble checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
