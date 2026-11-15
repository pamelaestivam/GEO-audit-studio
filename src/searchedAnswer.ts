/**
 * Did a Gemini reply come from a web search? (docs/PLAN_2026-11.md P2.) Pure: no network, no model.
 * A search ran when the reply names at least one web search query or carries at least one grounding chunk. A reply with
 * text and neither is an answer from memory, and the audit does not count it as a measurement.
 */
export function geminiSearched(groundingMetadata: unknown): boolean {
  const m = groundingMetadata as { webSearchQueries?: unknown; groundingChunks?: unknown } | null | undefined;
  if (!m || typeof m !== 'object') return false;
  const queries = Array.isArray(m.webSearchQueries) ? m.webSearchQueries.length : 0;
  const chunks = Array.isArray(m.groundingChunks) ? m.groundingChunks.length : 0;
  return queries > 0 || chunks > 0;
}
