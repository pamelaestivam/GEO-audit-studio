/**
 * Machine checks on a finished report. Pure: no network, no model, no clock.
 *
 * Two jobs, both from docs/RELIABILITY.md (failure class 4, "logic"):
 *
 *  1. guardSummary - the model writes the qualitative summary, but it is never the source of
 *     a figure. The server states every measured figure itself, in its own sentence, so the
 *     model's prose is allowed NO figure at all: any sentence containing one (digits, spelled-out
 *     numbers, "double", "threefold", "a third", "10k") is removed, and the removal is reported,
 *     not hidden. Matching a figure against the "computed set" was tried first and rejected: a
 *     wrong figure that happens to equal some count or rate (0 to 6 nearly always do) passes as
 *     "verified", and the inverse of a rate passes as arithmetic.
 *
 *  2. assertReportInvariants - a report whose own figures contradict each other must never be
 *     shown as done. A violation is a bug in this code, not a finding about the client, so the
 *     caller turns it into a visible failure.
 *
 * Both lean toward the safe direction: a false violation costs a re-run, a false removal costs a
 * sentence of prose, a false keep puts an unverified figure in front of a client.
 */

// ---------------------------------------------------------------------------
// Figures in text
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100, thousand: 1000, million: 1_000_000, half: 0.5, halves: 0.5, dozen: 12,
  third: 1 / 3, thirds: 1 / 3, quarter: 0.25, quarters: 0.25,
};
/**
 * Words that state a size of change or a fraction without a digit ("will double", "threefold",
 * "twice as many"). They are figures with no value (NaN).
 */
const MULTIPLIER_WORDS = ['double', 'doubled', 'doubles', 'doubling', 'twice', 'triple', 'tripled', 'triples', 'tripling', 'quadruple', 'quadrupled', 'quintuple', 'quintupled'];

/** Quantity words with no exact value ("hundreds of buyers", "a pair of answers", "thrice as likely"). */
const LOOSE_QUANTITY_WORDS = [
  'thrice', 'hundreds', 'thousands', 'millions', 'dozens', 'pair', 'pairs', 'couple', 'couples', 'billion', 'trillion',
  'fifth', 'fifths', 'sixth', 'sixths', 'eighth', 'eighths', 'tenth', 'tenths',
];

const UNIT_WORDS = Object.keys(UNITS).filter((w) => UNITS[w] <= 9).join('|');
const TENS_WORDS = Object.keys(TENS).join('|');
const ALL_UNIT_WORDS = Object.keys(UNITS).join('|');
const SCALE_WORDS = Object.keys(SCALES).join('|');

// Digits (optionally with a k/m/b suffix), "-fold" words, multiplier words, "twenty-five" / "twenty five",
// then any single number word.
const NUMBER_RE = new RegExp(
  String.raw`\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]\b)?` +
    String.raw`|\b(?:${ALL_UNIT_WORDS}|${TENS_WORDS}|hundred|thousand|million)[-\s]?fold\b` +
    String.raw`|\b(?:${MULTIPLIER_WORDS.join('|')})\b` +
    String.raw`|\b(?:${TENS_WORDS})(?:[-\s](?:${UNIT_WORDS}))?\b` +
    String.raw`|\b(?:${ALL_UNIT_WORDS}|${SCALE_WORDS}|none|single|once|${LOOSE_QUANTITY_WORDS.join('|')})\b`,
  'gi'
);

/** Digits of any script (fullwidth, Arabic-Indic, ...) as ASCII digits. */
function asciiDigits(text: string): string {
  return text.normalize('NFKC').replace(/\p{Nd}/gu, (ch) => {
    let base = ch.codePointAt(0)!;
    const cp = base;
    while (/\p{Nd}/u.test(String.fromCodePoint(base - 1))) base--;
    return String((cp - base) % 10);
  });
}

/** A count stated with a noun: "only one answer", "none of the answers". */
const ONE_AS_COUNT = /^\s+(?:answers?|quer(?:y|ies)|questions?|engines?|times?|mentions?|results?|sources?|citations?|competitors?|brands?|vendors?)\b/i;
const ONE_IN = /^\s+(?:in|out of)\s+/i;
const ONE_OF_N = /^\s+of\s+(?:\d|zero|two|three|four|five|six|seven|eight|nine|ten)/i;
const NONE_OF = /^\s+of\s+(?:the|these|those|our|its|their)\s+(?:answers|queries|questions|engines|results)/i;

/**
 * Every figure a sentence states, as numbers (NaN for a size-of-change word). "one" is the
 * English pronoun far more often than a figure ("one of the leading tools", "no one"), so it
 * only counts where it is plainly a count: "one in four", "one of 3", "only one answer".
 */
export function extractNumbers(text: string): number[] {
  const t = asciiDigits(String(text ?? ''));
  const found: number[] = [];
  for (const m of t.matchAll(NUMBER_RE)) {
    const token = m[0].toLowerCase();
    const end = (m.index ?? 0) + m[0].length;
    if (/^\d/.test(token)) {
      const mult = /[kmb]$/.test(token) ? ({ k: 1e3, m: 1e6, b: 1e9 } as any)[token.slice(-1)] : 1;
      // A digit run too long to be a number is still a figure: Infinity is never "fine".
      found.push(Number(token.replace(/,/g, '').replace(/\s?[kmb]$/, '')) * mult);
      continue;
    }
    if (/fold$/.test(token) || MULTIPLIER_WORDS.includes(token)) {
      if (token === 'double' && /^\s+down\b/i.test(t.slice(end, end + 8))) continue; // "double down on schema"
      found.push(NaN);
      continue;
    }
    // "third-party", "zero-click", "half-hearted" and "double down" are ordinary words, not figures (a short
    // allowlist: "six-month" or "half-year" must stay figures).
    if ((token === 'third' || token === 'zero' || token === 'half') && /^-(?:party|click|hearted|baked|way|trust)\b/i.test(t.slice(end, end + 9))) continue;
    if (token === 'once' || LOOSE_QUANTITY_WORDS.includes(token)) {
      if (token === 'once' && !/\b(?:only|just|exactly|named|mentioned|cited|appears?|appeared|listed)\s+(?:\w+\s+)?$/i.test(t.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0))) continue;
      found.push(NaN);
      continue;
    }
    if (token === 'single') {
      if (ONE_AS_COUNT.test(t.slice(end, end + 24))) found.push(1);
      continue;
    }
    if (token === 'none') {
      if (NONE_OF.test(t.slice(end, end + 40))) found.push(0);
      continue;
    }
    if (token === 'one') {
      const after = t.slice(end, end + 24);
      if (ONE_IN.test(after) || ONE_OF_N.test(after) || ONE_AS_COUNT.test(after)) found.push(1);
      continue;
    }
    const parts = token.split(/[-\s]/);
    if (parts.length === 2 && TENS[parts[0]] !== undefined && UNITS[parts[1]] !== undefined) found.push(TENS[parts[0]] + UNITS[parts[1]]);
    else if (TENS[token] !== undefined) found.push(TENS[token]);
    else if (UNITS[token] !== undefined) found.push(UNITS[token]);
    else if (SCALES[token] !== undefined) found.push(SCALES[token]);
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

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text with the things that merely CONTAIN digits blanked out, so they are not read as figures:
 * names the person typed or the audit found (a brand called "3M", a rival "7-Eleven", a query
 * "top 10 ..."), identifiers that start with letters ("B2B", "GPT-5", "Q3"), and calendar years.
 */
function withoutIdentifiers(text: string, names: readonly string[]): string {
  let out = text;
  const list = names.map((n) => String(n ?? '').trim()).filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  for (const n of list) {
    // A "name" that is itself a figure ("10", "47%", "Three") would hide every such figure: not a name.
    if (/^[\d\s.,%$+-]+$/.test(n) || (extractNumbers(n).length > 0 && /^[a-z\s-]+$/i.test(n))) continue;
    // Whole tokens only; case-insensitive unless the name has digits (so "3M" does not hide "3m" = 3 million).
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(n)}(?![A-Za-z0-9])`, /\d/.test(n) ? 'g' : 'gi'), ' ');
  }
  return (
    out
      // Identifiers: capital letters then digits ("B2B", "GPT-5", "Q3", "SOC2") or a camel-case name then digits
      // ("ChatGPT-5"). "top3", "page-1", "rose-40%" and "Top-10" are figures.
      .replace(/\b(?:[A-Z]{1,6}|[A-Z][a-z]*[A-Z][A-Za-z]*)-?\d+[A-Za-z0-9]*\b/g, ' ')
      // A year only where it reads as one. First a list of years or a year closing a clause
      // ("2024, 2025 and", "founded in 2019,"), then a year after a preposition or month ("from
      // 2019", "March 2025"). "About 2000 visitors" stays a figure.
      .replace(/\b(?:19|20)\d{2}(?:,\s*(?:19|20)\d{2})*(?=\s*[,.;)](?:\s|$)|,?\s+and\s)/g, ' ')
      .replace(
        /\b(?:in|since|from|of|by|during|before|after|until|through|between|and|to|late|early|mid|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[\s-]+(?:19|20)\d{2}\b(?!\s?(?:%|percent|per\s?cent|visitors|users|buyers|answers|queries|questions|views|clicks))/gi,
        ' '
      )
  );
}

/** True if the sentence states a figure (see extractNumbers), ignoring identifiers. */
export function containsFigure(sentence: string, names: readonly string[] = []): boolean {
  return extractNumbers(withoutIdentifiers(sentence, names)).length > 0;
}

export interface GuardResult {
  /** The sentences that survived, joined. May be empty. */
  text: string;
  /** Sentences removed because they stated a figure. */
  removed: number;
  /** Sentences found in the model's text. */
  total: number;
}

/**
 * Keep only the sentences that state no figure. `names` are strings the person typed or the audit
 * found (business, domain, competitors, rivals, industry, offerings, audience, query texts):
 * digits inside them are not figures.
 */
export function guardSummary(modelText: string, names: readonly string[] = []): GuardResult {
  const sentences = splitSentences(String(modelText ?? ''));
  const kept = sentences.filter((s) => !containsFigure(s, names));
  return { text: kept.join(' '), removed: sentences.length - kept.length, total: sentences.length };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

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

  if (isNum(report.queriesNamingBrand) && isNum(report.queriesAttempted) && report.queriesNamingBrand > report.queriesAttempted) {
    v.push(`${report.queriesNamingBrand} questions name the brand out of ${report.queriesAttempted} asked`);
  }
  if (report.inaccuraciesDiscarded !== undefined && (!isNum(report.inaccuraciesDiscarded) || report.inaccuraciesDiscarded < 0)) {
    v.push(`inaccuraciesDiscarded is ${JSON.stringify(report.inaccuraciesDiscarded)}, not a count`);
  }
  if (Array.isArray(report.notCounted) && isNum(report.inaccuraciesDiscarded) && report.notCounted.length > report.inaccuraciesDiscarded) {
    v.push(`${report.notCounted.length} items listed as not counted but only ${report.inaccuraciesDiscarded} claims were discarded`);
  }
  for (const o of Array.isArray(report.omissions) ? report.omissions : []) {
    const n = o?.affectedQueriesCount;
    if (!isNum(n) || n < 0 || !Number.isInteger(n) || (isNum(report.queriesAttempted) && n > report.queriesAttempted)) {
      v.push(`omission ${o?.id} affects ${JSON.stringify(n)} questions out of ${report.queriesAttempted} asked`);
    }
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
