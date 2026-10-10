/**
 * How an audit's headline numbers are *presented*, in one place.
 *
 * The summary card, the export modal and the sidebar each used to format the
 * same fields on their own, and each got a different subset of the honesty
 * rules right: the card warned that a failed audit's numbers were not
 * measurements and then printed them anyway; the export printed them with no
 * warning at all. Pure functions, so the rules are unit-tested rather than
 * re-checked by eye in three components.
 */

import type { AuditReport } from './types';

/** Below this many answers a percentage is a handful of data points, not a rate. */
export const LOW_SAMPLE_THRESHOLD = 5;

export const NOT_MEASURED = '—';

/** A failed audit has no measurements: every headline number is withheld. */
export function hasMeasurements(audit: Pick<AuditReport, 'degraded'>): boolean {
  return !audit.degraded;
}

/** "42%" for a measured value, an em dash when the audit failed or the value is absent. */
export function formatPercent(audit: Pick<AuditReport, 'degraded'>, value: number | null | undefined): string {
  if (!hasMeasurements(audit) || value === null || value === undefined || Number.isNaN(value)) {
    return NOT_MEASURED;
  }
  return `${value}%`;
}

/** The 0-100 visibility figure, or an em dash. */
export function formatScore(audit: Pick<AuditReport, 'degraded' | 'geoVisibilityScore'>): string {
  return hasMeasurements(audit) ? String(audit.geoVisibilityScore) : NOT_MEASURED;
}

/** Number of answers the headline metrics are computed from. */
export function sampleSize(audit: Pick<AuditReport, 'observationsWithEvidence'>): number | null {
  return typeof audit.observationsWithEvidence === 'number' ? audit.observationsWithEvidence : null;
}

/**
 * The number of INDEPENDENT readings behind the headline: answers from different
 * engines to the same question are not independent, so a multi-engine audit of
 * two questions is two readings, not six. Falls back to the answer count for
 * reports that do not carry the question count.
 */
export function independentReadings(
  audit: Pick<AuditReport, 'observationsWithEvidence' | 'queriesAttempted' | 'questionsAnswered'>
): number | null {
  const n = sampleSize(audit);
  if (n === null) return null;
  // Questions that actually produced an answer; older reports only know how many were planned.
  const questions = typeof audit.questionsAnswered === 'number' ? audit.questionsAnswered : audit.queriesAttempted;
  return typeof questions === 'number' && questions > 0 ? Math.min(n, questions) : n;
}

/** True when the metrics rest on so few readings that they should carry a caution. */
export function isLowSample(audit: Pick<AuditReport, 'degraded' | 'observationsWithEvidence' | 'queriesAttempted' | 'questionsAnswered'>): boolean {
  if (!hasMeasurements(audit)) return false;
  const n = independentReadings(audit);
  return n !== null && n < LOW_SAMPLE_THRESHOLD;
}

/** "67% (3 answers)": the number a badge shows, with what it rests on, so a bare figure is never quoted alone. */
export function formatScoreBadge(
  audit: Pick<AuditReport, 'degraded' | 'geoVisibilityScore' | 'observationsWithEvidence'>
): string {
  const base = formatPercent(audit, audit.geoVisibilityScore);
  const n = sampleSize(audit);
  if (!hasMeasurements(audit) || n === null) return base;
  return `${base} (${n} ${n === 1 ? 'answer' : 'answers'})`;
}

/**
 * "Named in 1 of 3 answers (Gemini)" - the arithmetic behind the visibility
 * score, so a reader can see what the percentage is a percentage of.
 */
export function visibilityBasis(
  audit: Pick<
    AuditReport,
    'degraded' | 'observationsWithEvidence' | 'observationsAttempted' | 'observationsMentioned' | 'measuredEngines'
  >
): string | null {
  if (!hasMeasurements(audit)) return null;
  const n = sampleSize(audit);
  if (n === null) return null;
  const engines = (audit.measuredEngines || []).join(', ');
  const answers = `${n} ${n === 1 ? 'answer' : 'answers'}`;
  const where = engines ? ` (${engines})` : '';
  // Failed lookups are excluded from every metric rather than counted as "the
  // brand was absent" - but excluded silently would shrink the denominator
  // without telling anyone, so say how many.
  const failed =
    typeof audit.observationsAttempted === 'number' && audit.observationsAttempted > n
      ? `; ${audit.observationsAttempted - n} of ${audit.observationsAttempted} attempted ${
          audit.observationsAttempted === 1 ? 'answer' : 'answers'
        } failed and ${audit.observationsAttempted - n === 1 ? 'is' : 'are'} not counted`
      : '';
  if (typeof audit.observationsMentioned === 'number') {
    return `Named in ${audit.observationsMentioned} of ${answers}${where}${failed}`;
  }
  return `Based on ${answers}${where}${failed}`;
}

/**
 * When every question asked names the brand, "visible in 100% of answers" is
 * close to guaranteed by construction - the engine was asked about the brand.
 * That measures reputation, not discovery, and must not pass for a finding.
 * Returns the caution to show, or null when at least one query was brand-neutral.
 */
export function brandedQueryCaution(
  audit: Pick<AuditReport, 'degraded' | 'queriesAttempted' | 'queriesNamingBrand'>
): string | null {
  if (!hasMeasurements(audit)) return null;
  const total = audit.queriesAttempted;
  if (typeof total !== 'number' || total === 0 || typeof audit.queriesNamingBrand !== 'number') return null;
  if (audit.queriesNamingBrand < total) return null;
  return total === 1
    ? 'The question names your brand, so this mostly shows whether engines answer questions about you - not whether buyers who do not know you are pointed to you.'
    : `All ${total} questions name your brand, so this mostly shows whether engines answer questions about you - not whether buyers who do not know you are pointed to you. Add a category question (e.g. "best poke in Austin") to measure discovery.`;
}

/**
 * 95% Wilson score interval for the underlying rate, given k answers naming the
 * brand out of n, as whole percentages rounded outward. A visibility of "67" from
 * three answers is a coin-flip-sized sample: the interval is about 20%-94%. It is a
 * confidence interval for the rate, NOT a prediction of what a repeat run will
 * score, and it assumes the n answers are independent draws - three different
 * questions asked once are not - so it is the narrowest honest reading, never the
 * widest.
 */
export function wilsonInterval(k: number, n: number): { low: number; high: number } | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  // Rounded OUTWARD (floor the low end, ceil the high end): rounding to nearest
  // narrows an interval that is already optimistic.
  return {
    low: Math.max(0, Math.floor(((centre - margin) / denom) * 100 + 1e-9)),
    high: Math.min(100, Math.ceil(((centre + margin) / denom) * 100 - 1e-9)),
  };
}

/**
 * The counts the interval is computed on: (mentions, readings), where readings are
 * the INDEPENDENT ones - answers from several engines to one question are one
 * reading, not several - with the mention count scaled to match. 6 of 6 answers
 * from 2 questions is 2 of 2, not 6 of 6.
 */
function intervalCounts(
  audit: Pick<AuditReport, 'observationsWithEvidence' | 'observationsMentioned' | 'queriesAttempted' | 'questionsAnswered'>
): { k: number; n: number } | null {
  const answers = audit.observationsWithEvidence;
  const mentioned = audit.observationsMentioned;
  if (typeof answers !== 'number' || typeof mentioned !== 'number' || answers <= 0) return null;
  // Impossible counts are corrupt data: no range at all rather than a clamped one.
  if (!(mentioned >= 0 && mentioned <= answers)) return null;
  const n = independentReadings(audit) ?? answers;
  let k = Math.round((mentioned * n) / answers);
  // Rescaling should not turn "named in some answers" into "named in none" or "in all": keep k off
  // the ends when the headline is. (With a single reading the upper clamp wins and k can reach 0;
  // visibilityRange widens the result to contain the headline whatever happens here.)
  if (mentioned > 0) k = Math.max(1, k);
  if (mentioned < answers) k = Math.min(n - 1, k);
  return { k: Math.max(0, Math.min(n, k)), n };
}

/** "20%-94%" for the visibility score, or null when there is no sample to speak of. */
export function visibilityRange(
  audit: Pick<AuditReport, 'degraded' | 'observationsWithEvidence' | 'observationsMentioned' | 'queriesAttempted' | 'questionsAnswered'>
): string | null {
  if (!hasMeasurements(audit)) return null;
  const counts = intervalCounts(audit);
  const range = counts ? wilsonInterval(counts.k, counts.n) : null;
  if (!range || counts === null) return null;
  // Whatever the rescaling did, the range must contain the percentage printed beside it.
  const headline = ((audit.observationsMentioned as number) / (audit.observationsWithEvidence as number)) * 100;
  const low = Math.min(range.low, Math.floor(headline + 1e-9));
  const high = Math.max(range.high, Math.ceil(headline - 1e-9));
  return `${low}%-${high}%`;
}

/** The sentence that says what the range is and is not; one place for the card and the export. */
export function rangeExplanation(
  audit: Pick<AuditReport, 'degraded' | 'observationsWithEvidence' | 'observationsMentioned' | 'queriesAttempted' | 'questionsAnswered'>
): string | null {
  const range = visibilityRange(audit);
  if (!range) return null;
  const answers = audit.observationsWithEvidence as number;
  const readings = independentReadings(audit) as number;
  const basis =
    readings < answers
      ? ` These ${answers} answers come from only ${readings} ${readings === 1 ? 'question' : 'questions'}, and answers to the same question are not independent, so the range is computed as if there ${readings === 1 ? 'were 1 reading' : `were ${readings} readings`}.`
      : ' Answers to different questions asked once are not fully independent, so the real uncertainty is a little wider.';
  return `If these were independent readings, the true rate would plausibly lie between ${range}.${basis}`;
}

/** "Only 3 answers" or "Only 2 questions behind these 6 answers": the real reason the sample is small. */
export function lowSampleReason(audit: Pick<AuditReport, 'observationsWithEvidence' | 'queriesAttempted' | 'questionsAnswered'>): string | null {
  const answers = audit.observationsWithEvidence;
  const readings = independentReadings(audit);
  if (typeof answers !== 'number' || readings === null) return null;
  return readings < answers
    ? `Only ${readings} ${readings === 1 ? 'question' : 'questions'} behind these ${answers} answers`
    : `Only ${answers} ${answers === 1 ? 'answer' : 'answers'}`;
}

/**
 * What the numbers are and are not. Stated in the report and the export because
 * a pasted figure travels without the page around it. The API is not the
 * consumer app: the apps can use other models, personalise, and apply location,
 * and the same question can return a different answer on another run.
 */
export const MEASUREMENT_DISCLOSURE =
  'Measured by sending each question to the engine\'s developer API with web search switched on, once, at the time shown. This is not what people see in the ChatGPT, Gemini, Claude or Perplexity apps, which can use other models and personalise by account and location, and a repeat run can name different brands.';

/** "Gemini (gemini-3.6-flash)" per measured engine (the id each was REQUESTED with), or null when the report predates model stamping. */
export function engineModelsLine(audit: Pick<AuditReport, 'engineModels' | 'measuredEngines'>): string | null {
  const models = audit.engineModels;
  const engines = audit.measuredEngines || [];
  if (!models || engines.length === 0) return null;
  return engines.map((e) => (models[e] ? `${e} (${models[e]})` : e)).join(', ');
}

/** The accuracy tile: a value and the sentence that says what it means. */
export function describeAccuracy(
  audit: Pick<AuditReport, 'degraded' | 'accuracyRate' | 'narrativeAvailable' | 'inaccuraciesDiscarded'>
): { value: string; caption: string } {
  if (!hasMeasurements(audit)) {
    return { value: NOT_MEASURED, caption: 'Not measured - the audit did not complete' };
  }
  if (audit.narrativeAvailable === false) {
    return { value: NOT_MEASURED, caption: 'Not assessed - the analysis step failed' };
  }
  if (audit.accuracyRate === null || audit.accuracyRate === undefined) {
    return { value: 'N/A', caption: 'The brand was not mentioned, so there is nothing to check' };
  }
  const discarded = audit.inaccuraciesDiscarded ?? 0;
  return {
    value: `${audit.accuracyRate}%`,
    caption:
      discarded > 0
        ? `Answers naming you with no flagged inaccuracy: at most this, since ${discarded} reported ${discarded === 1 ? 'claim' : 'claims'} could not be tied to an answer (model judgement, no fact sheet)`
        : 'Answers naming you with no flagged inaccuracy (model judgement, no fact sheet - indicative)',
  };
}

/** Counts of qualitative findings, or null when they were never assessed. */
export function findingCounts(
  audit: Pick<AuditReport, 'degraded' | 'narrativeAvailable' | 'inaccuracies' | 'omissions' | 'inaccuraciesDiscarded'>
): { inaccuracies: number; omissions: number; unattributed: number } | null {
  if (!hasMeasurements(audit) || audit.narrativeAvailable === false) return null;
  return {
    inaccuracies: (audit.inaccuracies || []).length,
    omissions: (audit.omissions || []).length,
    // Claims the analysis reported that could not be tied to a captured answer: neither
    // listed nor counted, and never to be read as "none found".
    unattributed: audit.inaccuraciesDiscarded ?? 0,
  };
}

/** Whether qualitative sections (inaccuracies, omissions, remediation) were actually produced. */
export function wasAssessed(audit: Pick<AuditReport, 'degraded' | 'narrativeAvailable'>): boolean {
  return hasMeasurements(audit) && audit.narrativeAvailable !== false;
}

/** Plain-language reasons a reported claim is not in any counted figure. */
export const NOT_COUNTED_REASONS: Record<string, string> = {
  no_such_question: 'It could not be tied to any question this audit asked.',
  ambiguous_question: 'It could not be tied to one question (two questions share its wording, or the number and the text disagreed).',
  engine_not_measured: 'The engine it named does not match any engine this audit measured.',
  engine_not_identified: 'It did not say which engine\'s answer it was about, and more than one engine answered that question.',
  answer_does_not_name_brand: 'The answer it points at does not name the brand (or no answer was captured for it), so there is nothing for it to be wrong about.',
};

export interface NotCountedView {
  /** One sentence for the strip at the top of the report. */
  summary: string;
  rows: { text: string; reason: string }[];
  /** Claims left out beyond the rows kept in the report (rows are capped). */
  moreCount: number;
  footer: string;
  /** False for an audit saved before reasons were recorded: only the count is known. */
  reasonsRecorded: boolean;
}

/** The plain-text block the exported report carries for claims that were not counted ('' when there are none). */
export function notCountedExportText(view: NotCountedView | null): string {
  if (!view) return '';
  const rows = view.rows.map((r) => `\n- "${r.text}" (unverified): ${r.reason}`).join('');
  const more = !view.reasonsRecorded ? '\n- (The reasons were not recorded for this older audit.)' : view.moreCount > 0 ? `\n- ...and ${view.moreCount} more not listed.` : '';
  return `\n\nNOT COUNTED: ${view.summary} ${view.footer}${rows}${more}`;
}

/**
 * The "Not counted" strip and list: what the analysis reported that is in no figure, in its own words and
 * with the reason. null when nothing was left out, or when no analysis was assessed (nothing to leave out).
 */
export function notCountedView(
  audit: Pick<AuditReport, 'degraded' | 'narrativeAvailable' | 'inaccuraciesDiscarded' | 'notCounted' | 'accuracyRate'>
): NotCountedView | null {
  if (!hasMeasurements(audit) || audit.narrativeAvailable === false) return null;
  const count = audit.inaccuraciesDiscarded ?? 0;
  if (count <= 0) return null;
  const rows = (audit.notCounted || []).map((r) => ({ text: r.text, reason: NOT_COUNTED_REASONS[r.reason] || 'It could not be tied to a captured answer.' }));
  return {
    summary: `${count} ${count === 1 ? 'claim' : 'claims'} the analysis reported ${count === 1 ? 'was' : 'were'} not counted.`,
    rows,
    moreCount: Math.max(0, count - rows.length),
    footer: `These are left out of every figure and every rate, and none of them is verified.${typeof audit.accuracyRate === 'number' ? ' Accuracy is shown as "at most" the number printed.' : ''}`,
    reasonsRecorded: rows.length > 0,
  };
}
