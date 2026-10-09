/**
 * Deterministic checks for the analysis layer.
 * Run with: npx tsx test/analysis.test.ts
 */

import {
  buildBrandMatcher,
  findFirstMention,
  analyseAnswer,
  buildScorecards,
  buildCitationSourceMap,
  dedupeMatchers,
  extractCandidateVendors,
  extractDomain,
  attributeInaccuracies,
  computeAccuracyRate,
  queryNamesBrand,
  sourcesForBrand,
  type QueryEvidence,
} from '../src/analysis';
import { resolveCitationDomain, isPublisherDomain, dedupeCitations } from '../src/providers';

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

function evidence(partial: Partial<QueryEvidence> & { answerText: string }): QueryEvidence {
  return {
    queryId: 'q1',
    queryText: 'best payment providers',
    citations: [],
    searchQueries: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    engine: 'Gemini',
    ...partial,
  };
}

// ---------------------------------------------------------------- brand matching
const stripe = buildBrandMatcher('Stripe', 'stripe.com');
check('"striped shirt" is not a Stripe mention', findFirstMention('a striped shirt', stripe), -1);
check('lowercase "stripe" rejected for common-word brand', findFirstMention('a stripe of paint', stripe), -1);
check('capitalised "Stripe" accepted', findFirstMention('We recommend Stripe here', stripe) > 0, true);

const archer = buildBrandMatcher('Archer Aviation', 'archeraviation.com');
check('multiword brand matches full phrase', findFirstMention('Archer Aviation leads', archer), 0);
check('non-common brand matches case-insensitively', findFirstMention('see archer aviation', archer), 4);

// ---------------------------------------------------------------- ranking
const answer = evidence({
  answerText: 'The leading option is Adyen. PayPal is also popular, and Stripe is developer-focused.',
  citations: [
    { url: 'https://g2.com/x', title: 'G2 Payments', domain: 'g2.com' },
    { url: 'https://stripe.com/docs', title: 'Stripe Docs', domain: 'stripe.com' },
  ],
});

const matchers = [stripe, buildBrandMatcher('Adyen'), buildBrandMatcher('PayPal')];
const rows = analyseAnswer(answer, matchers);
const byBrand = Object.fromEntries(rows.map((r) => [r.brand, r]));
check('Adyen ranked first', byBrand['Adyen'].rank, 1);
check('PayPal ranked second', byBrand['PayPal'].rank, 2);
check('Stripe ranked third', byBrand['Stripe'].rank, 3);
check('Stripe detected as cited source', byBrand['Stripe'].citedAsSource, true);
check('Adyen not a cited source', byBrand['Adyen'].citedAsSource, false);
check('excerpt is verbatim from the answer', byBrand['Adyen'].excerpt, 'The leading option is Adyen.');

// Ranking must account for vendors the user never listed, or position is flattered.
const withDiscovered = analyseAnswer(answer, [stripe, buildBrandMatcher('Adyen')]);
check(
  'ranking only against tracked brands would flatter Stripe to #2',
  withDiscovered.find((r) => r.brand === 'Stripe')!.rank,
  2
);
check(
  'including the discovered vendor restores true position #3',
  byBrand['Stripe'].rank,
  3
);

// ---------------------------------------------------------------- scorecards
const scorecards = buildScorecards([rows], matchers);
check('share of voice splits across the three named brands', scorecards.find((s) => s.brand === 'Stripe')!.shareOfVoice, 33);
check('Stripe never named first', scorecards.find((s) => s.brand === 'Stripe')!.leaderShare, 0);
check('Adyen leads every query', scorecards.find((s) => s.brand === 'Adyen')!.leaderShare, 100);

// A brand absent from the answer scores zero rather than erroring.
const absentRows = analyseAnswer(answer, [buildBrandMatcher('Braintree')]);
check('absent brand is not mentioned', absentRows[0].mentioned, false);
check('absent brand has null rank', absentRows[0].rank, null);
check('absent brand scores 0 visibility', buildScorecards([absentRows], [buildBrandMatcher('Braintree')])[0].visibility, 0);

// Empty evidence set must not divide by zero.
check('no observations yields 0 not NaN', buildScorecards([], [stripe])[0].visibility, 0);
check('no observations yields 0 share of voice', buildScorecards([], [stripe])[0].shareOfVoice, 0);

// ---------------------------------------------------------------- citation sources
const sources = buildCitationSourceMap([answer], stripe);
check('two distinct domains captured', sources.length, 2);
check('client domain flagged as owned', sources.find((s) => s.domain === 'stripe.com')!.isOwned, true);
check('third-party not flagged owned', sources.find((s) => s.domain === 'g2.com')!.isOwned, false);
check('empty evidence yields empty source map', buildCitationSourceMap([], stripe).length, 0);

// ---------------------------------------------------------------- citation domain resolution
check('extractDomain strips www', extractDomain('https://www.example.com/a/b'), 'example.com');
check(
  'grounding redirect is not treated as a publisher',
  isPublisherDomain('vertexaisearch.cloud.google.com'),
  false
);
check(
  'publisher taken from title when url is a redirect',
  resolveCitationDomain('https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', 'g2.com'),
  'g2.com'
);
check(
  'redirect with a prose title resolves to nothing rather than Google',
  resolveCitationDomain('https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', 'Best Payment Providers | G2'),
  ''
);
check(
  'real url resolves normally when title is prose',
  resolveCitationDomain('https://www.g2.com/categories/payments', 'Best Payment Providers'),
  'g2.com'
);
check(
  'citations pointing only at redirects are dropped',
  dedupeCitations([
    { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', title: 'Some Article Title' },
  ]).length,
  0
);
check(
  'duplicate urls collapse to one citation',
  dedupeCitations([
    { url: 'https://g2.com/a', title: 'g2.com' },
    { url: 'https://g2.com/a', title: 'g2.com' },
  ]).length,
  1
);

// ---------------------------------------------------------------- matcher dedupe

const deduped = dedupeMatchers([
  buildBrandMatcher('Stripe', 'stripe.com'),
  buildBrandMatcher('Stripe, Inc.'),
  buildBrandMatcher('Adyen'),
  buildBrandMatcher('Adyen N.V.'),
]);
check('name variants collapse to one company each', deduped.map((m) => m.label), ['Stripe', 'Adyen']);

// The same company arriving twice (typed by the user and again from vendor
// discovery, once with a domain) would otherwise score the same sentence twice.
const dupMatchers = [buildBrandMatcher('Adyen'), buildBrandMatcher('Adyen', 'adyen.com'), stripe];
const dupRows = analyseAnswer(answer, dupMatchers);
check('duplicate matchers would inflate mention count', dupRows.filter((r) => r.mentioned).length, 3);
const cleanRows = analyseAnswer(answer, dedupeMatchers(dupMatchers));
check('dedupe restores one mention per company', cleanRows.filter((r) => r.mentioned).length, 2);
check(
  'dedupe keeps share of voice honest',
  buildScorecards([cleanRows], dedupeMatchers(dupMatchers)).find((s) => s.brand === 'Stripe')!.shareOfVoice,
  50
);

// ---------------------------------------------------------------- real-world brand names
// Regression: "Poke House" scored as present in any answer mentioning "poke
// bowls", because a multi-word brand also matched on its first word. Many small
// businesses lead with their category word.
const pokeHouse = buildBrandMatcher('Poke House', 'https://www.poke.house/');
check('a category word in a brand name is not a mention', findFirstMention('I love poke bowls near me.', pokeHouse), -1);
check('a capitalised category word is not a mention', findFirstMention('Poke bowls are trending.', pokeHouse), -1);
check('the full brand name is still matched', findFirstMention('Try Poke House downtown.', pokeHouse) >= 0, true);
check('a pasted URL is reduced to a bare host', pokeHouse.domain, 'poke.house');

const gymGroup = buildBrandMatcher('The Gym Group', 'thegymgroup.com');
check('a generic first word is not a mention', findFirstMention('Gym memberships vary widely.', gymGroup), -1);
check('the distinctive domain root still matches', findFirstMention('See thegymgroup for prices.', gymGroup) >= 0, true);

// Names containing regex metacharacters must never throw.
for (const raw of ["Ben & Jerry's", 'AT&T', "L'Occitane", 'C++ Institute', 'Café Nero', 'Yahoo!', '(Parens) Co']) {
  const m = buildBrandMatcher(raw);
  let ok = true;
  try {
    findFirstMention(`We recommend ${raw} for this.`, m);
  } catch {
    ok = false;
  }
  check(`"${raw}" is matched without throwing`, ok, true);
  check(`"${raw}" matches its own name`, findFirstMention(`We recommend ${raw} today.`, m) >= 0, true);
}

// Empty and malformed inputs must degrade quietly.
check('an empty brand name matches nothing', findFirstMention('anything', buildBrandMatcher('')), -1);
check('an empty brand yields no tokens', buildBrandMatcher('').tokens.length, 0);
check('a blank domain normalises to empty', buildBrandMatcher('Acme', '   ').domain, '');
check('a domain with a path is reduced to the host', buildBrandMatcher('Acme', 'acme.com/menu?x=1').domain, 'acme.com');
check('an uppercase URL normalises', buildBrandMatcher('Acme', 'HTTPS://WWW.ACME.COM/').domain, 'acme.com');

// ---------------------------------------------------------------- vendor extraction (no LLM)
// This replaced an LLM call that asked Gemini to list vendors and then
// re-verified every name against the source text anyway - meaning the model
// step never added information the text extraction below doesn't already
// derive directly, at zero Gemini quota cost.
// ---- Vendor discovery ----
//
// A capitalised word is not a vendor. These checks pin the rule that replaced
// "any capitalised phrase": a name must be in a structural position (bold, list
// head, heading, table cell) or be named at least twice.
check(
  'bulleted, bolded vendor names are found',
  extractCandidateVendors('* **Adyen** leads.\n* **PayPal** is popular.\n1. Stripe is developer-focused.', []),
  ['Adyen', 'PayPal', 'Stripe']
);
check(
  '"and" does not bridge two distinct entities into one wrong candidate',
  extractCandidateVendors(
    'Bank of America and Wells Fargo both offer this. Bank of America and Wells Fargo also lend.',
    []
  ),
  ['Bank of America', 'Wells Fargo']
);
check(
  '"&" within a single name is preserved',
  extractCandidateVendors('Johnson & Johnson is a major player. Johnson & Johnson leads.', []),
  ['Johnson & Johnson']
);
check(
  'a sentence-starter word is not swept into the candidate',
  extractCandidateVendors('However, Notion stands out. However, Notion wins.', []),
  ['Notion']
);
check(
  'an imperative verb leading into a name is excluded, not merged into it',
  extractCandidateVendors('Try Stripe for fast integration.', []).includes('Try Stripe'),
  false
);
check(
  'the client\'s own name is excluded from its own discovery',
  extractCandidateVendors('Stripe leads the market. Stripe is great.', [buildBrandMatcher('Stripe', 'stripe.com')]),
  []
);
check(
  'names repeated more often are ranked first',
  extractCandidateVendors('PayPal is ok. Adyen is good. Adyen is fast. PayPal is old. Adyen scales.', []),
  ['Adyen', 'PayPal']
);

// Regression: a realistic markdown answer about Austin poke restaurants used to
// yield 15 "vendors" - 13 of them junk - so the client's 33% share of voice
// read as 6% and "Pricing", "Key" and "Why" were reported as rivals.
const POKE_ANSWER = `For poke in Austin, top picks are:

* **Pokeworks** - consistently rated highest.
* **Sweetfin** - great vegan bowls.
* **Poke House** - solid fresh fish.

According to Yelp and TripAdvisor, Pricing starts at $12. Key takeaways: Fresh fish matters. Why choose Pokeworks? Check Monday hours.`;
const pokeClient = buildBrandMatcher('Poke House', 'poke.house');
check(
  'a realistic answer yields only the real rivals, not capitalised filler',
  extractCandidateVendors(POKE_ANSWER, [pokeClient]),
  ['Pokeworks', 'Sweetfin']
);
{
  const found = extractCandidateVendors(POKE_ANSWER, [pokeClient]);
  const matchers = dedupeMatchers([pokeClient, ...found.map((f) => buildBrandMatcher(f))]);
  const ev: QueryEvidence = {
    queryId: 'q', queryText: 'q', answerText: POKE_ANSWER, citations: [], searchQueries: [],
    capturedAt: '', engine: 'Gemini',
  };
  const cards = buildScorecards([analyseAnswer(ev, matchers)], matchers);
  check('the client\'s share of voice is 1 of 3 named vendors, not 1 of 16', cards[0].shareOfVoice, 33);
}
check(
  'a capitalised word named once in plain prose is not a vendor',
  extractCandidateVendors('Austin has many options. Hawaiian bowls are popular here.', []),
  []
);
check(
  'a capitalised word named twice is accepted as a vendor',
  extractCandidateVendors('Sweetfin is nearby. Many reviewers praise Sweetfin.', []),
  ['Sweetfin']
);
check(
  'weekdays and months are never vendors, even bolded or repeated',
  extractCandidateVendors('* **Monday** and Monday again, plus **January** and January.', []),
  []
);
check(
  'a bolded label word is not a vendor',
  extractCandidateVendors('**Pricing:** from $12. **Key takeaways:** fish matters.', []),
  []
);
check(
  'review sites and search engines are sources, not rivals',
  extractCandidateVendors('* **Yelp** lists it.\n* **Google Maps** shows hours.\n* **TripAdvisor** has reviews.', []),
  []
);
check(
  'Google Cloud is a vendor even though Google alone is a platform',
  extractCandidateVendors('* **Google Cloud** hosts it.', []),
  ['Google Cloud']
);
check(
  'a possessive collapses into the same vendor',
  extractCandidateVendors("* **Pokeworks** is great. Pokeworks's menu is wide.", []),
  ['Pokeworks']
);
check(
  'Monday.com is a vendor even though Monday is a weekday',
  extractCandidateVendors('* **Monday.com** handles project tracking.', []),
  ['Monday']
);
check(
  'a brand that genuinely ends in \'s keeps that spelling',
  extractCandidateVendors("* **Lowe's** stocks it. Lowe's is nearby.", []),
  ["Lowe's"]
);
check(
  'markdown table cells count as structural',
  extractCandidateVendors('| Vendor | Rating |\n| Adyen | 4.5 |\n| Stripe | 4.7 |', []),
  ['Adyen', 'Stripe']
);
check('empty text yields no candidates', extractCandidateVendors('', []), []);
check(
  'a very long answer does not throw and stays capped',
  extractCandidateVendors(Array.from({ length: 40 }, (_, i) => `Vendor${i} Inc is an option.`).join(' '), []).length <= 15,
  true
);


// ---- Per-brand citation sources
{
  const mk = (id: string, text: string, cites: string[]): QueryEvidence => ({
    queryId: id, queryText: id, answerText: text, engine: 'Gemini', capturedAt: '', searchQueries: [],
    citations: cites.map((d) => ({ url: `https://${d}/x`, title: d, domain: d })),
  });
  const e1 = mk('q1', 'Adyen is fast. Stripe is popular.', ['g2.com', 'stripe.com', 'g2.com']);
  const e2 = mk('q2', 'Only Adyen here.', ['reddit.com', 'g2.com']);
  const e3 = mk('q3', 'Nobody relevant.', ['forbes.com']);
  const ms = [buildBrandMatcher('Stripe', 'stripe.com'), buildBrandMatcher('Adyen', 'adyen.com')];
  const an = new Map(([e1, e2, e3] as QueryEvidence[]).map((e) => [e, analyseAnswer(e, ms)]));
  check('sources come only from answers that named the brand', sourcesForBrand([e1, e2, e3], an, 'Stripe', 'stripe.com'), ['g2.com']);
  check('a different brand gets its own list, most-cited first', sourcesForBrand([e1, e2, e3], an, 'Adyen', 'adyen.com'), ['g2.com', 'reddit.com', 'stripe.com']);
  check('a domain is counted once per answer even if cited twice', sourcesForBrand([e1], an, 'Adyen', 'adyen.com'), ['g2.com', 'stripe.com']);
  check("the brand's own domain is excluded", sourcesForBrand([e1, e2], an, 'Stripe', 'stripe.com').includes('stripe.com'), false);
  check('a brand named in no answer has no sources, not the audit-wide list', sourcesForBrand([e3], an, 'Stripe', 'stripe.com'), []);
  check('the limit is honoured', sourcesForBrand([e1, e2], an, 'Adyen', 'adyen.com', 1).length, 1);
  check('no evidence yields no sources', sourcesForBrand([], new Map(), 'Stripe', 'stripe.com'), []);
}


// ---- Does the QUESTION name the brand? (decides when "100% visible" is by construction)
{
  const named = (q: string, name: string, domain = '') => queryNamesBrand(q, buildBrandMatcher(name, domain));
  check('an ordinary mention', named('How much does Stripe cost?', 'Stripe', 'stripe.com'), true);
  check('lowercase typing', named('how much does stripe cost?', 'Stripe', 'stripe.com'), true);
  check('a short name (3M)', named('How much does 3M cost?', '3M'), true);
  check('a two-letter name (HP)', named('Is HP any good?', 'HP'), true);
  check('a common-word brand typed lowercase (notion)', named('how much does notion cost?', 'Notion', 'notion.so'), true);
  check('the domain root counts', named('is poke.house open late', 'Poke House', 'poke.house') && named('reviews of acme.com', 'The Acme Co', 'acme.com'), true);
  check('punctuation in a name', named("what is Ben & Jerry's best flavour", "Ben & Jerry's"), true);
  check('accented names', named('café zoë opening hours', 'Café Zoë'), true);
  check('a category question that does not contain the brand', named('best poke restaurants in Austin', 'Poke House', 'poke.house'), false);
  check('a competitor-only question', named('What are the best payments alternatives to Adyen?', 'Stripe', 'stripe.com'), false);
  check('a substring inside another word is not the brand', named('what is a striped shirt', 'Stripe', 'stripe.com'), false);
  check('an empty query', named('', 'Stripe'), false);
  check('a one-character brand is too ambiguous to claim', named('what is x', 'X'), false);
  // Documented limit: a brand that is also a category word is treated as named
  // (errs towards the caution appearing, not towards missing an inflated score).
  check('KNOWN LIMIT: a category-word brand ("Gym") counts as named by "best gym in Austin"', named('best gym in Austin', 'Gym'), true);
}

// ---------------------------------------------------------------- inaccuracy attribution
{
  const queries = [{ queryText: 'Best poke in Austin?' }, { queryText: 'poke cost' }, { queryText: 'poke cost' }];
  const answers = new Set(['0|Gemini', '1|Gemini', '2|Gemini']); // answers that name the brand
  const attr = (claims: any[], engines = ['Gemini'], keys = answers) => attributeInaccuracies(claims, queries, engines, keys);
  const where = (r: ReturnType<typeof attr>) => r.kept.map((k) => [k.queryIndex, k.engine]);

  check('an exact query text is matched', where(attr([{ queryText: 'Best poke in Austin?', engine: 'Gemini' }])), [[0, 'Gemini']]);
  check('case, spacing, quotes and trailing punctuation do not lose a claim', where(attr([
    { queryText: 'best poke in austin', engine: 'Gemini' },
    { queryText: '  "Best  poke in Austin"  ', engine: 'gemini' },
    { queryText: 'BEST POKE IN AUSTIN?!', engine: 'Gemini' },
  ])), [[0, 'Gemini'], [0, 'Gemini'], [0, 'Gemini']]);
  check('the query NUMBER wins, so duplicate or paraphrased query texts are not confused', where(attr([
    { queryNumber: 3, queryText: 'poke cost', engine: 'Gemini' },
    { queryNumber: 2, queryText: 'something else entirely', engine: 'Gemini' },
  ])), [[2, 'Gemini'], [1, 'Gemini']]);
  check('duplicate query text without a number is ambiguous and is discarded, not given to the first', attr([{ queryText: 'poke cost', engine: 'Gemini' }]).discarded, 1);
  check('a number outside the audit falls back to the text', where(attr([{ queryNumber: 9, queryText: 'Best poke in Austin?', engine: 'Gemini' }])), [[0, 'Gemini']]);
  check('a missing engine means the one engine that answered', where(attr([{ queryText: 'Best poke in Austin?' }])), [[0, 'Gemini']]);
  check('a number and a text that name DIFFERENT questions are not placed under a guess', attr([
    { queryNumber: 2, queryText: 'Best poke in Austin?', engine: 'Gemini' },
    { queryNumber: 3, queryText: 'Best poke in Austin?', engine: 'Gemini' },
  ]).discarded, 2);
  check('a number and a text that agree are kept', where(attr([{ queryNumber: 1, queryText: 'best poke in austin', engine: 'Gemini' }])), [[0, 'Gemini']]);
  check('a query never asked is discarded, not re-attributed', attr([{ queryText: 'not a query we asked', engine: 'Gemini' }]).discarded, 1);
  check('an engine never measured is discarded', attr([{ queryText: 'Best poke in Austin?', engine: 'ChatGPT' }]).discarded, 1);
  check('a non-string query and no number is discarded', attr([{ queryText: 42 as any, engine: 'Gemini' }]).discarded, 1);
  const two = attributeInaccuracies([{ queryText: 'Best poke in Austin?' }], queries, ['Gemini', 'Perplexity'], new Set(['0|Gemini', '0|Perplexity']));
  check('with several engines having answered, an unnamed engine cannot be attributed and is discarded', [two.kept.length, two.discarded], [0, 1]);
  const onlyOne = attributeInaccuracies([{ queryText: 'Best poke in Austin?' }], queries, ['Gemini', 'Perplexity'], new Set(['0|Perplexity']));
  check('...but if only one engine answered that query, an unnamed engine can only mean it', onlyOne.kept.map((k) => k.engine), ['Perplexity']);
  check('a claim about an answer that does not name the brand is discarded (the list and the accuracy rate must agree)', attr([{ queryText: 'poke cost', queryNumber: 2, engine: 'Gemini' }], ['Gemini'], new Set(['0|Gemini'])).discarded, 1);
  check('a model that returns a string instead of a list does not crash or count characters', attributeInaccuracies('none' as any, queries, ['Gemini'], answers), { kept: [], discarded: 0 });

  const mentioned = new Set(['0|Gemini', '1|Gemini']);
  check('accuracy counts answers, not claims: two claims on one of two mentioning answers is 50%', computeAccuracyRate(mentioned, ['0|Gemini', '0|Gemini']), 50);
  check('accuracy with no flagged answer is 100%', computeAccuracyRate(mentioned, []), 100);
  check('a flagged answer that did not mention the brand does not lower accuracy', computeAccuracyRate(mentioned, ['2|Gemini']), 100);
  check('accuracy is null (nothing to check) when no answer mentions the brand', computeAccuracyRate(new Set(), ['0|Gemini']), null);
  check('accuracy never goes below 0', computeAccuracyRate(new Set(['0|Gemini']), ['0|Gemini', '0|Gemini', '0|Gemini']), 0);
}

console.log(failures === 0 ? '\nAll analysis checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
