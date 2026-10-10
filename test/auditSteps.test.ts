/**
 * Pure checks for the step helpers (`src/auditSteps.ts`): the plan, which answers a set of steps produced, and the
 * quota-breaker rule. The server-level proof is test/auditStepsE2E.test.ts; this pins the rules, including the
 * several-engine cases no end-to-end test can reach (only Gemini can be faked). Run: npx tsx test/auditSteps.test.ts
 */
import { evidenceByQueryFromSteps, planSteps, skipForBreaker, startsQuestion, queryingProgress, analysingProgress } from '../src/auditSteps';
import type { JobStep } from '../src/store';

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

const plan = { queryList: [{}, {}], engines: ['Gemini', 'ChatGPT'] };
const planned = planSteps(plan, true);
check('two questions and two engines plan one step per pair, in order, then the analysis and the finish', planned.map((s) => s.key), [
  'collect:0:Gemini', 'collect:0:ChatGPT', 'collect:1:Gemini', 'collect:1:ChatGPT', 'narrative', 'finalize',
]);
check('...with the question and engine kept on each collect step', planned.slice(0, 2).map((s) => [s.queryIndex, s.engine]), [[0, 'Gemini'], [0, 'ChatGPT']]);
check('an audit that cannot measure anything has a single finishing step', planSteps(plan, false).map((s) => s.key), ['finalize']);
check('no questions still has the analysis and the finish (the finish reports the empty audit)', planSteps({ queryList: [], engines: ['Gemini'] }, true).map((s) => s.key), ['narrative', 'finalize']);

const steps = (states: Record<string, JobStep['state']>, results: Record<string, any> = {}): JobStep[] =>
  planned.map((p, seq) => ({ ...p, jobId: 'j', seq, state: states[p.key] ?? 'pending', attempt: 0, repeatedCalls: 0, result: results[p.key] }));

const ev = (engine: string, q: number) => ({ engine, queryText: `q${q}`, answerText: 'a', citations: [], searchQueries: [], capturedAt: 't', queryId: `q${q}` });
const done = steps(
  { 'collect:0:Gemini': 'done', 'collect:0:ChatGPT': 'done', 'collect:1:Gemini': 'skipped', 'collect:1:ChatGPT': 'failed' },
  { 'collect:0:Gemini': ev('Gemini', 0), 'collect:0:ChatGPT': ev('ChatGPT', 0), 'collect:1:ChatGPT': ev('ChatGPT', 1) }
);
const grouped = evidenceByQueryFromSteps(done, 2);
check('evidence is grouped by question in plan order; skipped and failed steps contribute nothing', grouped.map((g) => g.map((e) => e.engine)), [['Gemini', 'ChatGPT'], []]);
check('...a question nobody reached is an empty group, never missing', evidenceByQueryFromSteps(steps({}), 3).map((g) => g.length), [0, 0, 0]);

check('only the first collect step of a question starts it', planned.map((p, i) => startsQuestion(steps({}), steps({})[i])), [true, false, true, false, false, false]);

// the breaker rule
const none = steps({});
const under = steps({ 'collect:0:Gemini': 'done' });
check('breaker tripped: a question that has not started is skipped (its first step)', skipForBreaker(none, none[0], true, true), true);
check('...and so is every later step of an unstarted question', skipForBreaker(none, none[1], true, true), true);
check('...but a question already under way finishes its other engines', skipForBreaker(under, under[1], true, true), false);
check('...and the next question is skipped', skipForBreaker(under, under[2], true, true), true);
check('breaker not tripped: nothing is skipped', skipForBreaker(none, none[0], false, true), false);
check('no Gemini in the plan: the Gemini breaker never skips', skipForBreaker(none, none[2], true, false), false);
check('the analysis and the finish are never skipped by the breaker', [skipForBreaker(none, none[4], true, true), skipForBreaker(none, none[5], true, true)], [false, false]);
const skippedFirst = steps({ 'collect:0:Gemini': 'skipped' });
check('a question whose first step was skipped skips its remaining steps too', skipForBreaker(skippedFirst, skippedFirst[1], true, true), true);

check('progress while collecting question 2 of 3: two done', queryingProgress(1, 3), { phase: 'querying', done: 1, total: 3 });
check('progress once collection is over', analysingProgress(3), { phase: 'analysing', done: 3, total: 3 });

console.log(failures === 0 ? '\nAll audit step checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
