/**
 * compareReports (src/reportCompare.ts, docs/PLAN_2026-11.md P3), pure: every reason two audits are not comparable, empty and
 * one-question audits, a failed look-up on each side with its sources, a rival named only in a pair that failed in the other run,
 * identical runs. Run: npx tsx test/reportCompare.test.ts
 */
import { compareReports, notComparableSentence, COMPARE_CAVEAT, NOT_MEASURED_LABEL, EARLIER_DELETED_SENTENCE } from '../src/reportCompare';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(ok ? `pass  ${name}` : `FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}

type Ans = { text?: string; domains?: string[]; fail?: boolean };
/** One question per entry: the answers per engine. */
function report(answers: Record<string, Record<string, Ans>>, over: any = {}): any {
  return {
    id: 'a', createdAt: '2026-11-15T00:00:00Z', businessName: 'Poke House', domain: 'poke.house', competitors: ['Pokeworks'],
    metricVersion: 3, engineModels: { Gemini: 'gemini-x' }, degraded: false,
    queriesTested: Object.entries(answers).map(([q, engines], i) => ({
      id: `q${i}`, intent: 'direct_recommendation', queryText: q, targetPersona: 'Buyer',
      engines: Object.fromEntries(Object.entries(engines).map(([e, a]) => [e, { engine: e, status: a.fail ? 'retrieval_failed' : 'omitted', position: null, excerpt: '', citations: [] }])),
      evidence: Object.entries(engines).map(([e, a]) => ({
        engine: e, answerText: a.fail ? '' : a.text ?? '', error: a.fail ? 'failed' : undefined, searchQueries: [], capturedAt: 'x',
        citations: (a.domains || []).map((d) => ({ url: `https://${d}/x`, title: d, domain: d })),
      })),
    })),
    ...over,
  };
}
const Q1 = 'best poke in Austin';
const Q2 = 'poke house menu';

// ---- every reason it is not comparable
const base = report({ [Q1]: { Gemini: { text: '* **Poke House** is great.' } } });
const reasons = (b: any) => { const c: any = compareReports(base, b); return c.comparable ? null : c.reason; };
check('a different metricVersion', reasons({ ...base, metricVersion: 2 }), 'the counting rule changed, from version 3 to version 2');
check('a report with no metricVersion counts as version 1', reasons({ ...base, metricVersion: undefined }), 'the counting rule changed, from version 3 to version 1');
check('a different engine model', reasons({ ...base, engineModels: { Gemini: 'gemini-y' } }), 'the model changed, from Gemini gemini-x to Gemini gemini-y');
check('the earlier audit not having recorded the model', (compareReports({ ...base, engineModels: undefined }, base) as any).reason, 'the earlier audit did not record which model answered');
check('...and this audit not having recorded it', reasons({ ...base, engineModels: {} }), 'this audit did not record which model answered');
check('a different question list', reasons(report({ [Q1]: { Gemini: { text: 'x' } }, [Q2]: { Gemini: { text: 'y' } } })), 'the questions are not the same');
check('a different business name', reasons({ ...base, businessName: 'Other' }), 'the business name is different');
check('a different domain', reasons({ ...base, domain: 'other.com' }), 'the domain is different');
check('a different competitor list', reasons({ ...base, competitors: ['Sweetfin'] }), 'the list of competitors is different');
check('a degraded input is never compared', [reasons({ ...base, degraded: true }), (compareReports({ ...base, degraded: true }, base) as any).reason], ['one of the two audits did not complete', 'one of the two audits did not complete']);
check('questions that differ only in case and spacing are the same questions', reasons(report({ '  BEST poke   in austin ': { Gemini: { text: 'x' } } })), null);
check('an audit that holds no answers cannot be compared', (compareReports(base, { ...base, queriesTested: base.queriesTested.map((q: any) => ({ ...q, evidence: undefined })) }) as any).reason, 'an audit does not hold the answers it was measured from');
check('the sentence is exact', (compareReports(base, { ...base, metricVersion: 2 }) as any).sentence, 'These two audits were not measured the same way (the counting rule changed, from version 3 to version 2), so the difference is not shown as a change.');
check('the sentence builder', notComparableSentence('why'), 'These two audits were not measured the same way (why), so the difference is not shown as a change.');
check('the constants are exact', [COMPARE_CAVEAT, NOT_MEASURED_LABEL, EARLIER_DELETED_SENTENCE], ['Answer engines vary from run to run; a change in one answer is an observation, not a trend.', 'not measured in one of the two runs', 'The earlier audit this one was compared with has been deleted.']);

// ---- comparable: a worked example, by hand
{
  const prev = report({
    [Q1]: { Gemini: { text: 'Top picks: * **Sweetfin** - bowls.', domains: ['yelp.com', 'old.com'] } },
    [Q2]: { Gemini: { text: '* **Poke House** - menu.', domains: ['poke.house'] } },
  });
  const next = report({
    [Q1]: { Gemini: { text: 'Top picks: * **Poke House** - bowls. * **Pokeworks** - rival.', domains: ['yelp.com', 'new.com'] } },
    [Q2]: { Gemini: { text: '* **Sweetfin** - menu.', domains: ['poke.house'] } },
  });
  const c: any = compareReports(prev, next);
  check('comparable', c.comparable, true);
  check('two pairs in both runs: named before 1 of 2, named now 1 of 2 (counts, no percentage)', [c.pairsCompared, c.namedBefore, c.namedNow, 'percent' in c], [2, 1, 1, false]);
  check('per pair: the first question gained the brand, the second lost it', c.pairs.map((p: any) => [p.question, p.namedBefore, p.namedNow]), [[Q1, false, true], [Q2, true, false]]);
  check('sources that appeared and went, from the common pairs only', [c.sourcesAppeared, c.sourcesGone], [['new.com'], ['old.com']]);
  check('a rival named now and not before (tracked rival found by the matcher)', c.rivalsNew, ['Pokeworks']);
  check('nothing was unmeasured', c.notMeasured, []);
  check('the strip always carries the caveat', c.caveat, COMPARE_CAVEAT);
}

// ---- a failed look-up on one side: its sources and rivals never count
{
  const prev = report({
    [Q1]: { Gemini: { text: 'x * **Sweetfin**', domains: ['a.com'] } },
    [Q2]: { Gemini: { text: '* **Poke House**', domains: ['gone-only-because-failed.com'] } },
  });
  const next = report({
    [Q1]: { Gemini: { text: 'x * **Sweetfin**', domains: ['a.com'] } },
    [Q2]: { Gemini: { fail: true } },
  });
  const c: any = compareReports(prev, next);
  check('the pair that failed now is listed as not measured, with no other effect', [c.pairsCompared, c.notMeasured], [1, [{ question: Q2, engine: 'Gemini' }]]);
  check('...its earlier sources are NOT shown as gone', [c.sourcesGone, c.sourcesAppeared], [[], []]);
  const rev: any = compareReports(next, prev);
  check('the same when it failed in the earlier run: its new sources are not shown as appeared', [rev.sourcesAppeared, rev.notMeasured.length], [[], 1]);
}
// ---- a rival named only in a pair that failed in the other run is not "newly named"
{
  const prev = report({ [Q1]: { Gemini: { text: '* **Sweetfin**', domains: [] } }, [Q2]: { Gemini: { fail: true } } });
  const next = report({ [Q1]: { Gemini: { text: '* **Sweetfin**', domains: [] } }, [Q2]: { Gemini: { text: '* **Pokeworks** and * **Wild Tuna**', domains: ['z.com'] } } });
  const c: any = compareReports(prev, next);
  check('a rival named only in a pair that failed in the other run is not newly named', [c.rivalsNew, c.sourcesAppeared, c.pairsCompared, c.notMeasured.length], [[], [], 1, 1]);
}
// ---- identical, empty, one question
{
  const r = report({ [Q1]: { Gemini: { text: '* **Poke House**', domains: ['a.com'] } } });
  const c: any = compareReports(r, JSON.parse(JSON.stringify(r)));
  check('identical runs: nothing changed', [c.pairsCompared, c.namedBefore, c.namedNow, c.sourcesAppeared, c.sourcesGone, c.rivalsNew, c.notMeasured], [1, 1, 1, [], [], [], []]);
  const e: any = compareReports(report({}), report({}));
  check('two audits with no questions compare without dividing by anything', [e.comparable, e.pairsCompared, e.namedBefore, e.namedNow], [true, 0, 0, 0]);
  const allFailed: any = compareReports(report({ [Q1]: { Gemini: { fail: true } } }), report({ [Q1]: { Gemini: { fail: true } } }));
  check('every pair failed in both: zero compared, one listed as not measured', [allFailed.pairsCompared, allFailed.notMeasured.length], [0, 1]);
  const two: any = compareReports(report({ [Q1]: { Gemini: { text: 'a' }, ChatGPT: { text: '* **Poke House**' } } }), report({ [Q1]: { Gemini: { text: 'a' } } }));
  check('an engine present in only one run is not measured in both', [two.pairsCompared, two.notMeasured], [1, [{ question: Q1, engine: 'ChatGPT' }]]);
}

console.log(failures === 0 ? '\nReport comparison checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
