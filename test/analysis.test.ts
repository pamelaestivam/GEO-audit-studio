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
  extractDomain,
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

console.log(failures === 0 ? '\nAll analysis checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
