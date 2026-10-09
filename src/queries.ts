/**
 * The three standard buyer-intent queries an audit runs when the person did
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
 * rather than being filled in. Templates are inherently generic - they cannot
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

  const alternatives = competitor
    ? `What are the best ${category ? `${category} ` : ''}alternatives to ${competitor}?`
    : `What are the best alternatives to ${name}${category ? ` for ${category}` : ''}?`;

  const comparison = competitor
    ? `${name} vs ${competitor}: which is better, and how do they compare?`
    : `Is ${name} any good? How does it compare with its alternatives?`;

  return [
    { id: 'q-gen-1', intent: 'alternatives_search', queryText: alternatives, targetPersona: 'Buyer comparing options' },
    { id: 'q-gen-2', intent: 'commercial_comparison', queryText: comparison, targetPersona: 'Buyer evaluating a choice' },
    { id: 'q-gen-3', intent: 'pricing_roi', queryText: `How much does ${name} cost?`, targetPersona: 'Buyer checking price' },
  ];
}
