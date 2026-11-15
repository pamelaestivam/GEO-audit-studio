/**
 * Run an audit again and show what changed (docs/PLAN_2026-11.md P3). Pure: no network, no model, no clock.
 *
 * `compareReports(previous, next)` says what differs between two SAVED audits, and refuses to call anything a change when the two are
 * not comparable (another counting rule, another model, another question list, another business or rival list). When they are, every
 * figure is computed ONLY over the question-and-engine pairs that produced a usable answer in BOTH runs, from those pairs' own saved
 * answers with the same pure matching the audit uses (src/analysis.ts). Never from the audit-wide lists (`competitorBenchmarks`,
 * `untrackedRivals`, `citationSources`): a look-up that failed in one run must never show its sources as gone or a rival as newly named.
 * A pair that failed in either run is listed as not measured in one of the two runs and contributes nothing else.
 */
import { analyseAnswer, buildBrandMatcher, extractCandidateVendors, normaliseDomain, type QueryEvidence } from './analysis.js';
import type { AuditReport } from './types.js';

export const COMPARE_CAVEAT = 'Answer engines vary from run to run; a change in one answer is an observation, not a trend.';
export const NOT_MEASURED_LABEL = 'not measured in one of the two runs';
export const EARLIER_DELETED_SENTENCE = 'The earlier audit this one was compared with has been deleted.';
export const NOTHING_IN_COMMON_SENTENCE = 'No question was answered by the same engine in both runs, so there is nothing to compare.';

/** The sentence shown beside the two audits when they cannot be compared. */
export function notComparableSentence(reason: string): string {
  return `These two audits were not measured the same way (${reason}), so the difference is not shown as a change.`;
}

export interface ComparedPair {
  question: string;
  engine: string;
  namedBefore: boolean;
  namedNow: boolean;
}

export type Comparison =
  | { comparable: false; reason: string; sentence: string }
  | {
      comparable: true;
      /** Pairs with a usable answer in both runs: the denominator of everything below. */
      pairsCompared: number;
      namedBefore: number;
      namedNow: number;
      pairs: ComparedPair[];
      /** Pairs that failed or were never answered in at least one of the two runs. */
      notMeasured: { question: string; engine: string }[];
      sourcesAppeared: string[];
      sourcesGone: string[];
      /** Rivals named in the common pairs' answers now and not before. */
      rivalsNew: string[];
      caveat: string;
    };

const norm = (s: unknown) => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const setKey = (values: unknown[]) => Array.from(new Set(values.map(norm).filter(Boolean))).sort().join('\u0001');

interface PairData {
  question: string;
  engine: string;
  usable: boolean;
  ev?: QueryEvidence;
}

/** Every question-and-engine pair of a saved report, usable or not, keyed by normalised question text and engine. */
function pairsOf(report: AuditReport): Map<string, PairData> {
  const out = new Map<string, PairData>();
  for (const q of report.queriesTested || []) {
    const question = norm(q.queryText);
    const failedCells = new Set(Object.entries(q.engines || {}).filter(([, r]) => (r as any)?.status === 'retrieval_failed').map(([e]) => e));
    const engines = new Set<string>([...Object.keys(q.engines || {}), ...(q.evidence || []).map((e) => e.engine)]);
    for (const engine of engines) {
      const key = `${question}\u0001${engine}`;
      if (out.has(key)) continue;
      const rec = (q.evidence || []).find((e) => e.engine === engine);
      const usable = !!rec && !rec.error && String(rec.answerText || '').trim().length > 0 && !failedCells.has(engine);
      out.set(key, {
        question: q.queryText,
        engine,
        usable,
        ev: rec
          ? { queryId: q.id, queryText: q.queryText, answerText: rec.answerText || '', citations: rec.citations || [], searchQueries: rec.searchQueries || [], capturedAt: rec.capturedAt, engine, error: rec.error }
          : undefined,
      });
    }
  }
  return out;
}

/** Why two reports cannot be compared, or null when they can. Order: the rule, the model, the questions, the business. */
function notComparableReason(a: AuditReport, b: AuditReport): string | null {
  if (a.degraded || b.degraded) return 'one of the two audits did not complete';
  const va = a.metricVersion ?? 1;
  const vb = b.metricVersion ?? 1;
  if (va !== vb) return `the counting rule changed, from version ${va} to version ${vb}`;
  const ma = a.engineModels && Object.keys(a.engineModels).length ? a.engineModels : null;
  const mb = b.engineModels && Object.keys(b.engineModels).length ? b.engineModels : null;
  if (!ma) return 'the earlier audit did not record which model answered';
  if (!mb) return 'this audit did not record which model answered';
  const describeModels = (m: Record<string, string>) => Object.entries(m).sort(([x], [y]) => x.localeCompare(y)).map(([e, id]) => `${e} ${id}`).join(', ');
  if (describeModels(ma) !== describeModels(mb)) return `the model changed, from ${describeModels(ma)} to ${describeModels(mb)}`;
  if (setKey((a.queriesTested || []).map((q) => q.queryText)) !== setKey((b.queriesTested || []).map((q) => q.queryText))) return 'the questions are not the same';
  if (norm(a.businessName) !== norm(b.businessName)) return 'the business name is different';
  if (normaliseDomain(a.domain || '') !== normaliseDomain(b.domain || '')) return 'the domain is different';
  if (setKey(a.competitors || []) !== setKey(b.competitors || [])) return 'the list of competitors is different';
  const hasAnswers = (r: AuditReport) => (r.queriesTested || []).length === 0 || (r.queriesTested || []).some((q) => Array.isArray(q.evidence) && q.evidence.length > 0);
  if (!hasAnswers(a) || !hasAnswers(b)) return 'an audit does not hold the answers it was measured from';
  return null;
}

export function compareReports(previous: AuditReport, next: AuditReport): Comparison {
  const reason = notComparableReason(previous, next);
  if (reason) return { comparable: false, reason, sentence: notComparableSentence(reason) };

  const client = buildBrandMatcher(next.businessName, next.domain || undefined);
  const rivals = (next.competitors || []).map((c) => buildBrandMatcher(c));
  const before = pairsOf(previous);
  const now = pairsOf(next);

  const keys = new Set<string>([...before.keys(), ...now.keys()]);
  const pairs: ComparedPair[] = [];
  const notMeasured: { question: string; engine: string }[] = [];
  const domains = (p: PairData) => new Set((p.ev?.citations || []).map((c) => (c.domain || '').toLowerCase()).filter(Boolean));
  const beforeSources = new Set<string>();
  const nowSources = new Set<string>();
  const beforeRivals = new Map<string, string>();
  const nowRivals = new Map<string, string>();

  const rivalsIn = (ev: QueryEvidence, into: Map<string, string>) => {
    for (const row of analyseAnswer(ev, rivals)) if (row.mentioned) into.set(row.brand.toLowerCase(), row.brand);
    for (const name of extractCandidateVendors(ev.answerText, [client, ...rivals])) if (!into.has(name.toLowerCase())) into.set(name.toLowerCase(), name);
  };

  for (const key of keys) {
    const a = before.get(key);
    const b = now.get(key);
    const label = (b || a)!;
    if (!a?.usable || !b?.usable) {
      notMeasured.push({ question: label.question, engine: label.engine });
      continue;
    }
    const named = (p: PairData) => analyseAnswer(p.ev!, [client])[0]?.mentioned === true;
    pairs.push({ question: b.question, engine: b.engine, namedBefore: named(a), namedNow: named(b) });
    domains(a).forEach((d) => beforeSources.add(d));
    domains(b).forEach((d) => nowSources.add(d));
    rivalsIn(a.ev!, beforeRivals);
    rivalsIn(b.ev!, nowRivals);
  }

  return {
    comparable: true,
    pairsCompared: pairs.length,
    namedBefore: pairs.filter((p) => p.namedBefore).length,
    namedNow: pairs.filter((p) => p.namedNow).length,
    pairs,
    notMeasured,
    sourcesAppeared: [...nowSources].filter((d) => !beforeSources.has(d)).sort(),
    sourcesGone: [...beforeSources].filter((d) => !nowSources.has(d)).sort(),
    rivalsNew: [...nowRivals].filter(([k]) => !beforeRivals.has(k)).map(([, v]) => v).sort((x, y) => x.localeCompare(y)),
    caveat: COMPARE_CAVEAT,
  };
}
