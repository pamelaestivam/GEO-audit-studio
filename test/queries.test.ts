/**
 * The standard queries are the literal questions asked of the answer engines.
 * Run: npx tsx test/queries.test.ts
 *
 * Regression for what a browser tour showed on the DEFAULT audit (no
 * competitors given): "Best software alternatives to  for modern teams" and
 * "Poke House vs  comparison" - an empty array interpolated into the question,
 * and "software" invented as the category of a restaurant.
 */
import { buildStandardQueries, DEFAULT_QUERY_COUNT } from '../src/queries';

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

const texts = (q: ReturnType<typeof buildStandardQueries>) => q.map((x) => x.queryText);
const clean = (q: ReturnType<typeof buildStandardQueries>) =>
  texts(q).every((t) => !/\s{2}|undefined|null|\[object|\[\]|\bto\s+for\b|\bvs\s+[:?]/.test(t) && !/^\s|\s$/.test(t));

// --- the default case: just a name
const bare = buildStandardQueries('Poke House', undefined, []);
check('the default is DEFAULT_QUERY_COUNT questions (two until audits can resume after a failure; never more than the ceiling of three the owner set)', [bare.length, DEFAULT_QUERY_COUNT, DEFAULT_QUERY_COUNT <= 3], [DEFAULT_QUERY_COUNT, 2, true]);
check('ids are distinct', new Set(bare.map((q) => q.id)).size, DEFAULT_QUERY_COUNT);
check('the discovery question always comes first (it is the one that can be written without the brand)', bare[0].intent, 'alternatives_search');
check('no blanks, doubled spaces or stringified empties with no competitor and no industry', clean(bare), true);
check('no category is invented for a business that gave none', texts(bare).some((t) => /software/i.test(t)), false);
check('no enterprise/SaaS framing is imposed on every business', texts(bare).some((t) => /enterprise|free tier|contract|modern teams|CTO|procurement/i.test(t)), false);
check('every query is a question', texts(bare).every((t) => t.endsWith('?')), true);
check('with no industry and no competitor, every query names the business (nothing else to anchor on)', texts(bare).every((t) => t.includes('Poke House')), true);
check('no competitor is named when none was given', texts(bare).some((t) => /\bvs\b/.test(t)), false);
check('the wording for no competitor reads naturally (the first DEFAULT_QUERY_COUNT of the priority order)', texts(bare), [
  'What are the best alternatives to Poke House?',
  'Is Poke House any good? How does it compare with its alternatives?',
  'How much does Poke House cost?',
].slice(0, DEFAULT_QUERY_COUNT));

// --- industry only
const withIndustry = buildStandardQueries('Poke House', 'poke restaurants', []);
check('an industry gives a brand-neutral discovery question', texts(withIndustry)[0], 'What are the best poke restaurants?');
check('...which does not name the business', texts(withIndustry)[0].includes('Poke House'), false);
check('...and the result is clean', clean(withIndustry), true);

// --- competitors in every shape the app can send
const asArray = buildStandardQueries('Stripe', 'payments', ['Adyen', 'PayPal']);
check('the first competitor is used (array)', texts(asArray)[0], 'What are the best payments alternatives to Adyen?');
check('...and the discovery question does not name the business', texts(asArray)[0].includes('Stripe'), false);
check('a competitor alone also gives a brand-neutral question', texts(buildStandardQueries('Stripe', '', ['Adyen']))[0], 'What are the best alternatives to Adyen?');
check('...and in the comparison', texts(asArray)[1], 'Stripe vs Adyen: which is better, and how do they compare?');
check('...and the result is clean', clean(asArray), true);
check('a comma-separated string works', texts(buildStandardQueries('Stripe', '', 'Adyen, PayPal'))[1], 'Stripe vs Adyen: which is better, and how do they compare?');
check('a lone string works', texts(buildStandardQueries('Stripe', '', 'Adyen'))[1], 'Stripe vs Adyen: which is better, and how do they compare?');
check('blank entries are skipped', texts(buildStandardQueries('Stripe', '', ['', '  ', 'Adyen']))[1], 'Stripe vs Adyen: which is better, and how do they compare?');
check('all-blank competitors behave as none', texts(buildStandardQueries('Stripe', '', ['', ' '])), texts(buildStandardQueries('Stripe', '', [])));
check('null and undefined behave as none', [texts(buildStandardQueries('Stripe', '', null)), texts(buildStandardQueries('Stripe', '', undefined))], [texts(buildStandardQueries('Stripe', '', [])), texts(buildStandardQueries('Stripe', '', []))]);
check('non-string competitor entries are ignored, not stringified', clean(buildStandardQueries('Stripe', '', [{}, 42, 'Adyen'] as any)), true);
check('whitespace around an industry is trimmed', texts(buildStandardQueries('Acme', '  payments  ', []))[0], 'What are the best payments?');

// --- awkward names pass through untouched
check('punctuation in a name is preserved', texts(buildStandardQueries("Ben & Jerry's", '', []))[1], "Is Ben & Jerry's any good? How does it compare with its alternatives?");
check('an empty name does not throw', buildStandardQueries('', '', []).length, DEFAULT_QUERY_COUNT);

console.log(failures === 0 ? '\nAll standard-query checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
