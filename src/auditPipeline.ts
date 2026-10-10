/**
 * The pure middle of an audit (docs/PLAN_STEP_E.md, slice S1): turn captured evidence into an analysis,
 * and an analysis plus the model's narrative into a report. No network, no store, no model call, so the
 * same evidence always gives the same report and a step-wise engine can run these between steps.
 *
 * Moved out of server.ts without changing a string, a figure or the order of rows; the golden-report test
 * (test/auditGoldenE2E.test.ts, captured from the server before the move) is what proves that.
 * Time and a random suffix are the only impure inputs, used for the report id and timestamp.
 */
import crypto from 'crypto';
import {
  analyseAnswer,
  attributeInaccuracies,
  buildBrandMatcher,
  buildCitationSourceMap,
  buildScorecards,
  computeAccuracyRate,
  dedupeMatchers,
  extractCandidateVendors,
  normaliseDomain,
  notCountedItems,
  queryNamesBrand,
  sourcesForBrand,
  type QueryEvidence,
} from './analysis.js';
import { endSentence } from './errors.js';
import { engineModelId, type EngineName } from './providers.js';
import { assertReportInvariants, containsFigure, guardSummary } from './reportGuard.js';

/**
 * Vendors the answers actually named, found with zero model calls. This used to ask Gemini to list vendors
 * and then verify every returned name literally occurs in the source text, so the model's answer was being
 * fully re-derived from the text anyway. That verification alone (extractCandidateVendors) is enough, and
 * removing the call took one Gemini request out of every audit: it was the largest reason a one-query
 * audit cost far more than one query's worth of quota (TECH_DEBT 2.6a). First-seen casing is kept.
 */
export function discoverVendors(evidenceForQuery: QueryEvidence[], excludeMatchers: any[]): string[] {
  const usable = evidenceForQuery.filter(isUsableEvidence);
  if (usable.length === 0) return [];

  // Merge candidates across every answer, keeping the first-seen casing
  // for each distinct name rather than collapsing to a lowercase key.
  const byKey = new Map<string, string>();
  for (const ev of usable) {
    for (const candidate of extractCandidateVendors(ev.answerText, excludeMatchers)) {
      const key = candidate.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}

/** An answer counts only if it did not fail and says something. The one definition. */
export function isUsableEvidence(e: QueryEvidence): boolean {
  return !e.error && e.answerText.trim().length > 0;
}

/** What was asked for, cleaned: the same input always plans the same audit. */
export interface AuditPlan {
  businessName: string;
  cleanDomain: string;
  industry: any;
  coreOfferings: any;
  targetAudience: any;
  competitorList: string[];
  queryList: any[];
}

/**
 * Turn the request body into the audit to run: the bare host of the domain, the competitors that are
 * real strings, and the questions (the person's own, or the template ones when none were given). Pure.
 * `fallbackQueries` is injected because the template questions live with the server's other templates.
 */
export function planAudit(
  body: any,
  deps: {
    fallbackQueries: (businessName: string, cleanDomain: string, industry: any, coreOfferings: any, competitorList: string[]) => any[];
    maxQueries: number;
  }
): AuditPlan | { error: string; badRequest: true } {
  const { businessName, domain, industry, coreOfferings, targetAudience, competitors, queries } = body;

  if (!businessName) {
    return { error: 'businessName is required', badRequest: true };
  }

  // Users paste full URLs into the domain field; store the bare host so
  // links render correctly and source matching compares like with like.
  const cleanDomain = normaliseDomain(domain || '');
  const competitorList = (Array.isArray(competitors) ? competitors : [competitors])
    .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
    .map((c: string) => c.trim());

  const suppliedQueries = Array.isArray(queries) ? queries.filter((q: any) => q?.queryText) : [];

  // Template-generated, not a Gemini call: a one-query audit should cost
  // one query's worth of quota, not one call to invent the query on top
  // of it. The LLM-authored version of this (generateAuditQueries) is
  // still available, but only behind the explicit "Generate Query
  // Matrix" step in the Run Audit modal - a deliberate spend the user
  // opted into, not something every default audit pays silently.
  const generatedQueries =
    suppliedQueries.length === 0 ? deps.fallbackQueries(businessName, cleanDomain, industry, coreOfferings, competitorList) : [];

  const queryList = [...generatedQueries, ...suppliedQueries].slice(0, deps.maxQueries);

  return { businessName, cleanDomain, industry, coreOfferings, targetAudience, competitorList, queryList };
}

/** What the deterministic analysis of the usable evidence produced. */
export interface EvidenceAnalysis {
  allEvidence: QueryEvidence[];
  usableEvidence: QueryEvidence[];
  clientMatcher: ReturnType<typeof buildBrandMatcher>;
  clientLabel: string;
  discovered: string[];
  analysisByEvidence: Map<QueryEvidence, ReturnType<typeof analyseAnswer>>;
  scorecards: ReturnType<typeof buildScorecards>;
  citationSources: ReturnType<typeof buildCitationSourceMap>;
  clientScore: ReturnType<typeof buildScorecards>[number];
  totalObservations: number;
  measuredEngines: string[];
  /** Which query each captured answer belongs to, so the narrative can cite it by number. */
  queryNumberOf: Map<QueryEvidence, number>;
}

/** Layer 2: deterministic analysis over successful evidence only. Pure. */
export function analyseEvidence(input: {
  businessName: string;
  cleanDomain: string;
  competitorList: string[];
  evidenceByQuery: QueryEvidence[][];
}): EvidenceAnalysis {
  const { businessName, cleanDomain, competitorList, evidenceByQuery } = input;
  const allEvidence = evidenceByQuery.flat();
  const usableEvidence = allEvidence.filter(isUsableEvidence);

  const clientMatcher = buildBrandMatcher(businessName, cleanDomain);
  const clientLabel = clientMatcher.label;

  // Discover the vendors each answer actually named, so ranking is against
  // the real field rather than only the competitors the user typed. Pure
  // text extraction, not a model call - see discoverVendors.
  const trackedMatchers = competitorList.map((c: string) => buildBrandMatcher(c));
  const discovered = discoverVendors(usableEvidence, [clientMatcher, ...trackedMatchers]);
  const discoveredMatchers = discovered.map((d) => buildBrandMatcher(d));
  // Collapse name variants ("Stripe" vs "Stripe, Inc.") so one company
  // cannot occupy two ranks or double-count in share of voice.
  const allMatchers = dedupeMatchers([clientMatcher, ...trackedMatchers, ...discoveredMatchers]);

  const analysisByEvidence = new Map<QueryEvidence, ReturnType<typeof analyseAnswer>>();
  const perObservation = usableEvidence.map((ev) => {
    const rows = analyseAnswer(ev, allMatchers);
    analysisByEvidence.set(ev, rows);
    return rows;
  });

  const scorecards = buildScorecards(perObservation, allMatchers);
  const citationSources = buildCitationSourceMap(usableEvidence, clientMatcher);
  const clientScore = scorecards[0];
  const totalObservations = perObservation.length;
  const measuredEngines = Array.from(new Set(usableEvidence.map((e) => e.engine)));

  const queryNumberOf = new Map<QueryEvidence, number>();
  evidenceByQuery.forEach((group, qi) => group.forEach((ev) => queryNumberOf.set(ev, qi)));

  return {
    allEvidence,
    usableEvidence,
    clientMatcher,
    clientLabel,
    discovered,
    analysisByEvidence,
    scorecards,
    citationSources,
    clientScore,
    totalObservations,
    measuredEngines,
    queryNumberOf,
  };
}

/** The result of assembling: a report, and `degraded` when it is a failed audit that shows no findings. */
export interface AssembledAudit {
  report: any;
  degraded?: true;
}

/**
 * Layer 4: assemble an honest report from the analysis and the narrative, run the summary guard, and run
 * the consistency check. A report whose own figures contradict each other is returned as a failed audit.
 * `failedShape` builds the shape of a failed audit (it lives with the server's fallback code).
 */
export function assembleReport(input: {
  businessName: string;
  cleanDomain: string;
  industry?: string;
  coreOfferings?: string;
  targetAudience?: string;
  competitorList: string[];
  queryList: any[];
  engines: EngineName[];
  evidenceByQuery: QueryEvidence[][];
  analysis: EvidenceAnalysis;
  narrative: any;
  /** Why the qualitative analysis is missing, or null when it ran. */
  narrativeFailure: string | null;
  /** Test-only: report a consistency violation (AUDIT_FORCE_INVARIANT_VIOLATION). */
  forceViolation?: boolean;
  failedShape: () => any;
}): AssembledAudit {
  const {
    businessName, cleanDomain, industry, coreOfferings, targetAudience, competitorList, queryList,
    engines, evidenceByQuery, analysis, narrative, narrativeFailure, failedShape,
  } = input;
  const {
    allEvidence, usableEvidence, clientMatcher, clientLabel, discovered, analysisByEvidence,
    scorecards, citationSources, clientScore, totalObservations, measuredEngines,
  } = analysis;
  const narrativeAvailable = narrativeFailure === null;

  // ---------- Layer 4: assemble an honest report ----------
  // How many of the questions asked name the brand outright (see
  // queryNamesBrand): the report says so, because for those the answer is
  // about the brand whatever the engine thinks of it.
  const queriesNamingBrand = queryList.filter((q: any) => queryNamesBrand(q.queryText || '', clientMatcher)).length;

  const queriesTested = queryList.map((q: any, idx: number) => {
    const group = evidenceByQuery[idx] || [];
    const engineResults: Record<string, any> = {};
    let bestProminence = 0;
    const aheadUnion = new Set<string>();

    for (const ev of group) {
      const rows = analysisByEvidence.get(ev);

      if (!rows) {
        engineResults[ev.engine] = {
          engine: ev.engine,
          status: 'retrieval_failed',
          position: null,
          excerpt: `${endSentence(`No answer captured from ${ev.engine}${ev.error ? `: ${ev.error}` : ''}`)} This query was excluded from all metrics.`,
          citations: [],
        };
        continue;
      }

      const client = rows.find((r) => r.brand === clientLabel);
      const ahead = rows
        .filter((r) => r.rank && (!client?.rank || r.rank < client.rank))
        .sort((a, b) => (a.rank || 0) - (b.rank || 0))
        .map((r) => r.brand);
      ahead.forEach((b) => aheadUnion.add(b));
      bestProminence = Math.max(bestProminence, client?.prominence ?? 0);

      engineResults[ev.engine] = {
        engine: ev.engine,
        status: !client || !client.mentioned
          ? 'omitted'
          : client.rank === 1
            ? 'recommended_leader'
            : 'secondary_mention',
        position: client?.rank ?? null,
        excerpt:
          client?.excerpt ||
          `${businessName} was not named. Vendors named instead: ${ahead.join(', ') || 'none identified'}.`,
        citations: ev.citations.map((c) => c.url),
        keyOmissionReason:
          !client?.mentioned && ahead.length > 0
            ? `Answer surface taken by: ${ahead.slice(0, 5).join(', ')}`
            : undefined,
      };
    }

    return {
      ...q,
      engines: engineResults,
      evidence: group.map((ev) => ({
        engine: ev.engine,
        answerText: ev.answerText,
        citations: ev.citations,
        searchQueries: ev.searchQueries,
        capturedAt: ev.capturedAt,
        error: ev.error,
      })),
      competitorsAhead: Array.from(aheadUnion),
      prominence: bestProminence,
    };
  });

  // Which captured answers exist, and which of them name the brand, keyed by
  // (query index, engine) - the unit the accuracy rate is a rate of.
  const mentionedKeys = new Set<string>();
  evidenceByQuery.forEach((group, qi) => {
    for (const ev of group) {
      const rows = analysisByEvidence.get(ev);
      if (!rows) continue;
      if (rows.find((r) => r.brand === clientLabel)?.mentioned) mentionedKeys.add(`${qi}|${ev.engine}`);
    }
  });
  const { kept: attributed, discarded: inaccuraciesDiscarded, discardedClaims } = attributeInaccuracies<any>(
    narrative?.inaccuracies || [],
    queryList,
    measuredEngines,
    mentionedKeys
  );
  const inaccuracies = attributed.map(({ claim: item, queryIndex, engine }, i: number) => ({
    id: `inacc-${i + 1}`,
    engine,
    queryId: queryList[queryIndex].id,
    queryText: queryList[queryIndex].queryText,
    claimedFact: item.claimedFact,
    actualFact: item.actualFact,
    impactSeverity: ['high', 'medium', 'low'].includes(item.impactSeverity) ? item.impactSeverity : 'medium',
    sourceOriginUrl: item.sourceOriginUrl,
  }));

  // Accuracy is only meaningful where the brand was actually discussed, and
  // only where the qualitative analysis actually ran. Counted per answer.
  const accuracyRate = narrativeAvailable
    ? computeAccuracyRate(mentionedKeys, attributed.map((a) => `${a.queryIndex}|${a.engine}`))
    : null;

  const untrackedRivals = scorecards
    .filter((s) => discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()))
    .filter((s) => s.timesMentioned > 0)
    .sort((a, b) => b.shareOfVoice - a.shareOfVoice)
    .slice(0, 8)
    .map((s) => s.brand);

  // Questions that got a usable answer in which the brand was named by no engine: what an omission
  // "affects" when the model's own count is missing or impossible. Computed, not guessed.
  const unnamedQuestions = evidenceByQuery.filter(
    (group, qi) =>
      group.some(isUsableEvidence) && !group.some((ev) => mentionedKeys.has(`${qi}|${ev.engine}`))
  ).length;

  // Strings whose digits are not "figures": what the person typed and what the audit found.
  const guardNames: string[] = [
    businessName, cleanDomain, industry, coreOfferings, targetAudience,
    ...competitorList, ...discovered, ...scorecards.map((s) => s.brand),
    ...queryList.map((q: any) => q.queryText || ''),
  ].map((v) => String(v ?? ''));

  const report = {
    id: `audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    createdAt: new Date().toISOString(),
    businessName,
    domain: cleanDomain,
    industry: industry || '',
    // Blank stays blank. These used to default to "Products and services" /
    // "Buyers and decision makers" - a guess rendered in the report as if
    // it were something the client said about themselves.
    coreOfferings: coreOfferings || '',
    targetAudience: targetAudience || '',
    competitors: competitorList,

    // Metrics computed in code from captured evidence.
    geoVisibilityScore: clientScore.visibility,
    shareOfVoice: clientScore.shareOfVoice,
    leaderShare: clientScore.leaderShare,
    accuracyRate,
    // Model-reported claims that could not be tied to a captured answer and were left out.
    inaccuraciesDiscarded,
    // What was left out, in the model's words and with the reason, so "not counted" can be inspected.
    notCounted: notCountedItems(discardedClaims),
    avgProminence: clientScore.avgProminence,

    // Filled in below, once the figures it may state are known.
    executiveSummary: '',

    // Whether the qualitative analysis ran. The three arrays below are
    // empty when it did not, and an empty array must not read as "none found".
    narrativeAvailable,
    narrativeNote: narrativeAvailable
      ? undefined
      : `${endSentence(narrativeFailure as string)} Visibility, share of voice and the evidence below are measured; accuracy, omissions and the remediation plan were not assessed. Re-run the audit to try again.`,

    queriesTested,
    inaccuracies,
    omissions: (narrative?.omissions || []).map((o: any, i: number) => ({
      id: `om-${i + 1}`,
      category: o.category,
      description: o.description,
      // A model-supplied count is bounded by the number of questions actually asked; a missing or
      // impossible one is replaced by the number of answered questions that never named the brand.
      affectedQueriesCount:
        Number.isInteger(o.affectedQueriesCount) && o.affectedQueriesCount >= 0 && o.affectedQueriesCount <= queryList.length
          ? o.affectedQueriesCount
          : unnamedQuestions,
      rootCause: o.rootCause,
      recommendation: o.recommendation,
    })),
    remediationPlan: (narrative?.remediationPlan || []).map((t: any, i: number) => ({
      id: `rem-${i + 1}`,
      title: t.title,
      category: t.category,
      priority: t.priority,
      effort: t.effort,
      // Free text from the model that states a figure ("+40% visibility in 30 days") is a forecast
      // nobody measured: it is replaced by the plain default.
      expectedGain:
        t.expectedGain && !containsFigure(String(t.expectedGain), guardNames) ? t.expectedGain : 'Improved answer-engine citation rate',
      description: t.description,
      stepByStepInstructions: t.stepByStepInstructions || [],
      codeSnippet: t.codeSnippet,
      targetUrls: t.targetUrls || [],
      completed: false,
    })),

    competitorBenchmarks: scorecards
      .filter((s) => s.brand === clientLabel || s.timesMentioned > 0)
      .map((s) => ({
        name: s.brand === clientLabel ? `${s.brand} (Your Business)` : s.brand,
        domain: s.domain || '',
        shareOfVoice: s.shareOfVoice,
        topRecommendedCount: s.timesFirst,
        // Sources cited where THIS brand was named - not the audit-wide list.
        mainCitationSources: sourcesForBrand(usableEvidence, analysisByEvidence, s.brand, s.domain),
        discovered: discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()),
      })),

    citationSources,
    measuredEngines,
    // The model id each measured engine was queried with, and when the answers
    // were captured: a number from a model cannot be compared or reproduced
    // without them.
    engineModels: Object.fromEntries(measuredEngines.map((e) => [e, engineModelId(e as EngineName)])),
    answersCapturedFrom: usableEvidence.map((e) => e.capturedAt).sort()[0],
    answersCapturedTo: usableEvidence.map((e) => e.capturedAt).sort().slice(-1)[0],
    untrackedRivals,
    queriesAttempted: queryList.length,
    // Questions that produced at least one usable answer: the independent readings behind
    // the headline (a planned question that failed everywhere, or was never reached after
    // the quota breaker tripped, is not a reading).
    questionsAnswered: evidenceByQuery.filter((group) => group.some(isUsableEvidence)).length,
    queriesNamingBrand,
    observationsAttempted: allEvidence.length,
    observationsWithEvidence: usableEvidence.length,
    // Numerator behind geoVisibilityScore, so the UI can show "1 of 3".
    observationsMentioned: clientScore.timesMentioned,
    enginesRequested: engines,
  };

  // The model writes the qualitative summary; the figures come from the measurements, stated
  // by the server in the first sentence. A model sentence that states ANY figure is removed and
  // the removal is said, never hidden (docs/RELIABILITY.md section 4). Digits inside names the
  // person typed or the audit found ("3M", "7-Eleven", a query "top 10 ...") are not figures.
  const factualSentence = `${businessName} was named in ${clientScore.timesMentioned} of ${totalObservations} answers captured across ${measuredEngines.join(', ')} (${clientScore.visibility}% visibility), holding ${clientScore.shareOfVoice}% share of voice against every vendor the engines named.`;
  const guarded = narrativeAvailable
    ? guardSummary(typeof narrative?.executiveSummary === 'string' ? narrative.executiveSummary : '', guardNames)
    : null;
  report.executiveSummary = [
    factualSentence,
    guarded ? guarded.text : 'The qualitative analysis (inaccuracies, omissions, remediation plan) could not be generated, so none of it is reported here.',
  ]
    .filter(Boolean)
    .join(' ');
  if (guarded && guarded.removed > 0) {
    (report as any).summaryNote = `${guarded.removed} ${guarded.removed === 1 ? 'sentence' : 'sentences'} from the written summary ${guarded.removed === 1 ? 'was' : 'were'} removed because ${guarded.removed === 1 ? 'it' : 'they'} appeared to state a figure we could not verify. Only the figures in the first sentence are measured.`;
    console.warn(`[guard] removed ${guarded.removed} of ${guarded.total} summary sentences that stated a figure`);
  }

  // A report whose own figures contradict each other is a bug in this code, not a finding
  // about the client. It is never shown as done: the person gets a failed audit that says
  // so (not billable, not saved) and the violation is logged for the owner.
  // AUDIT_FORCE_INVARIANT_VIOLATION=1 is a test-only switch (like GEMINI_BASE_URL) that makes the
  // check report a violation, so the end-to-end test can prove the failure path. Unset everywhere real.
  const violations = input.forceViolation ? ['forced by the test switch'] : assertReportInvariants(report);
  if (violations.length > 0) {
    console.error(`[invariant] report failed ${violations.length} consistency check(s): ${violations.join('; ')}`);
    const failed = failedShape();
    return {
      report: {
        ...failed,
        // The answers WERE collected: the cells must not claim a retrieval failure that did not happen.
        queriesTested: failed.queriesTested.map((q: any) => ({
          ...q,
          engines: Object.fromEntries(
            Object.entries(q.engines).map(([name, cell]: [string, any]) => [
              name,
              { ...cell, excerpt: `Answers were collected from ${name}, but this audit's figures failed a consistency check, so no result is shown.` },
            ])
          ),
        })),
        degraded: true,
        executiveSummary:
          'This audit finished collecting answers, but its figures failed an internal consistency check, so none of them are shown and nothing here is a measurement.',
        degradedReason:
          'This audit finished, but its figures failed an internal consistency check, so none of them are shown. Nothing was guessed. Please run the audit again; if it happens twice, tell the owner.',
      },
      degraded: true,
    };
  }

  return { report };
}
