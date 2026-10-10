/**
 * Pure checks for how headline numbers are presented. Run: npx tsx test/reportView.test.ts
 *
 * Each maps to something a real browser run showed: a failed audit printing
 * "0%" and a green ring, "100% accuracy" after the analysis step failed, and a
 * single answer presented as a 100/100 score with no sample size.
 */
import {
  notCountedView,
  describeAccuracy,
  findingCounts,
  formatPercent,
  formatScore,
  isLowSample,
  visibilityBasis,
  visibilityRange,
  rangeExplanation,
  lowSampleReason,
  formatScoreBadge,
  wilsonInterval,
  engineModelsLine,
  MEASUREMENT_DISCLOSURE,
  wasAssessed,
  NOT_MEASURED,
} from '../src/reportView';

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

const ok = { degraded: false };
const failed = { degraded: true };

check('a measured percentage is shown', formatPercent(ok, 42), '42%');
check('a measured zero is shown as 0%, not hidden', formatPercent(ok, 0), '0%');
check('a failed audit withholds the number', formatPercent(failed, 0), NOT_MEASURED);
check('a missing value is a dash, not NaN%', formatPercent(ok, undefined), NOT_MEASURED);
check('NaN is a dash', formatPercent(ok, Number.NaN), NOT_MEASURED);
check('the score of a failed audit is withheld', formatScore({ degraded: true, geoVisibilityScore: 0 }), NOT_MEASURED);
check('the score of a good audit is shown', formatScore({ degraded: false, geoVisibilityScore: 67 }), '67');

check(
  '1 of 1 is spelled out',
  visibilityBasis({ degraded: false, observationsWithEvidence: 1, observationsMentioned: 1, measuredEngines: ['Gemini'] }),
  'Named in 1 of 1 answer (Gemini)'
);
check(
  'plural and several engines',
  visibilityBasis({ degraded: false, observationsWithEvidence: 6, observationsMentioned: 2, measuredEngines: ['Gemini', 'Perplexity'] }),
  'Named in 2 of 6 answers (Gemini, Perplexity)'
);
check(
  'older reports without a numerator still describe their basis',
  visibilityBasis({ degraded: false, observationsWithEvidence: 4, measuredEngines: [] }),
  'Based on 4 answers'
);
check(
  'answers that failed are disclosed, not silently dropped from the denominator',
  visibilityBasis({ degraded: false, observationsWithEvidence: 2, observationsAttempted: 3, observationsMentioned: 1, measuredEngines: ['Gemini'] }),
  'Named in 1 of 2 answers (Gemini); 1 of 3 attempted answers failed and is not counted'
);
check(
  'no failures, no disclosure',
  visibilityBasis({ degraded: false, observationsWithEvidence: 3, observationsAttempted: 3, observationsMentioned: 1, measuredEngines: ['Gemini'] }),
  'Named in 1 of 3 answers (Gemini)'
);
check('a failed audit has no basis line', visibilityBasis({ degraded: true, observationsWithEvidence: 0, measuredEngines: [] }), null);

check('one answer is a low sample', isLowSample({ degraded: false, observationsWithEvidence: 1 }), true);
check('four answers is still a low sample', isLowSample({ degraded: false, observationsWithEvidence: 4 }), true);
check('five answers is not', isLowSample({ degraded: false, observationsWithEvidence: 5 }), false);
check('a failed audit gets no sample caution (it has bigger problems)', isLowSample({ degraded: true, observationsWithEvidence: 1 }), false);
check('an unknown sample size gets no caution rather than a guess', isLowSample({ degraded: false }), false);

check(
  'a failed analysis step is "not assessed", never 100%',
  describeAccuracy({ degraded: false, accuracyRate: null, narrativeAvailable: false }).value,
  NOT_MEASURED
);
check(
  'a failed analysis step explains itself',
  /not assessed/i.test(describeAccuracy({ degraded: false, accuracyRate: null, narrativeAvailable: false }).caption),
  true
);
check(
  'a brand that was never mentioned has nothing to check',
  describeAccuracy({ degraded: false, accuracyRate: null, narrativeAvailable: true }).value,
  'N/A'
);
check(
  'a real accuracy rate is shown',
  describeAccuracy({ degraded: false, accuracyRate: 100, narrativeAvailable: true }).value,
  '100%'
);
check(
  'a real accuracy rate is described as indicative',
  /indicative/i.test(describeAccuracy({ degraded: false, accuracyRate: 100, narrativeAvailable: true }).caption),
  true
);
check(
  'a report from before narrativeAvailable existed still shows its accuracy',
  describeAccuracy({ degraded: false, accuracyRate: 80 }).value,
  '80%'
);
check('a failed audit has no accuracy', describeAccuracy({ degraded: true, accuracyRate: 0 }).value, NOT_MEASURED);

check(
  'counts are withheld when not assessed',
  findingCounts({ degraded: false, narrativeAvailable: false, inaccuracies: [], omissions: [] }),
  null
);
check('counts are withheld on a failed audit', findingCounts({ degraded: true, inaccuracies: [], omissions: [] }), null);
check(
  'a genuine zero is a zero',
  findingCounts({ degraded: false, narrativeAvailable: true, inaccuracies: [], omissions: [] }),
  { inaccuracies: 0, omissions: 0, unattributed: 0 }
);

check('assessed: normal audit', wasAssessed({ degraded: false, narrativeAvailable: true }), true);
check('assessed: legacy report', wasAssessed({ degraded: false }), true);
check('assessed: analysis failed', wasAssessed({ degraded: false, narrativeAvailable: false }), false);
check('assessed: audit failed', wasAssessed({ degraded: true }), false);

// ---- uncertainty: a rate from a handful of answers carries its range (Wilson 95%, rounded outward)
check('2 of 3 answers is 67% with a range of about 20-94%', wilsonInterval(2, 3), { low: 20, high: 94 });
check('3 of 3 answers is not "certainly 100%": the range starts at 43%', wilsonInterval(3, 3), { low: 43, high: 100 });
check('0 of 3 is not "certainly 0%": the range reaches 57%', wilsonInterval(0, 3), { low: 0, high: 57 });
check('5 of 10 narrows to 23-77%', wilsonInterval(5, 10), { low: 23, high: 77 });
check('50 of 100 is 40-60%', wilsonInterval(50, 100), { low: 40, high: 60 });
check('rounding is outward: 0 of 1 is 0-80 (the exact upper end is 79.3), never narrowed to 79', wilsonInterval(0, 1), { low: 0, high: 80 });
check('no answers means no range (no divide by zero)', wilsonInterval(0, 0), null);
check('an impossible count means no range', wilsonInterval(4, 3), null);
check('the range text', visibilityRange({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 2 }), '20%-94%');
check('a failed audit shows no range', visibilityRange({ degraded: true, observationsWithEvidence: 3, observationsMentioned: 2 }), null);
check('a report without the counts shows no range rather than inventing one', visibilityRange({ degraded: false } as any), null);
check('the explanation says what the range is and does not promise a repeat run', /plausibly lie between 20%-94%/.test(rangeExplanation({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 2, queriesAttempted: 3 }) || '') && !/repeat run can land/.test(rangeExplanation({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 2 }) || ''), true);
check('answers from several engines to few questions say how the range was computed', /6 answers come from only 2 questions/.test(rangeExplanation({ degraded: false, observationsWithEvidence: 6, observationsMentioned: 6, queriesAttempted: 2 }) || ''), true);
check('...and the range really is the 2-reading one, not the 6-answer one (34%-100%, not 61%-100%)', visibilityRange({ degraded: false, observationsWithEvidence: 6, observationsMentioned: 6, queriesAttempted: 2 }), '34%-100%');
check('10 answers from one question is a single reading (20%-100%, rounded outward)', visibilityRange({ degraded: false, observationsWithEvidence: 10, observationsMentioned: 10, queriesAttempted: 1 }), '20%-100%');
check('mentions are scaled with the readings (4 of 8 answers from 4 questions is 2 of 4)', visibilityRange({ degraded: false, observationsWithEvidence: 8, observationsMentioned: 4, queriesAttempted: 4 }), '15%-85%');
check('the low-sample reason names questions when answers outnumber them', lowSampleReason({ observationsWithEvidence: 10, queriesAttempted: 1 }), 'Only 1 question behind these 10 answers');
check('...and answers otherwise', lowSampleReason({ observationsWithEvidence: 3, queriesAttempted: 3 }), 'Only 3 answers');
check('6 answers to 2 questions is still a LOW sample (they are 2 readings)', isLowSample({ degraded: false, observationsWithEvidence: 6, queriesAttempted: 2 }), true);
check('6 answers to 6 questions is not', isLowSample({ degraded: false, observationsWithEvidence: 6, queriesAttempted: 6 }), false);
check('an older report without the question count falls back to the answer count', isLowSample({ degraded: false, observationsWithEvidence: 3 }), true);
check('a score badge never travels without what it rests on', formatScoreBadge({ degraded: false, geoVisibilityScore: 100, observationsWithEvidence: 3 }), '100% (3 answers)');
check('a one-answer badge is singular', formatScoreBadge({ degraded: false, geoVisibilityScore: 100, observationsWithEvidence: 1 }), '100% (1 answer)');
check('a failed audit badge is a dash', formatScoreBadge({ degraded: true, geoVisibilityScore: 0, observationsWithEvidence: 0 }), NOT_MEASURED);
check('models are named beside their engines', engineModelsLine({ measuredEngines: ['Gemini', 'Claude'], engineModels: { Gemini: 'gemini-3.6-flash' } }), 'Gemini (gemini-3.6-flash), Claude');
check('an older report with no model stamp says nothing about models', engineModelsLine({ measuredEngines: ['Gemini'] }), null);
check('the disclosure says it is not the consumer app and was asked once', /not what people see/.test(MEASUREMENT_DISCLOSURE) && /once/.test(MEASUREMENT_DISCLOSURE), true);

check('questions that actually answered cap the readings, not the number planned (8 planned, 2 answered, 3 engines)', visibilityRange({ degraded: false, observationsWithEvidence: 6, observationsMentioned: 6, queriesAttempted: 8, questionsAnswered: 2 }), '34%-100%');
check('...and that is a low sample with the right reason', [isLowSample({ degraded: false, observationsWithEvidence: 6, queriesAttempted: 8, questionsAnswered: 2 }), lowSampleReason({ observationsWithEvidence: 6, queriesAttempted: 8, questionsAnswered: 2 })], [true, 'Only 2 questions behind these 6 answers']);
check('a brand named once in 7 answers from 3 questions is never "plausibly 0%": the rescaled count keeps at least one mention', visibilityRange({ degraded: false, observationsWithEvidence: 7, observationsMentioned: 1, queriesAttempted: 3, questionsAnswered: 3 })?.startsWith('0%'), false);
check('a brand missed in one answer is never "plausibly 100%-certain": the rescaled count keeps at least one miss', visibilityRange({ degraded: false, observationsWithEvidence: 7, observationsMentioned: 6, queriesAttempted: 3, questionsAnswered: 3 })?.endsWith('-100%'), false);
check('one question behind several answers reads "1 reading", not "1 readings"', /as if there were 1 reading\./.test(rangeExplanation({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 2, queriesAttempted: 1, questionsAnswered: 1 }) || ''), true);
{
  // Invariant: the range printed beside a score always contains that score, for any counts, including
  // answers-per-question beyond what four engines can produce today (a fifth engine or repeat samples).
  let outside = 0;
  for (let q = 1; q <= 6; q++) {
    for (let a = q; a <= 40; a++) {
      for (let m = 0; m <= a; m++) {
        const r = visibilityRange({ degraded: false, observationsWithEvidence: a, observationsMentioned: m, queriesAttempted: q, questionsAnswered: q });
        const [lo, hi] = (r || '').split('-').map((x) => parseInt(x, 10));
        const headline = (m / a) * 100;
        if (!r || headline < lo - 1e-9 || headline > hi + 1e-9) outside++;
      }
    }
  }
  check('the range always contains the headline percentage (no case in a 6 x 40 x all-mentions grid falls outside)', outside, 0);
}
check('2 of 3 answers from a single question: the range is wide (0%-80%) and still contains the 67% headline', visibilityRange({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 2, queriesAttempted: 1, questionsAnswered: 1 }), '0%-80%');
check('more mentions than answers (corrupt counts) gives no range, not "20%-167%"', visibilityRange({ degraded: false, observationsWithEvidence: 3, observationsMentioned: 5, queriesAttempted: 1 }), null);
check('negative mentions give no range', visibilityRange({ degraded: false, observationsWithEvidence: 3, observationsMentioned: -1, queriesAttempted: 1 }), null);

check('accuracy with discarded claims is labelled an upper bound', /at most this, since 2 reported claims/.test(describeAccuracy({ degraded: false, narrativeAvailable: true, accuracyRate: 100, inaccuraciesDiscarded: 2 }).caption), true);
check('accuracy without discards keeps the plain caption', /no flagged inaccuracy \(model judgement/.test(describeAccuracy({ degraded: false, narrativeAvailable: true, accuracyRate: 100 }).caption), true);

check('discarded claims are carried as unattributed, never as a clean zero', findingCounts({ degraded: false, narrativeAvailable: true, inaccuracies: [], omissions: [], inaccuraciesDiscarded: 2 })?.unattributed, 2);

// ---- the "Not counted" list --------------------------------------------------------------
const nc = (over: any = {}) => ({ degraded: false, narrativeAvailable: true, inaccuraciesDiscarded: 2, notCounted: [
  { kind: 'inaccuracy_claim' as const, text: 'Open until midnight', reason: 'no_such_question' as const },
  { kind: 'inaccuracy_claim' as const, text: 'Ships free', reason: 'engine_not_measured' as const },
], ...over });
check('nothing left out, nothing shown', notCountedView(nc({ inaccuraciesDiscarded: 0, notCounted: [] })), null);
check('a failed audit has no list (nothing was assessed)', [notCountedView(nc({ degraded: true })), notCountedView(nc({ narrativeAvailable: false }))], [null, null]);
const view = notCountedView(nc());
check('the strip says how many were not counted', view?.summary, '2 claims the analysis reported were not counted.');
check('each row keeps the model\'s words and gets a plain reason', view?.rows.map((r) => [r.text, /did not ask/.test(r.reason) || /did not measure/.test(r.reason)]), [['Open until midnight', true], ['Ships free', true]]);
check('the footer says none is verified and accuracy is an upper bound', /none of them is verified/.test(view?.footer || '') && /"at most"/.test(view?.footer || ''), true);
check('the singular reads correctly', notCountedView(nc({ inaccuraciesDiscarded: 1, notCounted: [nc().notCounted[0]] }))?.summary, '1 claim the analysis reported was not counted.');
check('rows are capped in the report, and the rest are still counted', [notCountedView(nc({ inaccuraciesDiscarded: 25, notCounted: Array(20).fill(nc().notCounted[0]) }))?.moreCount, notCountedView(nc())?.moreCount], [5, 0]);
check('an old saved audit with a count but no rows still shows the strip (and no invented rows)', [notCountedView(nc({ notCounted: undefined }))?.summary, notCountedView(nc({ notCounted: undefined }))?.rows.length, notCountedView(nc({ notCounted: undefined }))?.moreCount], ['2 claims the analysis reported were not counted.', 0, 2]);

console.log(failures === 0 ? '\nAll report view checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
