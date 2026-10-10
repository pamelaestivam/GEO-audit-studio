/**
 * The machine checks on a finished report (src/reportGuard.ts): no figure in the model's
 * written summary, and report invariants. Run with: npx tsx test/reportGuard.test.ts
 */
import { extractNumbers, splitSentences, containsFigure, guardSummary, assertReportInvariants } from '../src/reportGuard';

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
check('"one in four", "one out of 3", "only one answer" are figures', [extractNumbers('one in four'), extractNumbers('one out of 3'), extractNumbers('named in only one answer')], [[1, 4], [1, 3], [1]]);
check('"none of the answers" is a figure (zero)', extractNumbers('none of the answers named it'), [0]);
check('words that merely contain a number word are not figures', extractNumbers('Someone phoned; the stone is ironed; often won; the done deal.'), []);
check('no figures', extractNumbers('The brand is rarely recommended.'), []);
check('size-of-change words are figures with no value', extractNumbers('It will double, then triple; a tenfold rise; twice as many').map((n) => Number.isNaN(n)), [true, true, true, true]);
check('k / m / b suffixes are scaled', extractNumbers('12k visitors, 1.5m views, 2B'), [12000, 1500000, 2000000000]);
check('fullwidth and Arabic-Indic digits are digits', [extractNumbers('１２ percent'), extractNumbers('٣ of 5')], [[12], [3, 5]]);
check('fractions as words and as glyphs are figures', [extractNumbers('three quarters').length > 0, extractNumbers('⅔ of buyers').length > 0], [true, true]);
check('a digit run too long to be a number is still a figure', extractNumbers('9'.repeat(400)).length, 1);

// ---- sentence splitting -----------------------------------------------------------------
check('decimals do not split a sentence', splitSentences('Visibility is 33.5% today. It was lower.'), ['Visibility is 33.5% today.', 'It was lower.']);

// ---- identifiers are not figures ---------------------------------------------------------
const NAMES = ['Acme 3M Widgets', '7-Eleven', 'Five Guys', 'top 10 widget makers'];
check('a name the person typed with a digit in it is not a figure', containsFigure('Acme 3M Widgets leads the answers.', NAMES), false);
check('a rival the audit found ("7-Eleven") is not a figure', containsFigure('7-Eleven owns the answer surface.', NAMES), false);
check('a query the person typed is not a figure', containsFigure('Answers to top 10 widget makers favour rivals.', NAMES), false);
check('identifiers that start with letters (B2B, GPT-5, Q3) are not figures', containsFigure('In the B2B space GPT-5 style answers lag in Q3.'), false);
check('a calendar year is not a figure', containsFigure('Reviews from 2026 dominate the sources.'), false);
check('...but a year-looking number with a percent sign is', containsFigure('Up 2026%.'), true);
check('the same digits outside a name are a figure', containsFigure('Acme grows 3 times faster.', NAMES), true);

// ---- the guard -----------------------------------------------------------------------
// Independent corpus of known-bad phrasings (written by hand, not produced by the extractor).
const BAD = [
  'Traffic will double.', 'Sales tripled last year.', 'Expect a threefold rise.', 'A tenfold gain is possible.',
  'Twice as many buyers will find you.', 'A third of buyers will switch.', 'About a quarter of searches will change.',
  'Three quarters of answers omit you.', 'Grow 2% in a month.', 'Revenue is up 12k.', 'Expect 10K visitors.', 'Hit 1.5m impressions.',
  'It will improve by sixty percent.', 'Gain 47 percentage points.', 'There are ninety-nine problems.', 'Run it for 30 days.',
  'Fifty buyers asked.', 'It rose by nine.', 'Acme is named in 1 of 2 answers.', 'Acme appears in 0% of answers.',
  'Acme is named in 67% of answers.', 'Expect gains within 2 weeks.', 'Expect 2x traffic.', 'Acme was named in only one answer.',
  'None of the answers named it.', 'Rank in the top 3.', 'Results improve in six months.',
];
for (const sentence of BAD) check(`known-bad phrasing is removed: "${sentence}"`, guardSummary(sentence, NAMES).removed, 1);

const GOOD = [
  'Pokeworks leads the answers.', 'Competitors own the answer surface for comparison questions.', 'Acme 3M Widgets appears in the answers.',
  'In the B2B space the brand is rarely recommended.', '7-Eleven is the leading rival.', 'Reviews from 2026 dominate.',
  'The highest-leverage move is to earn coverage on review sites.', 'One of the leading tools is missing from the answers.',
];
for (const sentence of GOOD) check(`figure-free phrasing is kept: "${sentence}"`, guardSummary(sentence, NAMES).removed, 0);

let g = guardSummary('Visibility is poor. Expect traffic to grow 47% after the fix. Traffic will double. Pokeworks is the main rival.', NAMES);
check('sentences with figures are removed, the rest kept in order', g, { text: 'Visibility is poor. Pokeworks is the main rival.', removed: 2, total: 4 });
g = guardSummary('', NAMES);
check('empty text is fine', g, { text: '', removed: 0, total: 0 });
g = guardSummary(undefined as any, NAMES);
check('missing text is fine', g, { text: '', removed: 0, total: 0 });
g = guardSummary('Acme is named in 2 of 2 answers.', []);
check('a sentence repeating a measured figure is removed too (the server states them itself)', g.removed, 1);

// Property: nothing the guard keeps contains a figure by an independent, deliberately crude check
// (any digit, or any word on a hand-written list), and kept + removed = total.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const WORDS = ['brand', 'is', 'named', 'in', 'answers', 'about', 'roughly', 'only', 'of', 'the', 'and', 'visibility', 'leads', 'rivals'];
const NUMS = ['0', '7', '33', '47', '1,500', '3.5', 'three', 'four', 'twelve', 'forty', 'seventy-two', 'half', 'dozen', 'double', 'twice', 'tenfold', '12k'];
const CRUDE = /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|dozen|double|twice|triple|fold|tenfold|quarter|third)/i;
let propertyOk = true;
let removedAny = false;
let keptAny = false;
for (let i = 0; i < 400; i++) {
  const sentences: string[] = [];
  for (let s = 0; s < 1 + Math.floor(rand() * 4); s++) {
    const parts: string[] = [];
    for (let w = 0; w < 3 + Math.floor(rand() * 6); w++) {
      parts.push(rand() < 0.25 ? NUMS[Math.floor(rand() * NUMS.length)] : WORDS[Math.floor(rand() * WORDS.length)]);
    }
    sentences.push(`${parts.join(' ').replace(/^./, (c) => c.toUpperCase())}.`);
  }
  const out = guardSummary(sentences.join(' '), []);
  if (out.removed > 0) removedAny = true;
  if (out.text) keptAny = true;
  if (CRUDE.test(out.text)) propertyOk = false;
  if (out.removed + splitSentences(out.text).length !== out.total) propertyOk = false;
}
check('property (400 random summaries): nothing kept contains a digit or a number word by an independent crude check; kept + removed = total', [propertyOk, removedAny, keptAny], [true, true, true]);

// ---- invariants -----------------------------------------------------------------------
const report: any = {
  geoVisibilityScore: 33, shareOfVoice: 20, leaderShare: 0, accuracyRate: null, avgProminence: 40,
  queriesAttempted: 2, questionsAnswered: 2, queriesNamingBrand: 1, observationsAttempted: 3,
  observationsWithEvidence: 3, observationsMentioned: 1, inaccuraciesDiscarded: 0, narrativeAvailable: true,
  measuredEngines: ['Gemini'], enginesRequested: ['Gemini'], inaccuracies: [], omissions: [], remediationPlan: [],
  queriesTested: [{ id: 'q1' }, { id: 'q2' }],
  competitorBenchmarks: [{ shareOfVoice: 20 }, { shareOfVoice: 40 }],
};
const good = () => JSON.parse(JSON.stringify(report));
check('a consistent report has no violations', assertReportInvariants(good()), []);
check('a degraded report is not checked (it states no figures)', assertReportInvariants({ degraded: true, geoVisibilityScore: 999 }), []);
check('a missing report is a violation', assertReportInvariants(null).length, 1);

function violates(name: string, mutate: (r: any) => void, mention: RegExp) {
  const r = good();
  mutate(r);
  check(name, assertReportInvariants(r).some((m) => mention.test(m)), true);
}
violates('a percentage above 100', (r) => (r.shareOfVoice = 140), /shareOfVoice/);
violates('a negative percentage', (r) => (r.leaderShare = -1), /leaderShare/);
violates('a non-numeric percentage', (r) => (r.geoVisibilityScore = 'high'), /geoVisibilityScore/);
violates('a non-integer count', (r) => (r.observationsMentioned = 0.5), /observationsMentioned/);
violates('more usable answers than attempted', (r) => (r.observationsWithEvidence = 5), /usable answers/);
violates('named in more answers than were usable', (r) => (r.observationsMentioned = 4), /only 3 usable/);
violates('visibility that does not match its own numerator and denominator', (r) => (r.geoVisibilityScore = 80), /does not match 1 of 3/);
violates('visibility stated with no usable answer', (r) => { r.observationsWithEvidence = 0; r.observationsMentioned = 0; r.observationsAttempted = 3; r.geoVisibilityScore = 33; }, /no usable answer/);
violates('more questions answered than asked', (r) => (r.questionsAnswered = 9), /questions answered/);
violates('more questions naming the brand than asked', (r) => (r.queriesNamingBrand = 9), /name the brand/);
violates('a negative discarded count', (r) => (r.inaccuraciesDiscarded = -1), /inaccuraciesDiscarded/);
violates('an engine reported as measured that was never requested', (r) => (r.measuredEngines = ['Gemini', 'ChatGPT']), /ChatGPT/);
violates('answers counted with no measured engine', (r) => (r.measuredEngines = []), /no engine/);
violates('an inaccuracy about a question that is not in the audit', (r) => (r.inaccuracies = [{ id: 'inacc-1', engine: 'Gemini', queryId: 'zzz' }]), /not in this audit/);
violates('an inaccuracy about an engine that was not measured', (r) => (r.inaccuracies = [{ id: 'inacc-1', engine: 'Claude', queryId: 'q1' }]), /not measured/);
violates('an accuracy rate although the narrative did not run', (r) => { r.narrativeAvailable = false; r.accuracyRate = 100; }, /did not run/);
violates('findings although the narrative did not run', (r) => { r.narrativeAvailable = false; r.omissions = [{ id: 'om-1', affectedQueriesCount: 1 }]; }, /omissions has entries/);
violates('an omission affecting more questions than were asked', (r) => (r.omissions = [{ id: 'om-1', affectedQueriesCount: 47 }]), /affects 47 questions out of 2/);
violates('an omission with a non-integer count', (r) => (r.omissions = [{ id: 'om-1', affectedQueriesCount: 1.5 }]), /om-1/);
violates('shares of voice that add up to far more than 100', (r) => (r.competitorBenchmarks = [{ shareOfVoice: 90 }, { shareOfVoice: 90 }]), /add up to/);
check('an omission within range is fine', assertReportInvariants({ ...good(), omissions: [{ id: 'om-1', affectedQueriesCount: 2 }] }), []);
check('rounding slack in shares of voice is tolerated', assertReportInvariants({ ...good(), competitorBenchmarks: [{ shareOfVoice: 34 }, { shareOfVoice: 34 }, { shareOfVoice: 34 }] }), []);
check('a report that was never assessed (accuracy null, narrative off, no findings) is consistent', assertReportInvariants({ ...good(), narrativeAvailable: false, accuracyRate: null }), []);

console.log(failures === 0 ? '\nAll report guard checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
