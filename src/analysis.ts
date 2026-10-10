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
  /** A readable sentence - never a raw provider payload. */
  error?: string;
  /** Machine-readable cause of `error`, so failures can be summarised without re-parsing prose. */
  errorKind?: string;
}

export interface BrandMatcher {
  label: string;
  domain: string;
  domainRoot: string;
  /** Case-sensitive match required (brand name collides with a common word). */
  strictCase: boolean;
  tokens: string[];
  /**
   * Two-character ACRONYM spellings of the brand (HP, 3M, EY), matched exactly
   * as written. Kept apart from `tokens` because every token under three
   * characters is otherwise ignored ("it", "of", "on" would match everywhere).
   */
  acronyms: string[];
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

/**
 * Characters that make up a word in scripts that separate words with spaces:
 * Latin, Cyrillic and Greek letters, digits and combining marks. Deliberately NOT
 * every \p{L}: Chinese, Japanese and Korean are written without spaces, so a Latin
 * brand sits directly against them ("推荐Stripe和Adyen") and must still be found.
 * The underscore is a word character too, as it is for \\b: `adyen_token` is code, not a
 * mention of Adyen.
 */
const WORD_CLASS = '\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}\\p{M}_';
const startsWithWordChar = (value: string) => new RegExp(`^[${WORD_CLASS}]`, 'u').test(value);
const endsWithWordChar = (value: string) => new RegExp(`[${WORD_CLASS}]$`, 'u').test(value);

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
  // The label stays exactly as typed (it is shown back to the person and compared
  // with other copies of what they typed); matching uses its composed (NFC) form.
  const label = (name || '').trim();
  const cleanDomain = normaliseDomain(domain || '');
  const domainRoot = cleanDomain.split('.')[0] || '';

  const lower = label.normalize('NFC').toLowerCase();
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

  // Short acronym brands (HP, 3M, EY, BP). Skipping every token under three
  // characters meant a brand the answer named in every sentence was measured at
  // 0%, shown as "omitted" on every engine and given a remediation plan - a
  // failure to measure reported as a finding about the client. Two narrow cases
  // qualify, and nothing else does:
  //  - the WHOLE name is a two-character acronym written in capitals/digits
  //    ("HP", "3M", "EY", "BP"); or
  //  - the name is longer ("HP Inc", "3M Company") and its first word is such an
  //    acronym AND equals the root of the domain the user gave (hp.com). Without
  //    the domain, "US Bank", "LA Fitness" or "UK Power Networks" would be credited
  //    with every "US", "LA" and "UK" in every answer; a longer name stays matched
  //    on its full name only, like every other multi-word brand.
  // A name typed in lowercase or mixed case ("hp", "Hp") is NOT promoted: a
  // domain equal to a dictionary word (ai.com, on.com) proves nothing. Limits:
  // TECH_DEBT 2.6c.
  const acronyms: string[] = [];
  const isAcronym = (w: string) => w.length === 2 && /^[A-Z0-9]{2}$/.test(w) && /[A-Z]/.test(w);
  const firstWord = label.split(/\s+/)[0] || '';
  if (isAcronym(label)) acronyms.push(label);
  else if (words.length > 1 && isAcronym(firstWord) && firstWord.toLowerCase() === domainRoot) acronyms.push(firstWord);

  return { label, domain: cleanDomain, domainRoot, strictCase, tokens, acronyms };
}

/**
 * Character index of the first brand mention in `text`, or -1.
 * Uses word boundaries so "striped" never counts as "Stripe".
 */
export function findFirstMention(rawText: string, matcher: BrandMatcher): number {
  // Composed form, so a label typed decomposed and the same label typed composed are one brand.
  const text = (rawText || '').normalize('NFC');
  if (!text || (matcher.tokens.length === 0 && !matcher.acronyms?.length)) return -1;

  let earliest = -1;
  // Acronyms are matched exactly as written (case-sensitive) with word
  // boundaries (the same script-aware class as every other name): "HP" is not "HPE",
  // "OHP", "HP2", "HP_x" or "hp".
  for (const acronym of matcher.acronyms ?? []) {
    const hit = new RegExp(`(?<![${WORD_CLASS}])${escapeRegex(acronym)}(?![${WORD_CLASS}])`, 'gu').exec(text);
    if (hit && (earliest === -1 || hit.index < earliest)) earliest = hit.index;
  }
  for (const token of matcher.tokens) {
    if (token.length < 3) continue;

    // Common-word brands must appear capitalised ("Square" the company, not
    // "square" the adjective); everything else matches case-insensitively.
    const needle = matcher.strictCase
      ? token.charAt(0).toUpperCase() + token.slice(1)
      : token;
    // A boundary is demanded only on a side that starts/ends with a word character
    // (Yahoo! and "(Parens) Co" have punctuation edges), and it is the same
    // script-aware class discovery uses - \b is ASCII-only, so it treated "é" as a
    // boundary ("Nestléx" matched "Nestlé") yet matched nothing next to CJK text.
    const leading = startsWithWordChar(needle) ? `(?<![${WORD_CLASS}])` : '';
    const trailing = endsWithWordChar(needle) ? `(?![${WORD_CLASS}])` : '';
    const pattern = new RegExp(`${leading}${escapeRegex(needle)}${trailing}`, matcher.strictCase ? 'gu' : 'giu');

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

/**
 * Whether the QUESTION ITSELF names the brand. A query like "How much does
 * Poke House cost?" will get an answer about Poke House whatever the engine
 * thinks of it, so it measures reputation, not discovery. If every query in an
 * audit names the brand, a visibility of 100% is close to guaranteed by
 * construction and says nothing about whether buyers who do NOT already know
 * the brand are pointed to it. The report surfaces this instead of letting a
 * perfect score pass for a finding.
 */
export function queryNamesBrand(rawQueryText: string, matcher: BrandMatcher): boolean {
  if (!rawQueryText) return false;
  const queryText = rawQueryText.normalize('NFC');
  // Deliberately more permissive than findFirstMention, which is built to avoid
  // false MENTIONS in answers: here the question is only "was the brand put in
  // the query", so a short name ("3M", "HP"), a lowercase typing ("notion") and
  // the domain root all count. The cost of the permissiveness: a brand whose
  // name is also a category word ("Gym") is treated as named by "best gym in
  // Austin" - the caution then appears when it need not, which errs towards
  // warning about an inflated score rather than missing one.
  // The full domain counts too: "poke.house" is not among the matcher's tokens
  // (its root "poke" is just the category word), but typing it names the brand.
  const candidates = [...matcher.tokens, ...(matcher.acronyms ?? []), ...(matcher.domain ? [matcher.domain] : [])];
  for (const token of candidates) {
    const t = token.trim();
    if (t.length < 2) continue;
    const leading = /^\w/.test(t) ? '\\b' : '';
    const trailing = /\w$/.test(t) ? '\\b' : '';
    if (new RegExp(`${leading}${escapeRegex(t)}${trailing}`, 'i').test(queryText)) return true;
  }
  return false;
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
  // Composed (NFC) form, so a name written with combining accents still matches
  // the matcher's label; the excerpt is cut from the same string.
  const text = (evidence.answerText || '').normalize('NFC');
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

/**
 * The sources cited in the answers that actually NAMED this brand - most
 * frequent first, each domain counted once per answer, the brand's own domain
 * left out. Per-brand, because the Competitor Intelligence cards claim to show
 * "the sources the AI trusts" for each brand, and they used to print the same
 * audit-wide list under every one of them. A brand named in no answer has no
 * sources of its own to show, and gets none.
 */
export function sourcesForBrand(
  evidence: QueryEvidence[],
  analysis: Map<QueryEvidence, BrandQueryResult[]>,
  brand: string,
  ownDomain = '',
  limit = 4
): string[] {
  const counts = new Map<string, number>();
  for (const ev of evidence) {
    const row = analysis.get(ev)?.find((r) => r.brand === brand);
    if (!row?.mentioned) continue;
    const seen = new Set<string>();
    for (const c of ev.citations) {
      if (!c.domain || seen.has(c.domain)) continue;
      seen.add(c.domain);
      if (ownDomain && (c.domain === ownDomain || c.domain.endsWith(`.${ownDomain}`))) continue;
      counts.set(c.domain, (counts.get(c.domain) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([domain]) => domain);
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

/**
 * Words that legitimately open a capitalised sentence or clause and are
 * therefore worthless as vendor-name candidates on their own. Not brand
 * names, not stopwords for matching brands - specifically the false
 * positives a "capitalised phrase" heuristic produces at sentence starts.
 */
const SENTENCE_STARTER_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'they',
  'their', 'there', 'here', 'when', 'where', 'while', 'if', 'unless',
  'however', 'overall', 'additionally', 'furthermore', 'in', 'on', 'for',
  'with', 'according', 'based', 'many', 'most', 'some', 'several', 'other',
  'others', 'each', 'every', 'both', 'either', 'neither', 'best', 'top',
  'popular', 'well', 'unlike', 'compared', 'among', 'given', 'considering',
  'you', 'your', 'we', 'our', 'i',
  // Imperative verbs that commonly lead into a proper noun ("Try Stripe",
  // "Consider Adyen") - without these the verb gets swept into the
  // candidate string as if it were part of the name.
  'try', 'consider', 'see', 'check', 'visit', 'use', 'choose', 'shop',
  'look', 'explore', 'read', 'compare', 'contact', 'search', 'browse',
]);

/**
 * Capitalised words that are real words in answer prose but never vendors:
 * weekdays, months, and the label words engines put in bold ("**Key
 * takeaways:**", "**Pricing:**"). Single-word candidates found here are
 * dropped; they are matched as the whole candidate, so "Fresh Market" is
 * unaffected.
 */
const NON_VENDOR_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'key', 'pricing', 'price', 'prices', 'cost', 'costs', 'summary', 'conclusion',
  'note', 'notes', 'tip', 'tips', 'overview', 'features', 'feature', 'pros',
  'cons', 'why', 'how', 'what', 'which', 'who', 'fresh', 'quick', 'final',
  'bottom', 'verdict', 'recommendation', 'recommendations', 'example',
  'examples', 'option', 'options', 'step', 'steps', 'rating', 'ratings',
  'review', 'reviews', 'menu', 'hours', 'location', 'locations', 'contact',
  'yes', 'no', 'also', 'finally', 'first', 'second', 'third', 'next', 'then',
  'important', 'remember', 'ask', 'tell', 'get', 'find', 'make', 'take',
  // Generic table/column headers ("| Vendor | Rating |").
  'vendor', 'vendors', 'company', 'companies', 'provider', 'providers', 'name',
  'tool', 'tools', 'product', 'products', 'service', 'services', 'platform',
  'platforms', 'brand', 'brands', 'best', 'category', 'type', 'description',
]);

/**
 * Places an answer cites rather than recommends: review sites, directories,
 * search engines, and the answer engines themselves. Surfacing "Yelp" as a
 * rival to a restaurant is wrong; it is a source (and appears in the Citation
 * Source Map already). Whole-candidate match only - "Google Cloud" is a
 * vendor, "Google" alone is not. Competitors the user typed are tracked
 * explicitly and never pass through this filter.
 */
const NON_VENDOR_PLATFORMS = new Set([
  'google', 'google maps', 'google search', 'bing', 'yelp', 'tripadvisor',
  'reddit', 'quora', 'wikipedia', 'youtube', 'facebook', 'instagram', 'tiktok',
  'linkedin', 'twitter', 'g2', 'capterra', 'trustpilot', 'gartner', 'forbes',
  'chatgpt', 'gemini', 'perplexity', 'claude', 'openai', 'siri', 'alexa',
]);

/**
 * Whether the text before a candidate marks it as a deliberate name rather
 * than a capitalised word that merely begins a sentence: bold, a list-item
 * head, a heading, or a table cell. Engines format the vendors they recommend
 * this way; they do not format "Pricing" or "Monday" this way except as a
 * label, which NON_VENDOR_WORDS covers.
 */
function isStructuralPosition(prefix: string): boolean {
  return (
    /(?:\*\*|__)$/.test(prefix) ||
    /^\s*(?:[-*•+]|\d+[.)])\s+$/.test(prefix) ||
    /^\s*#{1,6}\s+$/.test(prefix) ||
    /\|\s*$/.test(prefix)
  );
}

/**
 * Vendor-name candidates found in answer text - no model call. Every
 * candidate returned here still has to survive the same verification every
 * discovered name already goes through (buildBrandMatcher + findFirstMention
 * against the source text).
 *
 * A capitalised phrase is NOT enough on its own. When capitalisation alone
 * was the rule, a realistic answer about Austin poke restaurants produced 15
 * "vendors", 13 of them junk ("Monday", "Pricing", "Key", "Why", "Austin",
 * "Yelp"): the client's share of voice was divided by 16 instead of 3, and the
 * Executive Summary listed "Pricing" and "Key" as rivals the client should
 * worry about. A fabricated rival is worse than a missed one, so a name now
 * has to earn its place: it must appear in a structural position (bold, list
 * head, heading, table cell) or be named at least twice.
 *
 * Cost: a vendor named exactly once, in unformatted prose, is not discovered.
 * Understating the field slightly flatters the client; the user can add that
 * rival by name and it is then tracked explicitly. See TECH_DEBT.md 2.6b.
 */
export function extractCandidateVendors(rawText: string, excludeMatchers: BrandMatcher[]): string[] {
  if (!rawText) return [];
  // Composed form, so "Café" typed as e + combining accent is one name, not "Cafe".
  const text = rawText.normalize('NFC');

  // 1-3 consecutive capitalised words: "Adyen", "Archer Aviation", "Bank of
  // America", "Johnson & Johnson". "of" and "&" are the only mid-phrase
  // connectors allowed - "&" is conventionally used within a single company
  // name, but "and" lists separate names ("Bank of America and Wells
  // Fargo"), so allowing it would bridge two distinct entities into one
  // wrong candidate spanning both.
  // Unicode-aware, for scripts that separate words with spaces. With [A-Za-z]
  // and \b (both ASCII-only) "Café Lumière" was cut to "Caf", "Nestlé" to
  // "Nestl" and "Zoë Group" lost entirely. The name and boundary classes are
  // Latin, Cyrillic and Greek letters, digits and combining marks - NOT every
  // \p{L}: Chinese, Japanese and Korean are written without spaces, so a Latin
  // brand sits directly against CJK characters ("推荐Stripe和Adyen") or a Korean
  // particle ("Stripe는") and must still be found, without absorbing them. An
  // apostrophe belongs to a name only between letters ("Sweetfin's"), never at
  // its end ("'Stripe'").
  // Name characters exclude the underscore (an identifier like Foo_Bar is code, not
  // a vendor) while the boundary class includes it, so "Foo_Bar" yields nothing.
  const W = WORD_CLASS;
  const N = WORD_CLASS.replace('_', '');
  const CAP = '(?=[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}])\\p{Lu}';
  const pattern = new RegExp(
    `(?<![${W}])${CAP}[${N}]*(?:'[${N}]+)*` +
      `(?:\\s+(?:of|&)\\s+${CAP}[${N}]*(?:'[${N}]+)*|\\s+${CAP}[${N}]*(?:'[${N}]+)*){0,2}(?![${W}])`,
    'gu'
  );

  interface Seen {
    /** Presentable form: the plain spelling if it was ever seen, else the possessive one. */
    plain?: string;
    possessive?: string;
    count: number;
    structural: boolean;
  }
  const seen = new Map<string, Seen>();

  for (const hit of text.matchAll(pattern)) {
    const raw = hit[0].trim().replace(/\s+/g, ' ');
    // "Sweetfin's menu" names Sweetfin - count it with the plain spelling. A
    // brand that genuinely ends in 's ("Lowe's") is only ever seen possessive,
    // in which case that spelling is what gets displayed.
    const isPossessive = /'s$/.test(raw);
    const candidate = isPossessive ? raw.slice(0, -2) : raw;
    const lowered = candidate.toLowerCase();
    const firstWord = lowered.split(' ')[0];
    if (candidate.length < 3 || candidate.length > 50) continue;
    if (SENTENCE_STARTER_WORDS.has(firstWord)) continue;
    if (NON_VENDOR_PLATFORMS.has(lowered)) continue;
    // "Monday" is a weekday - but "Monday.com" is a vendor. A domain suffix
    // right after the match is the tell.
    const index = hit.index ?? 0;
    const followedByDomainSuffix = /^\.(?:com|io|co|ai|app|net|org|dev)\b/i.test(
      text.slice(index + hit[0].length, index + hit[0].length + 6)
    );
    if (NON_VENDOR_WORDS.has(lowered) && !followedByDomainSuffix) continue;
    // Don't rediscover the client's own name or an already-tracked
    // competitor as if it were a new find.
    if (excludeMatchers.some((m) => findFirstMention(candidate, m) >= 0)) continue;

    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const structural = isStructuralPosition(text.slice(lineStart, index));

    const entry = seen.get(lowered) ?? { count: 0, structural: false };
    entry.count += 1;
    entry.structural = entry.structural || structural;
    if (isPossessive) entry.possessive ??= raw;
    else entry.plain ??= candidate;
    seen.set(lowered, entry);
  }

  return Array.from(seen.values())
    .filter((c) => c.structural || c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((c) => (c.plain ?? c.possessive) as string);
}

// ---------------------------------------------------------------- inaccuracy attribution

export interface QueryRef {
  queryText: string;
}

/** One row of the report's "Not counted" list: what the model said, why it is not in any figure. */
export interface NotCountedItem {
  kind: 'inaccuracy_claim';
  /** The model's own words, trimmed. Shown as unverified text, never as a finding. */
  text: string;
  reason: DiscardReason;
}

/** At most this many rows are kept in a report; the count of everything left out stays in `inaccuraciesDiscarded`. */
export const MAX_NOT_COUNTED_ROWS = 20;

/** The "Not counted" rows for discarded claims: the model's claimed fact (or a placeholder), trimmed. Pure. */
export function notCountedItems(discarded: DiscardedClaim<{ claimedFact?: unknown }>[]): NotCountedItem[] {
  return discarded.slice(0, MAX_NOT_COUNTED_ROWS).map(({ claim, reason }) => {
    const raw = typeof claim?.claimedFact === 'string' ? claim.claimedFact.replace(/\s+/g, ' ').trim() : '';
    return { kind: 'inaccuracy_claim' as const, text: raw ? (Array.from(raw).length > 300 ? `${Array.from(raw).slice(0, 297).join('')}...` : raw) : '(the analysis gave no text for this claim)', reason };
  });
}

/** Why a model-reported claim was left out of the counted findings. */
export type DiscardReason = 'no_such_question' | 'ambiguous_question' | 'engine_not_measured' | 'engine_not_identified' | 'answer_does_not_name_brand';

export interface DiscardedClaim<T> {
  claim: T;
  reason: DiscardReason;
}

export interface AttributedInaccuracy<T> {
  claim: T;
  /** Index into the audit's query list. */
  queryIndex: number;
  engine: string;
}

/** Lower-case, collapse whitespace, drop surrounding quotes and trailing punctuation. */
function normaliseQueryText(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’.?!:;,]+$/g, '')
    .trim();
}

/**
 * Tie each model-reported inaccuracy to the captured answer it is about.
 *
 * The narrative model is only a reader of the evidence, so a claim that cannot
 * be tied to an answer we captured - a query we never asked, an engine we never
 * measured, or an answer that does not name the brand at all - is discarded, and
 * counted so the report can say so. It used to be silently re-attributed to the
 * first query and first engine, which put an invented claim into the report
 * under a real query's name and counted it against the accuracy rate.
 *
 * This is a SHAPE check, not a fact check: it proves a claim points at a real
 * answer, not that the claim is true of that answer (nothing here verifies that
 * `claimedFact` appears in the text). The model's judgement stays a model's
 * judgement (TECH_DEBT 2.5).
 *
 * The query is found, in order, by the number the model was shown (`queryNumber`,
 * 1-based, which cannot be paraphrased or confused by duplicate texts), then by
 * its text compared loosely (case, spacing, quotes, trailing punctuation), and
 * only when that text is unambiguous. An engine that is not named can only mean
 * the one engine when a single engine was measured, or the one engine that
 * answered that query.
 */
export function attributeInaccuracies<T extends { queryText?: unknown; engine?: unknown; queryNumber?: unknown }>(
  claims: T[],
  queries: QueryRef[],
  measuredEngines: string[],
  /** `${queryIndex}|${engine}` of every captured answer that names the brand. */
  answerKeys: Set<string>
): { kept: AttributedInaccuracy<T>[]; discarded: number; discardedClaims: DiscardedClaim<T>[] } {
  const kept: AttributedInaccuracy<T>[] = [];
  const discardedClaims: DiscardedClaim<T>[] = [];
  let discarded = 0;
  const normalisedQueries = queries.map((q) => normaliseQueryText(q.queryText || ''));
  for (const claim of Array.isArray(claims) ? claims : []) {
    let queryIndex = -1;
    const number = typeof claim?.queryNumber === 'number' ? claim.queryNumber : Number.NaN;
    const byNumber = Number.isInteger(number) && number >= 1 && number <= queries.length ? number - 1 : -1;
    let byText = -1;
    let ambiguousText = false;
    if (typeof claim?.queryText === 'string' && claim.queryText.trim()) {
      const wanted = normaliseQueryText(claim.queryText);
      const matches = normalisedQueries.reduce<number[]>((acc, q, i) => (q === wanted ? [...acc, i] : acc), []);
      // Two questions with the same text cannot be told apart by text.
      if (matches.length === 1) byText = matches[0];
      else if (matches.length > 1) ambiguousText = true;
    }
    if (byNumber >= 0 && byText >= 0 && byNumber !== byText) {
      // The number and the text name different questions (an off-by-one, a 0-based
      // count): either could be the mistake, so the claim is not placed under a guess.
      discarded++;
      discardedClaims.push({ claim, reason: 'ambiguous_question' });
      continue;
    }
    queryIndex = byNumber >= 0 ? byNumber : byText;

    const named = typeof claim?.engine === 'string' ? claim.engine.trim().toLowerCase() : '';
    let engine: string | undefined;
    if (named) {
      engine = measuredEngines.find((e) => e.toLowerCase() === named);
    } else if (queryIndex >= 0) {
      const answering = measuredEngines.filter((e) => answerKeys.has(`${queryIndex}|${e}`));
      if (answering.length === 1) engine = answering[0];
    }

    if (queryIndex < 0 || !engine || !answerKeys.has(`${queryIndex}|${engine}`)) {
      discarded++;
      // Why, in the order the checks above can fail: no question it points at; a named engine that was never
      // measured; no engine named while several answered that question; otherwise the answer it points at
      // does not name the brand.
      let reason: DiscardReason;
      if (queryIndex < 0) reason = ambiguousText ? 'ambiguous_question' : 'no_such_question';
      else if (named && !measuredEngines.some((e) => e.toLowerCase() === named)) reason = 'engine_not_measured';
      else if (!named && measuredEngines.filter((e) => answerKeys.has(`${queryIndex}|${e}`)).length >= 2) reason = 'engine_not_identified';
      else reason = 'answer_does_not_name_brand';
      discardedClaims.push({ claim, reason });
      continue;
    }
    kept.push({ claim, queryIndex, engine });
  }
  return { kept, discarded, discardedClaims };
}

/**
 * Share of the answers that mention the brand in which the narrative flagged no
 * inaccuracy. The unit is the ANSWER, not the claim: three claims about one
 * answer make that one answer inaccurate, not three. (It used to divide the
 * claim count by the mention count, so a single answer with two flagged claims
 * out of two mentioning answers read as 0% accurate instead of 50%.)
 * null when no answer mentioned the brand - there is nothing to check.
 */
export function computeAccuracyRate(mentionedKeys: Set<string>, flaggedKeys: Iterable<string>): number | null {
  if (mentionedKeys.size === 0) return null;
  const flagged = new Set<string>();
  for (const key of flaggedKeys) if (mentionedKeys.has(key)) flagged.add(key);
  return Math.round(((mentionedKeys.size - flagged.size) / mentionedKeys.size) * 100);
}
