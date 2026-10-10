/**
 * The machine checks on a finished report (src/reportGuard.ts): figures in written text
 * and report invariants. Run with: npx tsx test/reportGuard.test.ts
 */
import { extractNumbers, splitSentences, guardSummary, allowedFigures, assertReportInvariants } from '../src/reportGuard';

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

// ---- figures in text -----------------------------------------------------------------
check('digits, percentages, thousands separators and decimals', extractNumbers('Up 33% to 1,500 from 12.5.'), [33, 1500, 12.5]);
check('spelled-out figures count ("three of four")', extractNumbers('Three of four answers named it.'), [3, 4]);
check('compound spelled-out figures', extractNumbers('twenty-five answers, thirty one queries, ninety'), [25, 31, 90]);
check('scales and fractions are figures', extractNumbers('half of them, a dozen, two hundred'), [0.5, 12, 2, 100]);
check('"one" as a pronoun is not a figure', extractNumbers('One of the leading tools; no one disputes it; one can see why.'), []);
check('"one in four" and "one out of 3" are figures', [extractNumbers('one in four'), extractNumbers('one out of 3')], [[1, 4], [1, 3]]);
check('words that merely contain a number word are not figures', extractNumbers('Someone phoned; the stone is ironed; often won.'), []);
check('no figures', extractNumbers('The brand is rarely recommended.'), []);

// ---- sentence splitting -----------------------------------------------------------------
check('decimals do not split a sentence', splitSentences('Visibility is 33.5% today. It was lower.'), ['Visibility is 33.5% today.', 'It was lower.']);

// ---- the guard -----------------------------------------------------------------------
const report: any = {
  geoVisibilityScore: 33, shareOfVoice: 20, leaderShare: 0, accuracyRate: null, avgProminence: 40,
  queriesAttempted: 2, questionsAnswered: 2, queriesNamingBrand: 1, observationsAttempted: 3,
  observationsWithEvidence: 3, observationsMentioned: 1, inaccuraciesDiscarded: 0,
  measuredEngines: ['Gemini'], enginesRequested: ['Gemini'], inaccuracies: [], omissions: [], remediationPlan: [],
  competitors: ['A', 'B'], queriesTested: [{ id: 'q1' }, { id: 'q2' }], citationSources: [], untrackedRivals: [],
  competitorBenchmarks: [{ shareOfVoice: 20, topRecommendedCount: 0 }, { shareOfVoice: 40, topRecommendedCount: 1 }],
};
const allowed = allowedFigures(report, ['Acme 3M Widgets']);
check('computed figures are allowed', [33, 20, 40, 2, 3, 1].every((n) => allowed.has(n)), true);
check('plain arithmetic on them is allowed (67 = 100 - 33; 2 = 3 - 1)', [allowed.has(67), allowed.has(2)], [true, true]);
check('a figure the person typed is allowed (3M)', allowed.has(3), true);
check('an invented figure is not allowed', [allowed.has(47), allowed.has(12), allowed.has(95)], [false, false, false]);

let g = guardSummary('The brand is named in 1 of 3 answers. Expect 47% more traffic within three months. Pokeworks leads.', allowed);
check('the sentence with an invented figure is removed, the rest kept', g, { text: 'The brand is named in 1 of 3 answers. Pokeworks leads.', removed: 1, total: 3 });
g = guardSummary('Traffic will rise by sixty percent. Revenue may double in 9 weeks.', allowed);
check('spelled-out invented figures are caught as well as digits', [g.text, g.removed], ['', 2]);
g = guardSummary('The brand is rarely named and competitors dominate.', allowed);
check('prose with no figure passes untouched', g, { text: 'The brand is rarely named and competitors dominate.', removed: 0, total: 1 });
g = guardSummary('', allowed);
check('empty text is fine', g, { text: '', removed: 0, total: 0 });
g = guardSummary(undefined as any, allowed);
check('missing text is fine', g, { text: '', removed: 0, total: 0 });

// Property: whatever the model writes, no sentence with a figure outside the set survives.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const WORDS = ['brand', 'is', 'named', 'in', 'answers', 'about', 'roughly', 'only', 'twice', 'of', 'the', 'and', 'visibility'];
const NUMS = ['0', '1', '2', '3', '7', '12', '33', '47', '95', '100', '1,500', '3.5', 'three', 'four', 'twelve', 'forty', 'seventy-two', 'half', 'dozen', 'one in four'];
let propertyOk = true;
let removedAny = false;
for (let i = 0; i < 400; i++) {
  const sentences: string[] = [];
  for (let s = 0; s < 1 + Math.floor(rand() * 4); s++) {
    const parts: string[] = [];
    for (let w = 0; w < 3 + Math.floor(rand() * 6); w++) {
      parts.push(rand() < 0.25 ? NUMS[Math.floor(rand() * NUMS.length)] : WORDS[Math.floor(rand() * WORDS.length)]);
    }
    sentences.push(`${parts.join(' ').replace(/^./, (c) => c.toUpperCase())}.`);
  }
  const out = guardSummary(sentences.join(' '), allowed);
  if (out.removed > 0) removedAny = true;
  for (const n of extractNumbers(out.text)) if (!allowed.has(n)) propertyOk = false;
  if (out.removed + splitSentences(out.text).length !== out.total) propertyOk = false;
}
check('property (400 random summaries): no surviving sentence states a figure outside the computed set; kept + removed = total', [propertyOk, removedAny], [true, true]);

// ---- invariants -----------------------------------------------------------------------
const good = () => JSON.parse(JSON.stringify({ ...report, narrativeAvailable: true }));
check('a consistent report has no violations', assertReportInvariants(good()), []);
check('a degraded report is not checked (it states no figures)', assertReportInvariants({ degraded: true, geoVisibilityScore: 999 }), []);
check('a missing report is a violation', assertReportInvariants(null).length, 1);

function violates(name: string, mutate: (r: any) => void, mention: RegExp) {
  const r = good();
  mutate(r);
  const out = assertReportInvariants(r);
  check(name, out.some((m) => mention.test(m)), true);
}
violates('a percentage above 100', (r) => (r.shareOfVoice = 140), /shareOfVoice/);
violates('a negative percentage', (r) => (r.leaderShare = -1), /leaderShare/);
violates('a non-numeric percentage', (r) => (r.geoVisibilityScore = 'high'), /geoVisibilityScore/);
violates('more usable answers than attempted', (r) => (r.observationsWithEvidence = 5), /usable answers/);
violates('named in more answers than were usable', (r) => (r.observationsMentioned = 4), /only 3 usable/);
violates('visibility that does not match its own numerator and denominator', (r) => (r.geoVisibilityScore = 80), /does not match 1 of 3/);
violates('visibility stated with no usable answer', (r) => { r.observationsWithEvidence = 0; r.observationsMentioned = 0; r.observationsAttempted = 3; r.geoVisibilityScore = 33; }, /no usable answer/);
violates('more questions answered than asked', (r) => (r.questionsAnswered = 9), /questions answered/);
violates('an engine reported as measured that was never requested', (r) => (r.measuredEngines = ['Gemini', 'ChatGPT']), /ChatGPT/);
violates('answers counted with no measured engine', (r) => (r.measuredEngines = []), /no engine/);
violates('an inaccuracy about a question that is not in the audit', (r) => (r.inaccuracies = [{ id: 'inacc-1', engine: 'Gemini', queryId: 'zzz' }]), /not in this audit/);
violates('an inaccuracy about an engine that was not measured', (r) => (r.inaccuracies = [{ id: 'inacc-1', engine: 'Claude', queryId: 'q1' }]), /not measured/);
violates('an accuracy rate although the narrative did not run', (r) => { r.narrativeAvailable = false; r.accuracyRate = 100; }, /did not run/);
violates('findings although the narrative did not run', (r) => { r.narrativeAvailable = false; r.omissions = [{}]; }, /omissions has entries/);
violates('shares of voice that add up to far more than 100', (r) => (r.competitorBenchmarks = [{ shareOfVoice: 90 }, { shareOfVoice: 90 }]), /add up to/);
check('rounding slack in shares of voice is tolerated', assertReportInvariants({ ...good(), competitorBenchmarks: [{ shareOfVoice: 34 }, { shareOfVoice: 34 }, { shareOfVoice: 34 }] }), []);
check('a report that was never assessed (accuracy null, narrative off, no findings) is consistent', assertReportInvariants({ ...good(), narrativeAvailable: false, accuracyRate: null }), []);

console.log(failures === 0 ? '\nAll report guard checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
