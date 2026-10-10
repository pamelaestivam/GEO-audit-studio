/**
 * How many questions an audit runs by default. Three is the ceiling the owner set
 * (docs/OWNER_DIRECTIVES.md D-7). It is TWO until audits are persisted step by step
 * and can resume after a failure (docs/DECISIONS.md 2026-10-10, decision D;
 * docs/RELIABILITY.md section 2): today a frozen or restarted host loses the whole
 * audit, so a shorter audit has less to lose, and fewer calls spend less of the free
 * quota. When resumable steps ship, raise this to 3 and update the tests that read it.
 */
export const DEFAULT_QUERY_COUNT = 2;

/**
 * The standard buyer-intent queries an audit runs when the person did
 * not write their own (and the fallback when query generation is unavailable).
 *
 * These are the literal questions put to the answer engines, so a malformed one
 * corrupts the evidence. The version this replaced interpolated an empty array
 * when no competitor was given - the default case - producing "Best software
 * alternatives to  for modern teams" and "Poke House vs  comparison", invented
 * "software" as the category for a restaurant, and asked about "free tier
 * limits and enterprise contract cost". Pure so it can be tested exhaustively.
 *
 * Nothing is guessed: a missing industry or competitor changes the wording
 * rather than being filled in. Two of the three questions necessarily name the
 * brand (a comparison and a price question are about it); the first is a
 * brand-neutral discovery question whenever one can be written honestly. Templates are inherently generic - they cannot
 * know a business - which is why writing your own queries (or the opt-in
 * "Generate Query Matrix" step) is the better path for a real audit.
 */

export interface AuditQueryTemplate {
  id: string;
  intent: 'alternatives_search' | 'commercial_comparison' | 'pricing_roi';
  queryText: string;
  targetPersona: string;
}

/** The first non-blank competitor, whether given as an array, a string, or nothing. */
function firstCompetitor(competitors: unknown): string {
  const list = Array.isArray(competitors) ? competitors : typeof competitors === 'string' ? competitors.split(',') : [];
  for (const c of list) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

export function buildStandardQueries(
  businessName: string,
  industry?: string,
  competitors?: unknown
): AuditQueryTemplate[] {
  const name = (businessName || '').trim();
  const category = (industry || '').trim();
  const competitor = firstCompetitor(competitors);

  // The first question is DISCOVERY: it should not name the brand, because
  // asking an engine about a brand by name guarantees an answer about that
  // brand (a "100% visible" that is true by construction). It can be written
  // without the brand whenever there is a competitor or an industry to anchor
  // it; with neither, it has to name the brand and the report says so.
  const alternatives = competitor
    ? `What are the best ${category ? `${category} ` : ''}alternatives to ${competitor}?`
    : category
      ? `What are the best ${category}?`
      : `What are the best alternatives to ${name}?`;

  const comparison = competitor
    ? `${name} vs ${competitor}: which is better, and how do they compare?`
    : `Is ${name} any good? How does it compare with its alternatives?`;

  // In priority order: the discovery question first (the one that can be written
  // without the brand), then the comparison, then price. The default takes the
  // first DEFAULT_QUERY_COUNT, so shortening or lengthening the default never
  // reorders what is asked.
  const all: AuditQueryTemplate[] = [
    { id: 'q-gen-1', intent: 'alternatives_search', queryText: alternatives, targetPersona: 'Buyer comparing options' },
    { id: 'q-gen-2', intent: 'commercial_comparison', queryText: comparison, targetPersona: 'Buyer evaluating a choice' },
    { id: 'q-gen-3', intent: 'pricing_roi', queryText: `How much does ${name} cost?`, targetPersona: 'Buyer checking price' },
  ];
  return all.slice(0, DEFAULT_QUERY_COUNT);
}
