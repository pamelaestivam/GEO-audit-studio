/**
 * The executive summary card, rendered to markup: decision A's sub-line, explainer and old-rule note are actually on
 * the page (the pure helpers are tested elsewhere; this fails if the JSX stops calling them).
 * Run: npx tsx test/citedOnlyUi.test.ts
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExecutiveSummaryCard } from '../src/components/ExecutiveSummaryCard';

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

const base: any = {
  id: 'a1', createdAt: '2026-10-10T00:00:00Z', businessName: 'Poke House', domain: 'poke.house', industry: '', coreOfferings: '', targetAudience: '',
  competitors: [], geoVisibilityScore: 50, shareOfVoice: 20, leaderShare: 0, accuracyRate: null, avgProminence: 40, executiveSummary: 'x',
  narrativeAvailable: true, queriesTested: [], inaccuracies: [], omissions: [], remediationPlan: [], competitorBenchmarks: [], citationSources: [],
  measuredEngines: ['Gemini'], queriesAttempted: 2, questionsAnswered: 2, observationsAttempted: 2, observationsWithEvidence: 2, observationsMentioned: 1,
};
const render = (audit: any) => renderToStaticMarkup(React.createElement(ExecutiveSummaryCard, { audit, onNavigate: () => undefined, onDelete: () => undefined } as any));

const current = render({ ...base, observationsCitedOnly: 1, metricVersion: 2 });
check('a current report with a cited-only answer shows the sub-line and its explainer (once as a tooltip, once in the visible text)', [/\+1 cite your site without naming you/.test(current), (current.match(/A cited source is not a mention/g) || []).length], [true, 2]);
check('...and no old-rule note', /earlier rule/.test(current), false);

const none = render({ ...base, observationsCitedOnly: 0, metricVersion: 2 });
check('a current report with none shows neither the sub-line nor a note', [/cite your site/.test(none), /earlier rule/.test(none)], [false, false]);

const old = render({ ...base });
check('a report saved before the rule change says it was measured under the earlier rule', /Measured under the earlier rule/.test(old), true);

const oldest = render({ ...base, observationsWithEvidence: undefined, observationsMentioned: undefined });
check('...even the oldest ones, which have no answer count', /Measured under the earlier rule/.test(oldest), true);

console.log(failures === 0 ? '\nAll cited-only UI checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
