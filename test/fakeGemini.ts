/**
 * A protocol-faithful fake Gemini endpoint with switchable behaviour, shared by
 * the newer end-to-end suites. It speaks the real generateContent response
 * shape (candidates, grounding chunks), so the real SDK inside the real built
 * server is what gets exercised - only the far end is fake. Nothing here
 * pretends to be a real engine's judgement: the answer text is fixed and
 * labelled as such in the tests that use it.
 */
import http from 'http';

export type FakeMode = 'ok' | 'narrative_fails' | 'narrative_findings' | 'narrative_unattributable' | 'narrative_remediation' | 'narrative_invented_numbers' | 'lookup_placeholder' | 'lookup_good' | 'unauthorized' | 'slow' | 'many_vendors' | 'partial_failure' | 'narrative_odd_values' | 'daily_quota';

export const FAKE_ANSWER = `For poke in Austin, top picks are:

* **Pokeworks** - consistently rated highest.
* **Sweetfin** - great vegan bowls.
* **Poke House** - solid fresh fish.

According to Yelp and TripAdvisor, Pricing starts at $12. Key takeaways: Fresh fish matters. Why choose Pokeworks? Check Monday hours.`;

/** 'many_vendors': a long ranked list, with name variants and accents, the brand last. */
export const MANY_VENDORS_ANSWER = `For poke in Austin the leading options are:

* **Pokeworks, Inc.** - best overall.
* **Sweetfin** - great vegan bowls.
* **Café Ñandú** - fusion bowls.
* **Bowl Brothers** - big portions.
* **Wild Tuna Co** - sustainable fish.
* **Ocean Bowl** - quick service.
* **Hula Poke** - classic recipes.
* **Kona Fresh** - lots of toppings.
* **Aloha Kitchen** - family owned.
* **Maui Bowls** - late hours.
* **Tide Poke** - downtown.
* **Reef Kitchen** - patio seating.
* **Poke House** - solid fresh fish.

Pokeworks Inc. is also popular with students. POKEWORKS has the longest queue.`;

export function startFakeGemini(port: number, getMode: () => FakeMode, slowMs = 2500): Promise<http.Server & { hits: () => number; narrativeRequests: () => any[] }> {
  let hits = 0;
  // Request bodies of the structured (narrative / lookup) calls, so a test can assert what the server ASKED, not only what it did with the answer.
  const structured: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      hits++;
      const mode = getMode();
      const wantsJson = body.includes('responseSchema');
      if (wantsJson) {
        try {
          structured.push(JSON.parse(body));
        } catch {
          /* not JSON */
        }
      }
      if (mode === 'slow') await new Promise((r) => setTimeout(r, slowMs));
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid. SECRET_PAYLOAD_MARKER', status: 'UNAUTHENTICATED' } }));
        return;
      }
      if (mode === 'narrative_fails' && wantsJson) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 500, message: 'internal SECRET_PAYLOAD_MARKER', status: 'INTERNAL' } }));
        return;
      }
      // 'partial_failure': the question about the menu cannot be answered (a non-retried 401), the other can.
      if (mode === 'partial_failure' && !wantsJson && body.includes('poke house menu')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid. SECRET_PAYLOAD_MARKER', status: 'UNAUTHENTICATED' } }));
        return;
      }
      // 'daily_quota': every call is refused with the provider's daily-quota error (the breaker trips on the first).
      if (mode === 'daily_quota') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, GenerateRequestsPerDayPerProjectPerModel-FreeTier', status: 'RESOURCE_EXHAUSTED' } }));
        return;
      }
      const isLookup = body.includes('Analyze the brand/business');
      const lookup = (domain: string) => JSON.stringify({ businessName: 'Acme Widgets', domain, industry: 'widgets', coreOfferings: 'widgets', targetAudience: 'buyers', competitors: [] });
      const text = wantsJson && isLookup && mode === 'lookup_placeholder'
        ? lookup('N/A')
        : wantsJson && isLookup && mode === 'lookup_good'
          ? lookup('https://www.Acme-Widgets.com/menu')
          : wantsJson
            ? JSON.stringify({
                executiveSummary:
                  mode === 'narrative_invented_numbers'
                    ? // One sentence of verified figures, an invented digit figure, a size-of-change word with no digit, an invented spelled-out figure, and one plain sentence.
                      'Poke House is named in 2 of 2 answers. Expect traffic to grow 47% after the fix. Traffic will double. Sales should improve within three months. Pokeworks is the main rival.'
                    : 'Narrative ok.',
                // 'narrative_findings': two claims about the SAME real answer, one about a
                // query that was never asked, one naming an engine that was never measured.
                inaccuracies:
                  mode === 'narrative_findings'
                    ? [
                        { engine: 'Gemini', queryNumber: 1, queryText: 'best poke in Austin', claimedFact: 'a', actualFact: 'b', impactSeverity: 'high' },
                        // same answer, query text paraphrased (case, quotes, punctuation): still attributable
                        { engine: 'gemini', queryText: '"Best Poke in Austin?"', claimedFact: 'c', actualFact: 'd', impactSeverity: 'low' },
                        { engine: 'Gemini', queryText: 'a question nobody asked', claimedFact: 'e', actualFact: 'f', impactSeverity: 'high' },
                        { engine: 'ChatGPT', queryText: 'best poke in Austin', claimedFact: 'g', actualFact: 'h', impactSeverity: 'high' },
                      ]
                    : mode === 'narrative_odd_values'
                      ? // one valid claim with a severity nobody defined, attributable to question 1
                        [{ engine: 'Gemini', queryNumber: 1, queryText: 'best poke in Austin', claimedFact: 'a', actualFact: 'b', impactSeverity: 'catastrophic' }]
                    : mode === 'narrative_unattributable'
                      ? [
                          { engine: 'Gemini', queryNumber: 99, queryText: 'a question nobody asked', claimedFact: 'e', actualFact: 'f', impactSeverity: 'high' },
                          { engine: 'ChatGPT', queryText: 'what are the best alternatives to poke house', claimedFact: 'g', actualFact: 'h', impactSeverity: 'high' },
                        ]
                      : [],
                omissions:
                  mode === 'narrative_odd_values'
                    ? // counts at, above and below the allowed range, and a fraction (a 2-question audit allows 0 to 2)
                      [2, 3, -1, 2.5].map((n, i) => ({ category: 'Schema & Entity Data', description: `Omission ${i + 1}`, affectedQueriesCount: n, rootCause: 'None', recommendation: 'Add markup' }))
                    : mode === 'narrative_invented_numbers'
                    ? // an impossible count for a 2-question audit
                      [{ category: 'Schema & Entity Data', description: 'Missing markup', affectedQueriesCount: 47, rootCause: 'None', recommendation: 'Add markup' }]
                    : [],
                remediationPlan:
                  mode === 'narrative_invented_numbers'
                    ? [{ title: 'Add schema', category: 'Schema & Entity Data', priority: 'P1 High', effort: 'Quick Win (< 2h)', description: 'Add JSON-LD', stepByStepInstructions: ['Add it'], targetUrls: [], expectedGain: '+40% visibility in 30 days' }]
                    : mode === 'narrative_remediation'
                    ? [{ title: 'Add schema', category: 'Schema & Entity Data', priority: 'P1 High', effort: 'Quick Win (< 2h)', description: 'Add JSON-LD', stepByStepInstructions: ['Add it'], targetUrls: [] }]
                    : [],
              })
            : mode === 'many_vendors'
              ? // the second question's answer never names the brand, so "who took the answer" is exercised
                body.includes('poke house menu')
                ? MANY_VENDORS_ANSWER.replace('* **Poke House** - solid fresh fish.\n', '')
                : MANY_VENDORS_ANSWER
              : FAKE_ANSWER;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text }], role: 'model' },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://yelp.com/biz/x', title: 'yelp.com' } }],
                webSearchQueries: ['poke austin'],
              },
              finishReason: 'STOP',
            },
          ],
        })
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(port, () => resolve(Object.assign(server, { hits: () => hits, narrativeRequests: () => structured })))
  );
}
