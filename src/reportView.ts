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

/** True when the metrics rest on so few answers that they should carry a caution. */
export function isLowSample(audit: Pick<AuditReport, 'degraded' | 'observationsWithEvidence'>): boolean {
  if (!hasMeasurements(audit)) return false;
  const n = sampleSize(audit);
  return n !== null && n < LOW_SAMPLE_THRESHOLD;
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
