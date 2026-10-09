/**
 * A protocol-faithful fake Gemini endpoint with switchable behaviour, shared by
 * the newer end-to-end suites. It speaks the real generateContent response
 * shape (candidates, grounding chunks), so the real SDK inside the real built
 * server is what gets exercised - only the far end is fake. Nothing here
 * pretends to be a real engine's judgement: the answer text is fixed and
 * labelled as such in the tests that use it.
 */
import http from 'http';

export type FakeMode = 'ok' | 'narrative_fails' | 'narrative_remediation' | 'lookup_placeholder' | 'lookup_good' | 'unauthorized' | 'slow';

export const FAKE_ANSWER = `For poke in Austin, top picks are:

* **Pokeworks** - consistently rated highest.
* **Sweetfin** - great vegan bowls.
* **Poke House** - solid fresh fish.

According to Yelp and TripAdvisor, Pricing starts at $12. Key takeaways: Fresh fish matters. Why choose Pokeworks? Check Monday hours.`;

export function startFakeGemini(port: number, getMode: () => FakeMode, slowMs = 2500): Promise<http.Server & { hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      hits++;
      const mode = getMode();
      const wantsJson = body.includes('responseSchema');
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
      const isLookup = body.includes('Analyze the brand/business');
      const lookup = (domain: string) => JSON.stringify({ businessName: 'Acme Widgets', domain, industry: 'widgets', coreOfferings: 'widgets', targetAudience: 'buyers', competitors: [] });
      const text = wantsJson && isLookup && mode === 'lookup_placeholder'
        ? lookup('N/A')
        : wantsJson && isLookup && mode === 'lookup_good'
          ? lookup('https://www.Acme-Widgets.com/menu')
          : wantsJson
            ? JSON.stringify({
                executiveSummary: 'Narrative ok.',
                inaccuracies: [],
                omissions: [],
                remediationPlan:
                  mode === 'narrative_remediation'
                    ? [{ title: 'Add schema', category: 'Schema & Entity Data', priority: 'P1 High', effort: 'Quick Win (< 2h)', description: 'Add JSON-LD', stepByStepInstructions: ['Add it'], targetUrls: [] }]
                    : [],
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
    server.listen(port, () => resolve(Object.assign(server, { hits: () => hits })))
  );
}
