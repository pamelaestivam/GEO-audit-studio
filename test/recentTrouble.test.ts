/**
 * Pure checks for the "recent trouble" sentence and verdict the deep readiness check reports
 * (`src/recentTrouble.ts`): quiet is healthy only where it can be measured, a step that threw or ran out of tries or a
 * broken report is a fault, an empty day is a fault, restarts and slow audits are noted but are not, and the window is
 * enforced here. Run: npx tsx test/recentTrouble.test.ts
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
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const base = { now: NOW, windowHours: 24, durable: true };
const none = { failed: {}, degraded: 0, succeeded: 0 };
const inc = (kind: string, ageHours = 1, detail = `${kind} happened`) => ({ kind: kind as any, at: NOW - ageHours * H, detail });

const quiet = summariseRecentTrouble({ ...base, outcomes: none, incidents: [] });
check('nothing recorded on a durable store is healthy and says so', [quiet.ok, quiet.verified, quiet.detail], [true, true, 'No audit failed and no incident was recorded in the last 24 hours.']);

const fine = summariseRecentTrouble({ ...base, outcomes: { ...none, succeeded: 4 }, incidents: [] });
check('...and says how many finished normally', fine.detail, 'No audit failed and no incident was recorded in the last 24 hours. 4 audits finished normally.');

const unmeasured = summariseRecentTrouble({ ...base, durable: false, outcomes: none, incidents: [] });
check('on a server that keeps nothing, silence is NOT reported as health: it says it could not check', [unmeasured.ok, unmeasured.verified, /^Not checked\./.test(unmeasured.detail), /No audit failed/.test(unmeasured.detail)], [true, false, true, false]);

const benign = summariseRecentTrouble({ ...base, outcomes: { failed: { stuck: 2, restarted: 1 }, degraded: 0, succeeded: 5 }, incidents: [inc('lease_expired_midcall')] });
check('audits stopped for taking too long, a restart and a repeated call are noted but are not a fault', [benign.ok, benign.serious], [true, 0]);
check('...and the sentence names each one', benign.detail, 'In the last 24 hours: 3 audits ended in error (2 took too long and were stopped, 1 was interrupted by a restart); 1 incident was recorded (1 lease expired midcall); 5 audits finished normally. None of this is a fault in the server: restarts, slow audits, repeated calls and an occasional empty audit are expected now and then.');

const broken = summariseRecentTrouble({ ...base, outcomes: { failed: { step_attempts_exceeded: 1 }, degraded: 0, succeeded: 0 }, incidents: [inc('step_attempts_exceeded', 1, 'Step collect:0:Gemini did not finish after 3 tries.')] });
check('a step that ran out of tries is a fault, counted once although it left both a failure code and an incident', [broken.ok, broken.serious], [false, 1]);
check('...and the sentence quotes the most recent serious incident instead of pointing at a page that does not exist', [/Most recent: Step collect:0:Gemini did not finish after 3 tries\./.test(broken.detail), /look at the incidents/.test(broken.detail)], [true, false]);

const thrown = summariseRecentTrouble({ ...base, outcomes: none, incidents: [inc('step_exception'), inc('step_exception')] });
check('a step that threw is a fault even when the audit itself ended as a (failed) report', [thrown.ok, thrown.serious], [false, 2]);

const invariant = summariseRecentTrouble({ ...base, outcomes: { ...none, degraded: 1 }, incidents: [inc('invariant', 0.5, 'A report failed 1 consistency check and was not shown: forced')] });
check('a report that failed its own consistency checks is a fault (the incident), even though the audit finished', [invariant.ok, /Most recent: A report failed 1 consistency check/.test(invariant.detail)], [false, true]);

const unexplained = summariseRecentTrouble({ ...base, outcomes: { failed: { none: 1 }, degraded: 0, succeeded: 0 }, incidents: [] });
check('an audit that ended in error with no recorded reason is a fault', [unexplained.ok, /without a recorded reason/.test(unexplained.detail)], [false, true]);

const driver = summariseRecentTrouble({ ...base, outcomes: { failed: { driver_error: 1 }, degraded: 0, succeeded: 0 }, incidents: [] });
check('a failure inside the driver is a fault', driver.ok, false);

const odd = summariseRecentTrouble({ ...base, outcomes: { failed: { something_new: 1 }, degraded: 0, succeeded: 0 }, incidents: [] });
check('a code this version does not know is shown, not hidden, and is not assumed to be a fault', [odd.ok, /something_new/.test(odd.detail)], [true, true]);

// ---- empty audits: every one empty is a fault; some empty among successes is noted
const allEmpty = summariseRecentTrouble({ ...base, outcomes: { ...none, degraded: 3 }, incidents: [] });
check('every audit in the window finishing with no result is a fault and says what to check', [allEmpty.ok, /3 audits finished with no result/.test(allEmpty.detail), /key is accepted/.test(allEmpty.detail), /No audit failed/.test(allEmpty.detail)], [false, true, true, false]);
const someEmpty = summariseRecentTrouble({ ...base, outcomes: { ...none, degraded: 1, succeeded: 6 }, incidents: [] });
check('...one empty audit among six that worked is noted, not a fault', [someEmpty.ok, /1 audit finished with no result/.test(someEmpty.detail), /6 audits finished normally/.test(someEmpty.detail)], [true, true, true]);

// ---- the window is enforced here, edges included
const old = summariseRecentTrouble({ ...base, outcomes: none, incidents: [inc('step_exception', 25)] });
check('an incident older than the window is ignored', [old.ok, old.detail], [true, 'No audit failed and no incident was recorded in the last 24 hours.']);
const edge = summariseRecentTrouble({ ...base, outcomes: none, incidents: [{ kind: 'step_exception', at: NOW - 24 * H, detail: 'x' }] });
check('...an incident exactly at the edge of the window still counts', edge.ok, false);
const justOutside = summariseRecentTrouble({ ...base, outcomes: none, incidents: [{ kind: 'step_exception', at: NOW - 24 * H - 1, detail: 'x' }] });
check('...one millisecond outside does not', justOutside.ok, true);

check('one hour reads as one hour', summariseRecentTrouble({ now: NOW, windowHours: 1, durable: true, outcomes: none, incidents: [] }).detail, 'No audit failed and no incident was recorded in the last 1 hour.');

console.log(failures === 0 ? '\nAll recent-trouble checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
