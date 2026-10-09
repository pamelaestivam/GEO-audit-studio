/**
 * Pure checks for how headline numbers are presented. Run: npx tsx test/reportView.test.ts
 *
 * Each maps to something a real browser run showed: a failed audit printing
 * "0%" and a green ring, "100% accuracy" after the analysis step failed, and a
 * single answer presented as a 100/100 score with no sample size.
 */
import {
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
  { inaccuracies: 0, omissions: 0 }
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

console.log(failures === 0 ? '\nAll report view checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
