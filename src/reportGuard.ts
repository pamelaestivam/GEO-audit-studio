/**
 * Machine checks on a finished report. Pure: no network, no model, no clock.
 *
 * Two jobs, both from docs/RELIABILITY.md (failure class 4, "logic"):
 *
 *  1. assertReportInvariants - a report whose own figures contradict each other
 *     must never be shown as done. A violation is a bug in this code, not a finding
 *     about the client, so the caller turns it into a visible failure.
 *
 *  2. guardSummary - the model writes the qualitative summary, but it is never the
 *     source of a number. Any sentence containing a figure that is not in the
 *     computed set (spelled-out figures included: "three of four") is removed, and
 *     the removal is reported, not hidden.
 *
 * Both lean toward the safe direction: a false violation costs a re-run, a false
 * keep puts an unverified figure in front of a client.
 */

// ---------------------------------------------------------------------------
// Numbers in text
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, half: 0.5, dozen: 12 };

const UNIT_WORDS = Object.keys(UNITS).filter((w) => UNITS[w] <= 9).join('|');
const TENS_WORDS = Object.keys(TENS).join('|');
const ALL_UNIT_WORDS = Object.keys(UNITS).join('|');
const SCALE_WORDS = Object.keys(SCALES).join('|');

// Digits first, then "twenty-five" / "twenty five", then any single number word.
const NUMBER_RE = new RegExp(
  String.raw`\d[\d,]*(?:\.\d+)?` +
    String.raw`|\b(?:${TENS_WORDS})(?:[-\s](?:${UNIT_WORDS}))?\b` +
    String.raw`|\b(?:${ALL_UNIT_WORDS}|${SCALE_WORDS})\b`,
  'gi'
);

/**
 * Every figure a sentence states, as numbers. "one" is the English pronoun far more often
 * than a figure ("one of the leading tools", "no one"), so it only counts where it is
 * plainly a count: "one in four", "one out of 3", "one of 3".
 */
export function extractNumbers(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const token = m[0].toLowerCase();
    if (/^\d/.test(token)) {
      const value = Number(token.replace(/,/g, ''));
      if (Number.isFinite(value)) found.push(value);
      continue;
    }
    if (token === 'one') {
      const after = text.slice((m.index ?? 0) + token.length, (m.index ?? 0) + token.length + 16).toLowerCase();
      if (/^\s+(?:in|out of)\s+/.test(after) || /^\s+of\s+(?:\d|zero|two|three|four|five|six|seven|eight|nine|ten)/.test(after)) {
        found.push(1);
      }
      continue;
    }
    const parts = token.split(/[-\s]/);
    if (parts.length === 2 && TENS[parts[0]] !== undefined && UNITS[parts[1]] !== undefined) {
      found.push(TENS[parts[0]] + UNITS[parts[1]]);
    } else if (TENS[token] !== undefined) {
      found.push(TENS[token]);
    } else if (UNITS[token] !== undefined) {
      found.push(UNITS[token]);
    } else if (SCALES[token] !== undefined) {
      found.push(SCALES[token]);
    }
  }
  return found;
}

/** Split into sentences without breaking decimals ("33.5%") or abbreviations' following word. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface GuardResult {
  /** The sentences that survived, joined. May be empty. */
  text: string;
  /** Sentences removed because they stated a figure outside the allowed set. */
  removed: number;
  /** Sentences found in the model's text. */
  total: number;
}

/** Keep only sentences whose every figure is in `allowed`. */
export function guardSummary(modelText: string, allowed: ReadonlySet<number>): GuardResult {
  const sentences = splitSentences(String(modelText ?? ''));
  const kept = sentences.filter((s) => extractNumbers(s).every((n) => allowed.has(n)));
  return { text: kept.join(' '), removed: sentences.length - kept.length, total: sentences.length };
}

// ---------------------------------------------------------------------------
// The computed set
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Every figure the summary may state: the report's own counts and percentages, the
 * complements that are plain arithmetic on them, and any figure the person typed
 * themselves (a brand called "3M", a query "top 10 ...").
 */
export function allowedFigures(report: any, userText: string[] = []): Set<number> {
  const allowed = new Set<number>();
  const add = (v: unknown) => {
    if (isNum(v)) allowed.add(v);
  };
  // "Not named in 67%" is arithmetic on a rate, so the complement of a rate is allowed.
  // A prominence score is not a rate of anything: its complement means nothing.
  for (const p of [report?.geoVisibilityScore, report?.shareOfVoice, report?.leaderShare, report?.accuracyRate]) {
    add(p);
    if (isNum(p) && p >= 0 && p <= 100) add(100 - p);
  }
  add(report?.avgProminence);
  for (const k of [
    'queriesAttempted', 'questionsAnswered', 'queriesNamingBrand', 'observationsAttempted',
    'observationsWithEvidence', 'observationsMentioned', 'inaccuraciesDiscarded',
  ]) add(report?.[k]);
  if (isNum(report?.observationsWithEvidence) && isNum(report?.observationsMentioned)) {
    add(report.observationsWithEvidence - report.observationsMentioned);
  }
  for (const k of ['measuredEngines', 'enginesRequested', 'inaccuracies', 'omissions', 'remediationPlan', 'competitors', 'queriesTested', 'citationSources', 'untrackedRivals']) {
    if (Array.isArray(report?.[k])) add(report[k].length);
  }
  for (const b of Array.isArray(report?.competitorBenchmarks) ? report.competitorBenchmarks : []) {
    add(b?.shareOfVoice);
    add(b?.topRecommendedCount);
  }
  for (const t of userText) for (const n of extractNumbers(String(t ?? ''))) allowed.add(n);
  return allowed;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

const PERCENT_FIELDS = ['geoVisibilityScore', 'shareOfVoice', 'leaderShare', 'avgProminence'] as const;

/**
 * Returns the list of violated invariants (empty = consistent). Checks relationships
 * between figures the report states; it does not re-derive them from evidence, so a
 * correct report is never rejected for a rounding choice.
 */
export function assertReportInvariants(report: any): string[] {
  const v: string[] = [];
  if (!report || typeof report !== 'object') return ['the report is missing'];
  if (report.degraded) return v; // a failure carries no figures to check; see invariant 3 below

  for (const f of PERCENT_FIELDS) {
    const x = report[f];
    if (!isNum(x) || x < 0 || x > 100) v.push(`${f} is ${JSON.stringify(x)}, not a percentage from 0 to 100`);
  }
  if (report.accuracyRate !== null && report.accuracyRate !== undefined) {
    if (!isNum(report.accuracyRate) || report.accuracyRate < 0 || report.accuracyRate > 100) {
      v.push(`accuracyRate is ${JSON.stringify(report.accuracyRate)}, not a percentage or null`);
    }
    if (report.narrativeAvailable === false) v.push('accuracyRate is stated although the qualitative analysis did not run');
  }

  const attempted = report.observationsAttempted;
  const withEvidence = report.observationsWithEvidence;
  const mentioned = report.observationsMentioned;
  for (const [name, value] of [['observationsAttempted', attempted], ['observationsWithEvidence', withEvidence], ['observationsMentioned', mentioned]] as const) {
    if (!isNum(value) || value < 0 || !Number.isInteger(value)) v.push(`${name} is ${JSON.stringify(value)}, not a count`);
  }
  if (isNum(attempted) && isNum(withEvidence) && withEvidence > attempted) v.push(`${withEvidence} usable answers out of ${attempted} attempted`);
  if (isNum(withEvidence) && isNum(mentioned) && mentioned > withEvidence) v.push(`named in ${mentioned} of only ${withEvidence} usable answers`);
  if (isNum(withEvidence) && isNum(mentioned) && withEvidence > 0 && isNum(report.geoVisibilityScore)) {
    const expected = Math.round((mentioned / withEvidence) * 100);
    if (Math.abs(report.geoVisibilityScore - expected) > 1) {
      v.push(`visibility ${report.geoVisibilityScore}% does not match ${mentioned} of ${withEvidence} answers (${expected}%)`);
    }
  }
  if (isNum(withEvidence) && withEvidence === 0 && isNum(report.geoVisibilityScore) && report.geoVisibilityScore !== 0) {
    v.push(`visibility ${report.geoVisibilityScore}% is stated with no usable answer behind it`);
  }

  if (isNum(report.questionsAnswered) && isNum(report.queriesAttempted) && report.questionsAnswered > report.queriesAttempted) {
    v.push(`${report.questionsAnswered} questions answered out of ${report.queriesAttempted} asked`);
  }

  const measured: string[] = Array.isArray(report.measuredEngines) ? report.measuredEngines : [];
  const requested: string[] = Array.isArray(report.enginesRequested) ? report.enginesRequested : [];
  for (const e of measured) if (!requested.includes(e)) v.push(`engine ${e} is reported as measured but was never requested`);
  if (isNum(withEvidence) && withEvidence > 0 && measured.length === 0) v.push('answers are counted but no engine is reported as measured');

  const queryIds = new Set((Array.isArray(report.queriesTested) ? report.queriesTested : []).map((q: any) => q?.id));
  for (const i of Array.isArray(report.inaccuracies) ? report.inaccuracies : []) {
    if (!queryIds.has(i?.queryId)) v.push(`inaccuracy ${i?.id} names a question that is not in this audit`);
    if (!measured.includes(i?.engine)) v.push(`inaccuracy ${i?.id} names engine ${i?.engine}, which was not measured`);
  }
  if (report.narrativeAvailable === false) {
    for (const k of ['inaccuracies', 'omissions', 'remediationPlan']) {
      if (Array.isArray(report[k]) && report[k].length > 0) v.push(`${k} has entries although the qualitative analysis did not run`);
    }
  }

  const sov = (Array.isArray(report.competitorBenchmarks) ? report.competitorBenchmarks : []).reduce((s: number, b: any) => s + (isNum(b?.shareOfVoice) ? b.shareOfVoice : 0), 0);
  // Each share is rounded on its own, so the sum may exceed 100 by a rounding step per row.
  const rows = Array.isArray(report.competitorBenchmarks) ? report.competitorBenchmarks.length : 0;
  if (sov > 100 + rows) v.push(`shares of voice add up to ${sov}%`);

  return v;
}
