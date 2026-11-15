/**
 * The searched-or-not rule (src/searchedAnswer.ts) and the sentences that go with it (src/errors.ts). Pure: no server, no model.
 * Run: npx tsx test/searchedAnswer.test.ts
 */
import { geminiSearched } from '../src/searchedAnswer';
import { NOT_SEARCHED_MESSAGE, DEGRADED_HINT, summariseFailures } from '../src/errors';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(ok ? `pass  ${name}` : `FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}

check('a reply with a web search query was searched', geminiSearched({ webSearchQueries: ['best poke austin'] }), true);
check('a reply with a grounding chunk was searched', geminiSearched({ groundingChunks: [{ web: { uri: 'https://a.test', title: 'a' } }] }), true);
check('both is searched', geminiSearched({ webSearchQueries: ['q'], groundingChunks: [{}] }), true);
check('no metadata at all is not searched', [geminiSearched(undefined), geminiSearched(null)], [false, false]);
check('empty lists are not searched', geminiSearched({ webSearchQueries: [], groundingChunks: [] }), false);
check('metadata with neither field (only support spans, say) is not searched', geminiSearched({ groundingSupports: [{ segment: {} }] }), false);
check('a field that is not a list does not count', [geminiSearched({ webSearchQueries: 'q' }), geminiSearched({ groundingChunks: { length: 3 } }), geminiSearched('yes'), geminiSearched(7)], [false, false, false, false]);

check('the not-searched sentence is exact', NOT_SEARCHED_MESSAGE, 'Gemini answered without searching the web, so the answer was not counted. Run it again; if it keeps happening, the model is not searching for this question.');
check('the hint sentence is exact', DEGRADED_HINT, 'If this happens on every audit, the model this server uses may have no free web search on this key. The rate-limit page in Google AI Studio shows the search allowance for the model.');

const ns = { kind: 'not_searched' as const, message: NOT_SEARCHED_MESSAGE };
check('when every failure is the not-searched kind, the audit reason is that sentence', summariseFailures([ns, ns]).message, NOT_SEARCHED_MESSAGE);
check('not-searched ranks above unknown', summariseFailures([{ kind: 'unknown', message: 'u' }, ns]).kind, 'not_searched');
check('...and below every provider failure', summariseFailures([ns, { kind: 'timeout', message: 't' }]).kind, 'timeout');

console.log(failures === 0 ? '\nSearched-answer checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
