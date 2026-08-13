/**
 * Deterministic GEO analysis primitives.
 *
 * Everything in this module is a pure function over captured search evidence.
 * No LLM is involved: given the same answer text and grounding chunks, these
 * functions always produce the same metrics. That reproducibility is what makes
 * an audit defensible to a paying client.
 */

export interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/** Raw evidence captured from a single grounded answer-engine query. */
export interface QueryEvidence {
  queryId: string;
  queryText: string;
  answerText: string;
  citations: { url: string; title: string; domain: string }[];
  searchQueries: string[];
  capturedAt: string;
  engine: string;
  error?: string;
}

export interface BrandMatcher {
  label: string;
  domain: string;
  domainRoot: string;
  /** Case-sensitive match required (brand name collides with a common word). */
  strictCase: boolean;
  tokens: string[];
}

/**
 * Brand names that are also ordinary English words. For these we only count a
 * mention when it appears capitalised, so "square footage" or "striped shirt"
 * are not scored as brand citations.
 */
const COMMON_WORD_BRANDS = new Set([
  'square', 'stripe', 'block', 'box', 'notion', 'slack', 'monday', 'arc',
  'apple', 'amazon', 'oracle', 'salesforce', 'shopify', 'wave', 'mint',
  'ramp', 'brex', 'plaid', 'lattice', 'front', 'linear', 'vercel', 'render',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reduce anything a user might type - "https://www.poke.house/", "Poke.House",
 * "poke.house/menu" - to the bare host. Users paste full URLs into fields
 * labelled "domain", and an unnormalised value produces broken links like
 * "https://https://www.poke.house/".
 */
export function normaliseDomain(value: string): string {
  const trimmed = (value || '').trim().toLowerCase();
  if (!trimmed) return '';
  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, '');
  const host = withoutScheme.split('/')[0].split('?')[0].split('#')[0];
  return host.replace(/^www\./, '').replace(/\.$/, '');
}

export function extractDomain(url: string): string {
  try {
    const hasScheme = /^[a-z]+:\/\//i.test(url);
    const parsed = new URL(hasScheme ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return normaliseDomain(url);
  }
}

export function buildBrandMatcher(name: string, domain?: string): BrandMatcher {
  const label = (name || '').trim();
  const cleanDomain = normaliseDomain(domain || '');
  const domainRoot = cleanDomain.split('.')[0] || '';

  const lower = label.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  if (lower) tokens.push(lower);

  /*
   * A multi-word brand is matched on its full name only.
   *
   * Matching the first word alone is how "Poke House" came to be scored as
   * present in any answer mentioning "poke bowls" - the audit reported the
   * brand as cited, and ranked first, in answers that never named it. Many
   * real businesses lead with their category word ("The Gym Group", "Pizza
   * Express"), so the first token is not safe to match on its own.
   *
   * The distinctive domain root is still matched, which recovers most
   * shorthand references without the false positives.
   */
  const domainRootIsBrandWord = words.length > 1 && words.includes(domainRoot);
  if (
    domainRoot &&
    domainRoot.length >= 4 &&
    !tokens.includes(domainRoot) &&
    // "poke.house" reduces to "poke", which is just the category word from
    // "Poke House" again and matches every answer about poke bowls.
    !domainRootIsBrandWord
  ) {
    tokens.push(domainRoot);
  }

  const strictCase = tokens.some((t) => COMMON_WORD_BRANDS.has(t));

  return { label, domain: cleanDomain, domainRoot, strictCase, tokens };
}

/**
 * Character index of the first brand mention in `text`, or -1.
 * Uses word boundaries so "striped" never counts as "Stripe".
 */
export function findFirstMention(text: string, matcher: BrandMatcher): number {
  if (!text || matcher.tokens.length === 0) return -1;

  let earliest = -1;
  for (const token of matcher.tokens) {
    if (token.length < 3) continue;

    // Common-word brands must appear capitalised ("Square" the company, not
    // "square" the adjective); everything else matches case-insensitively.
    const needle = matcher.strictCase
      ? token.charAt(0).toUpperCase() + token.slice(1)
      : token;
    // \b only works between a word and a non-word character. Brands ending or
    // starting in punctuation ("Yahoo!", "(Parens) Co") would never match if we
    // demanded a boundary on that side.
    const leading = /^\w/.test(needle) ? '\\b' : '';
    const trailing = /\w$/.test(needle) ? '\\b' : '';
    const pattern = new RegExp(`${leading}${escapeRegex(needle)}${trailing}`, matcher.strictCase ? 'g' : 'gi');

    const hit = pattern.exec(text);
    if (hit && (earliest === -1 || hit.index < earliest)) earliest = hit.index;
  }
  return earliest;
}

/**
 * Drop matchers that would double-count the same company.
 *
 * Vendor discovery returns names as written, so "Stripe" and "Stripe, Inc."
 * can both arrive. Left alone, each would score its own mention of the same
 * sentence, inflating the share-of-voice denominator and letting one company
 * occupy two ranks. Earlier matchers win, so the client (always first) and the
 * competitors the user explicitly tracked survive over discovered variants.
 */
export function dedupeMatchers(matchers: BrandMatcher[]): BrandMatcher[] {
  const kept: BrandMatcher[] = [];
  for (const candidate of matchers) {
    if (!candidate.label) continue;
    const overlaps = kept.some(
      (existing) =>
        findFirstMention(candidate.label, existing) >= 0 ||
        findFirstMention(existing.label, candidate) >= 0 ||
        (!!existing.domain && existing.domain === candidate.domain)
    );
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

/** True when the brand's own domain appears among the cited sources. */
export function isCitedAsSource(citations: QueryEvidence['citations'], matcher: BrandMatcher): boolean {
  if (!matcher.domain) return false;
  return citations.some(
    (c) => c.domain === matcher.domain || c.domain.endsWith(`.${matcher.domain}`)
  );
}

export interface BrandQueryResult {
  brand: string;
  mentioned: boolean;
  firstMentionIndex: number;
  /** 1 = first brand named in the answer. null when not mentioned. */
  rank: number | null;
  citedAsSource: boolean;
  /** 0-100; how early in the answer the brand appears. */
  prominence: number;
  excerpt: string;
}

/** Sentence (or clause) surrounding the first mention, for the evidence trail. */
function excerptAround(text: string, index: number): string {
  if (index < 0 || !text) return '';
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const rawEnd = text.indexOf('.', index);
  const end = rawEnd === -1 ? Math.min(text.length, index + 240) : rawEnd + 1;
  return text.slice(start, end).trim().slice(0, 400);
}

/**
 * Score every brand (client + competitors) against one captured answer.
 * Ranking is by order of first appearance, which is how answer engines signal
 * preference far more reliably than any self-reported "position".
 */
export function analyseAnswer(
  evidence: QueryEvidence,
  matchers: BrandMatcher[]
): BrandQueryResult[] {
  const text = evidence.answerText || '';
  const raw = matchers.map((m) => {
    const idx = findFirstMention(text, m);
    const citedAsSource = isCitedAsSource(evidence.citations, m);
    const mentioned = idx >= 0 || citedAsSource;
    return { matcher: m, idx, citedAsSource, mentioned };
  });

  const ordered = raw
    .filter((r) => r.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((r) => r.matcher.label);

  return raw.map((r) => {
    const rankIdx = ordered.indexOf(r.matcher.label);
    const prominence =
      r.idx >= 0 && text.length > 0
        ? Math.max(1, Math.round((1 - r.idx / text.length) * 100))
        : 0;

    return {
      brand: r.matcher.label,
      mentioned: r.mentioned,
      firstMentionIndex: r.idx,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      citedAsSource: r.citedAsSource,
      prominence,
      excerpt: excerptAround(text, r.idx),
    };
  });
}

export interface CitationSource {
  domain: string;
  citationCount: number;
  queryCount: number;
  isOwned: boolean;
  sampleUrl: string;
  sampleTitle: string;
}

/**
 * Which domains the answer engine actually leaned on. This is the most
 * actionable artefact in the whole audit: it converts "you are invisible" into
 * "you are absent from the N sources the engine cites for your category".
 */
export function buildCitationSourceMap(
  evidenceList: QueryEvidence[],
  clientMatcher: BrandMatcher
): CitationSource[] {
  const byDomain = new Map<string, CitationSource & { queries: Set<string> }>();

  for (const ev of evidenceList) {
    for (const citation of ev.citations) {
      if (!citation.domain) continue;
      const existing = byDomain.get(citation.domain);
      if (existing) {
        existing.citationCount += 1;
        existing.queries.add(ev.queryId);
      } else {
        byDomain.set(citation.domain, {
          domain: citation.domain,
          citationCount: 1,
          queryCount: 0,
          isOwned:
            !!clientMatcher.domain &&
            (citation.domain === clientMatcher.domain ||
              citation.domain.endsWith(`.${clientMatcher.domain}`)),
          sampleUrl: citation.url,
          sampleTitle: citation.title,
          queries: new Set([ev.queryId]),
        });
      }
    }
  }

  return Array.from(byDomain.values())
    .map(({ queries, ...rest }) => ({ ...rest, queryCount: queries.size }))
    .sort((a, b) => b.citationCount - a.citationCount || a.domain.localeCompare(b.domain));
}

export interface BrandScorecard {
  brand: string;
  domain: string;
  /** % of audited queries where the brand is mentioned at all. */
  visibility: number;
  /** % of all brand mentions across the audit that belong to this brand. */
  shareOfVoice: number;
  /** % of audited queries where the brand is named first. */
  leaderShare: number;
  timesFirst: number;
  timesMentioned: number;
  avgProminence: number;
  citedAsSourceCount: number;
}

export function buildScorecards(
  perQuery: BrandQueryResult[][],
  matchers: BrandMatcher[]
): BrandScorecard[] {
  const totalQueries = perQuery.length;
  const totalMentions = perQuery.reduce(
    (sum, results) => sum + results.filter((r) => r.mentioned).length,
    0
  );

  return matchers.map((matcher) => {
    const rows = perQuery
      .map((results) => results.find((r) => r.brand === matcher.label))
      .filter((r): r is BrandQueryResult => !!r);

    const timesMentioned = rows.filter((r) => r.mentioned).length;
    const timesFirst = rows.filter((r) => r.rank === 1).length;
    const prominenceValues = rows.filter((r) => r.mentioned).map((r) => r.prominence);
    const avgProminence = prominenceValues.length
      ? Math.round(prominenceValues.reduce((a, b) => a + b, 0) / prominenceValues.length)
      : 0;

    return {
      brand: matcher.label,
      domain: matcher.domain,
      visibility: totalQueries ? Math.round((timesMentioned / totalQueries) * 100) : 0,
      shareOfVoice: totalMentions ? Math.round((timesMentioned / totalMentions) * 100) : 0,
      leaderShare: totalQueries ? Math.round((timesFirst / totalQueries) * 100) : 0,
      timesFirst,
      timesMentioned,
      avgProminence,
      citedAsSourceCount: rows.filter((r) => r.citedAsSource).length,
    };
  });
}
