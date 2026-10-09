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

console.log(failures === 0 ? '\nAll report view checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
