/**
 * A protocol-faithful fake Gemini endpoint with switchable behaviour, shared by
 * the newer end-to-end suites. It speaks the real generateContent response
 * shape (candidates, grounding chunks), so the real SDK inside the real built
 * server is what gets exercised - only the far end is fake. Nothing here
 * pretends to be a real engine's judgement: the answer text is fixed and
 * labelled as such in the tests that use it.
 */
import http from 'http';

export type FakeMode = 'ok' | 'narrative_fails' | 'narrative_findings' | 'narrative_unattributable' | 'unauthorized' | 'slow';

export const FAKE_ANSWER = `For poke in Austin, top picks are:

* **Pokeworks** - consistently rated highest.
* **Sweetfin** - great vegan bowls.
* **Poke House** - solid fresh fish.

According to Yelp and TripAdvisor, Pricing starts at $12. Key takeaways: Fresh fish matters. Why choose Pokeworks? Check Monday hours.`;

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
      const text = wantsJson
        ? JSON.stringify({
            executiveSummary: 'Narrative ok.',
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
                : mode === 'narrative_unattributable'
                  ? [
                      { engine: 'Gemini', queryNumber: 99, queryText: 'a question nobody asked', claimedFact: 'e', actualFact: 'f', impactSeverity: 'high' },
                      { engine: 'ChatGPT', queryText: 'what are the best alternatives to poke house', claimedFact: 'g', actualFact: 'h', impactSeverity: 'high' },
                    ]
                  : [],
            omissions: [],
            remediationPlan: [],
          })
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
