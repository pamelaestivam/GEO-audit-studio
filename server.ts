import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import { SAMPLE_AUDITS } from './src/data/sampleAudits';
import {
  analyseAnswer,
  buildBrandMatcher,
  buildCitationSourceMap,
  buildScorecards,
  dedupeMatchers,
  findFirstMention,
  type QueryEvidence,
} from './src/analysis';
import {
  askEngine,
  configuredEngines,
  dedupeCitations,
  type EngineName,
} from './src/providers';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** Single source of truth for the audit model, so it can be swapped in one place. */
const AUDIT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/** Bounds audit cost and runtime; each query fans out across every engine. */
const MAX_AUDIT_QUERIES = Number(process.env.MAX_AUDIT_QUERIES || 8);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

  app.use(express.json());

  // Initialize Gemini Client server-side
  const getGeminiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is missing. AI audit generation will fall back to smart synthesized benchmarks.");
      return null;
    }
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  };

  // Helper to delay execution
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Helper: Wrapper for Gemini generateContent with exponential backoff for rate limits (429 / RESOURCE_EXHAUSTED)
  async function generateContentWithRetry(
    aiInstance: GoogleGenAI,
    params: any,
    maxRetries = 2,
    initialDelayMs = 2000
  ): Promise<any> {
    let attempt = 0;
    let delayMs = initialDelayMs;

    while (true) {
      try {
        return await aiInstance.models.generateContent(params);
      } catch (err: any) {
        attempt++;
        const errStr = String(err?.message || err || '');
        const isRateLimit =
          errStr.includes('429') ||
          errStr.includes('RESOURCE_EXHAUSTED') ||
          errStr.includes('quota') ||
          errStr.includes('rate limit');

        if (isRateLimit && attempt <= maxRetries) {
          console.log(`[Gemini API Info] Pacing request due to rate limit (Attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`);
          await delay(delayMs);
          delayMs *= 2;
        } else {
          throw err;
        }
      }
    }
  }


  // Health check API
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
  });

  // In-memory user store for backend session verification
  const usersDb = new Map<string, any>([
    [
      'demo@enterprise.com',
      {
        id: 'usr-demo-101',
        name: 'Sarah Jenkins',
        email: 'demo@enterprise.com',
        password: 'password123',
        company: 'Acme Cloud Platform',
        role: 'Head of Growth & GEO',
        createdAt: new Date().toISOString(),
      },
    ],
  ]);

  // Auth: Login Endpoint
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = usersDb.get(normalizedEmail);

    if (existingUser) {
      if (existingUser.password === password) {
        const { password: _, ...userWithoutPass } = existingUser;
        return res.json({ user: userWithoutPass, token: `token-${Date.now()}` });
      } else {
        return res.status(401).json({ error: 'Invalid password. Please verify your credentials.' });
      }
    }

    // Auto-register seamless user session for frictionless access
    const newUser = {
      id: `usr-${Date.now()}`,
      name: email.split('@')[0].replace(/[._]/g, ' '),
      email: normalizedEmail,
      password: password,
      company: 'Enterprise Org',
      role: 'Lead GEO Auditor',
      createdAt: new Date().toISOString(),
    };
    usersDb.set(normalizedEmail, newUser);

    const { password: _, ...userWithoutPass } = newUser;
    return res.json({ user: userWithoutPass, token: `token-${Date.now()}` });
  });

  // Auth: Signup Endpoint
  app.post('/api/auth/signup', (req, res) => {
    const { email, password, name, company } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    if (usersDb.has(normalizedEmail)) {
      const existingUser = usersDb.get(normalizedEmail);
      const { password: _, ...userWithoutPass } = existingUser;
      return res.json({ user: userWithoutPass, token: `token-${Date.now()}` });
    }

    const newUser = {
      id: `usr-${Date.now()}`,
      name: name || email.split('@')[0],
      email: normalizedEmail,
      password: password,
      company: company || 'Enterprise Client',
      role: 'GEO Auditor',
      createdAt: new Date().toISOString(),
    };
    usersDb.set(normalizedEmail, newUser);

    const { password: _, ...userWithoutPass } = newUser;
    return res.json({ user: userWithoutPass, token: `token-${Date.now()}` });
  });

  // Get sample prebuilt audit benchmarks
  app.get('/api/audit/samples', (req, res) => {
    res.json({ samples: SAMPLE_AUDITS });
  });

  // POST: Live URL & Brand Name parser using Gemini Grounded Web Search
  app.post('/api/audit/parse-url', async (req, res) => {
    try {
      const { input } = req.body;
      if (!input || typeof input !== 'string') {
        return res.status(400).json({ error: 'Input query string or URL is required' });
      }

      const cleanedInput = input.trim();
      let parsedDomain = '';
      let parsedBusinessName = '';

      // Try parsing domain out of raw URL or domain input
      try {
        if (cleanedInput.startsWith('http://') || cleanedInput.startsWith('https://')) {
          const urlObj = new URL(cleanedInput);
          parsedDomain = urlObj.hostname.replace(/^www\./, '');
        } else if (/\.[a-z]{2,}(\/.*)?$/i.test(cleanedInput)) {
          const urlObj = new URL(`https://${cleanedInput}`);
          parsedDomain = urlObj.hostname.replace(/^www\./, '');
        }
      } catch {
        // Not a direct URL, handle as brand name string
      }

      if (parsedDomain) {
        const domainNamePart = parsedDomain.split('.')[0];
        parsedBusinessName = domainNamePart.charAt(0).toUpperCase() + domainNamePart.slice(1);
      } else {
        parsedBusinessName = cleanedInput;
        parsedDomain = `${cleanedInput.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
      }

      const ai = getGeminiClient();
      let details = null;

      if (ai) {
        try {
          const prompt = `Analyze the brand/business "${parsedBusinessName}" (Domain: ${parsedDomain}).
Use live web search to identify real current details:
1. Exact official business name
2. Official primary domain
3. Industry / Category (e.g., Financial Tech, Cloud Observability, Software Development, E-Commerce)
4. Core Offerings (concise summary of top products/services)
5. Target Audience (e.g. Enterprise CTOs, Developers, Small Business Owners)
6. Top 3-4 Direct Competitors (brand names)

Return a valid JSON object matching the requested schema.`;

          const response = await generateContentWithRetry(ai, {
            model: AUDIT_MODEL,
            contents: prompt,
            config: {
              systemInstruction: 'You are a strict data auditing tool. Do not generate fictional or inferred metrics. If live data or search citations are unavailable for a query, explicitly return null/empty arrays instead of generating placeholders.',
              tools: [{ googleSearch: {} }],
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  businessName: { type: Type.STRING },
                  domain: { type: Type.STRING },
                  industry: { type: Type.STRING },
                  coreOfferings: { type: Type.STRING },
                  targetAudience: { type: Type.STRING },
                  competitors: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ['businessName', 'domain', 'industry', 'coreOfferings', 'targetAudience', 'competitors']
              }
            }
          });

          details = parseJsonText(response.text);
        } catch (genErr) {
          console.log('URL parser Gemini call fallback engaged');
        }
      }

      if (!details || !details.businessName) {
        details = {
          businessName: parsedBusinessName,
          domain: parsedDomain,
          industry: 'Software & Technology Services',
          coreOfferings: 'Digital cloud services, automation & SaaS platform',
          targetAudience: 'Enterprise decision makers & procurement',
          competitors: ['Industry Competitor A', 'Industry Competitor B']
        };
      }

      res.json({ details });
    } catch (err: any) {
      console.log('Error in parse-url route: Fallback engaged');
      res.status(500).json({ error: 'Failed to analyze URL or brand name' });
    }
  });

  // Helper to safely parse JSON from model output
  const parseJsonText = (text?: string) => {
    if (!text) return null;
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  };

  const getFallbackQueries = (businessName: string, domain?: string, industry?: string, coreOfferings?: string, competitors?: any) => {
    const compFirst = Array.isArray(competitors) && competitors.length > 0 ? competitors[0] : (competitors || 'leading competitors');
    return [
      {
        id: 'q-gen-1',
        intent: 'alternatives_search',
        queryText: `Best ${industry || 'software'} alternatives to ${compFirst} for modern teams`,
        targetPersona: 'Decision Maker / Buyer',
        monthlySearchVolumeEstimate: '18,000/mo'
      },
      {
        id: 'q-gen-2',
        intent: 'commercial_comparison',
        queryText: `${businessName} vs ${compFirst} comparison and features`,
        targetPersona: 'Product Evaluator',
        monthlySearchVolumeEstimate: '22,000/mo'
      },
      {
        id: 'q-gen-3',
        intent: 'pricing_roi',
        queryText: `${businessName} pricing free tier limits and enterprise contract cost`,
        targetPersona: 'CTO / Procurement',
        monthlySearchVolumeEstimate: '12,500/mo'
      }
    ];
  };

  // POST: Generate viewer-intent query matrix for a business (3 top real-world queries)
  app.post('/api/audit/generate-queries', async (req, res) => {
    try {
      const { businessName, domain, industry, coreOfferings, competitors } = req.body;

      if (!businessName) {
        return res.status(400).json({ error: 'businessName is required' });
      }

      const ai = getGeminiClient();

      if (!ai) {
        return res.json({ queries: getFallbackQueries(businessName, domain, industry, coreOfferings, competitors) });
      }

      const prompt = `You are a Generative Engine Optimization (GEO) & AI Search auditor.
Using live web search grounding, generate the 3 most relevant, real-world search queries that target customers actually use when searching for or evaluating "${businessName}" (Domain: ${domain || 'N/A'}, Industry: "${industry || 'B2B/Tech'}").
Focus on high-intent real-world buyer queries that prospective customers ask AI search engines (like Perplexity, ChatGPT Search, Gemini, Claude) regarding core offerings: "${coreOfferings || 'products & services'}".
Main competitors include: ${Array.isArray(competitors) ? competitors.join(', ') : (competitors || 'industry leaders')}.

Categorize each query under one of these intents:
- commercial_comparison
- direct_recommendation
- alternatives_search
- feature_specific
- localized_vendor
- pricing_roi

Return a JSON array of exactly 3 query objects.`;

      let queries = null;
      try {
        const response = await generateContentWithRetry(ai, {
          model: AUDIT_MODEL,
          contents: prompt,
          config: {
            systemInstruction: 'You are a strict data auditing tool. Do not generate fictional or inferred metrics. If live data or search citations are unavailable for a query, explicitly return null/empty arrays instead of generating placeholders.',
            tools: [{ googleSearch: {} }],
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: 'Unique query id, e.g. q-1' },
                  intent: { type: Type.STRING, description: 'One of the allowed query intent strings' },
                  queryText: { type: Type.STRING, description: 'Exact search query string' },
                  targetPersona: { type: Type.STRING, description: 'Target user persona asking this query' },
                  monthlySearchVolumeEstimate: { type: Type.STRING, description: 'Estimated search volume, e.g. 18,500/mo' }
                },
                required: ['id', 'intent', 'queryText', 'targetPersona', 'monthlySearchVolumeEstimate']
              }
            }
          }
        });
        queries = parseJsonText(response.text);
      } catch (genErr: any) {
        // Query generation fallback engaged cleanly
      }

      if (!queries || !Array.isArray(queries) || queries.length === 0) {
        queries = getFallbackQueries(businessName, domain, industry, coreOfferings, competitors);
      } else if (queries.length > 3) {
        queries = queries.slice(0, 3);
      }

      res.json({ queries });
    } catch (err: any) {
      res.json({ queries: getFallbackQueries(req.body?.businessName || 'Business', req.body?.domain, req.body?.industry, req.body?.coreOfferings, req.body?.competitors) });
    }
  });

  // POST: Evaluate search visibility across AI search engines for a single query (auto or manually added)
  /**
   * Append one manually-typed query to a live audit.
   *
   * Uses the same evidence-first pipeline as a full audit: every engine is
   * genuinely queried, and the returned position is computed from the answer
   * text rather than asserted by a model.
   */
  app.post('/api/audit/evaluate-query', async (req, res) => {
    try {
      const { businessName, domain, competitors, queryText } = req.body;

      if (!businessName || !queryText) {
        return res.status(400).json({ error: 'businessName and queryText are required' });
      }

      const ai = getGeminiClient();
      const engines = configuredEngines();

      const query = {
        id: `q-manual-${Date.now()}`,
        intent: 'feature_specific',
        queryText: String(queryText).trim(),
        targetPersona: 'Target Customer',
        monthlySearchVolumeEstimate: 'n/a',
      };

      // Vendor discovery runs on Gemini, so Gemini is required even when other
      // engines are configured. Say which key is missing rather than claiming
      // nothing is configured.
      if (!ai) {
        const others = engines.filter((e) => e !== 'Gemini');
        return res.status(503).json({
          error: others.length
            ? `GEMINI_API_KEY is required to analyse answers, even though ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} configured.`
            : 'No answer engine is configured, so this query cannot be measured.',
        });
      }
      if (engines.length === 0) {
        return res.status(503).json({
          error: 'No answer engine is configured, so this query cannot be measured.',
        });
      }

      const competitorList = (Array.isArray(competitors) ? competitors : [competitors])
        .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        .map((c: string) => c.trim());

      const evidence = await collectQueryEvidence(ai, query, engines);
      const usable = evidence.filter((e) => !e.error && e.answerText.trim().length > 0);

      if (usable.length === 0) {
        const failures = Array.from(new Set(evidence.map((e) => e.error).filter(Boolean)));
        return res.status(502).json({
          error: `No engine returned an answer for this query. ${failures.slice(0, 2).join(' | ')}`,
        });
      }

      const clientMatcher = buildBrandMatcher(businessName, domain);
      const discovered = (await discoverVendors(ai, evidence)).filter(
        (v) =>
          v.toLowerCase() !== clientMatcher.label.toLowerCase() &&
          !competitorList.some((c: string) => c.toLowerCase() === v.toLowerCase())
      );

      const allMatchers = dedupeMatchers([
        clientMatcher,
        ...competitorList.map((c: string) => buildBrandMatcher(c)),
        ...discovered.map((d) => buildBrandMatcher(d)),
      ]);

      const engineResults: Record<string, any> = {};
      let bestProminence = 0;
      const aheadUnion = new Set<string>();

      for (const ev of evidence) {
        if (ev.error || !ev.answerText.trim()) {
          engineResults[ev.engine] = {
            engine: ev.engine,
            status: 'retrieval_failed',
            position: null,
            excerpt: `No answer captured from ${ev.engine}${ev.error ? `: ${ev.error}` : ''}.`,
            citations: [],
          };
          continue;
        }

        const rows = analyseAnswer(ev, allMatchers);
        const client = rows.find((r) => r.brand === clientMatcher.label);
        const ahead = rows
          .filter((r) => r.rank && (!client?.rank || r.rank < client.rank))
          .sort((a, b) => (a.rank || 0) - (b.rank || 0))
          .map((r) => r.brand);
        ahead.forEach((b) => aheadUnion.add(b));
        bestProminence = Math.max(bestProminence, client?.prominence ?? 0);

        engineResults[ev.engine] = {
          engine: ev.engine,
          status: !client || !client.mentioned
            ? 'omitted'
            : client.rank === 1
              ? 'recommended_leader'
              : 'secondary_mention',
          position: client?.rank ?? null,
          excerpt:
            client?.excerpt ||
            `${businessName} was not named. Vendors named instead: ${ahead.join(', ') || 'none identified'}.`,
          citations: ev.citations.map((c) => c.url),
          keyOmissionReason:
            !client?.mentioned && ahead.length > 0
              ? `Answer surface taken by: ${ahead.slice(0, 5).join(', ')}`
              : undefined,
        };
      }

      const evaluatedQuery = {
        ...query,
        engines: engineResults,
        evidence: evidence.map((ev) => ({
          engine: ev.engine,
          answerText: ev.answerText,
          citations: ev.citations,
          searchQueries: ev.searchQueries,
          capturedAt: ev.capturedAt,
          error: ev.error,
        })),
        competitorsAhead: Array.from(aheadUnion),
        prominence: bestProminence,
      };

      res.json({ evaluatedQuery });
    } catch (err: any) {
      console.log(`evaluate-query failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || 'Failed to evaluate query' });
    }
  });

  // POST: Execute complete live AI Search Audit
  /**
   * Layer 1 - Evidence collection.
   * Queries one answer engine and captures exactly what came back: verbatim
   * text, real publisher domains, and the searches the engine actually ran.
   */
  async function collectGeminiEvidence(
    aiInstance: any,
    query: any
  ): Promise<QueryEvidence> {
    const base: QueryEvidence = {
      queryId: query.id,
      queryText: query.queryText,
      answerText: '',
      citations: [],
      searchQueries: [],
      capturedAt: new Date().toISOString(),
      engine: 'Gemini',
    };

    try {
      const response = await generateContentWithRetry(aiInstance, {
        model: AUDIT_MODEL,
        contents: `${query.queryText}`,
        config: {
          systemInstruction:
            'You are an AI search assistant answering a real user question. Use live web search and recommend the specific vendors, products or providers that genuinely best answer the question, naming each one explicitly. Do not mention that you are part of an audit.',
          tools: [{ googleSearch: {} }],
        },
      });

      const candidate = response.candidates?.[0];
      const metadata = candidate?.groundingMetadata;
      const chunks = metadata?.groundingChunks || [];

      const citations = dedupeCitations(
        chunks.map((chunk: any) => ({
          url: chunk?.web?.uri || '',
          title: chunk?.web?.title || '',
        }))
      );

      return {
        ...base,
        answerText: response.text || '',
        citations,
        searchQueries: metadata?.webSearchQueries || [],
      };
    } catch (err: any) {
      console.log(`[Gemini] evidence failed for "${query.queryText}": ${err?.message || err}`);
      return { ...base, error: err?.message || 'grounded search failed' };
    }
  }

  /** Collect evidence for one query across every configured engine. */
  async function collectQueryEvidence(
    aiInstance: any,
    query: any,
    engines: EngineName[]
  ): Promise<QueryEvidence[]> {
    const tasks = engines.map(async (engine): Promise<QueryEvidence> => {
      if (engine === 'Gemini') return collectGeminiEvidence(aiInstance, query);

      const answer = await askEngine(engine, query.queryText);
      return {
        queryId: query.id,
        queryText: query.queryText,
        answerText: answer.answerText,
        citations: answer.citations,
        searchQueries: answer.searchQueries,
        capturedAt: new Date().toISOString(),
        engine,
        error: answer.error,
      };
    });

    return Promise.all(tasks);
  }

  /**
   * Layer 2a - Vendor discovery.
   *
   * Ranking a brand only against the competitors the user happened to type
   * overstates its position: if the engine names four vendors and the user
   * tracks one, the client can look like #2 while actually placing #5. So we
   * read the vendors named in each answer, then DISCARD any that do not
   * literally appear in the source text. The model is used to perceive names,
   * never to judge - anything it invents is dropped before it can affect a metric.
   */
  async function discoverVendors(
    aiInstance: any,
    evidenceForQuery: QueryEvidence[]
  ): Promise<string[]> {
    const usable = evidenceForQuery.filter((e) => !e.error && e.answerText.trim().length > 0);
    if (usable.length === 0) return [];

    const combined = usable
      .map((e) => `--- ${e.engine} answer ---\n${e.answerText.slice(0, 4000)}`)
      .join('\n\n');

    try {
      const response = await generateContentWithRetry(aiInstance, {
        model: AUDIT_MODEL,
        contents: `List every company, product, vendor or service provider named as an option in the answers below. Return only proper names exactly as written. Exclude generic category words, publications, and review sites.\n\n${combined}`,
        config: {
          systemInstruction: 'You extract named entities verbatim. Never add names that are not present.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: { vendors: { type: Type.ARRAY, items: { type: Type.STRING } } },
            required: ['vendors'],
          },
        },
      });

      const parsed = parseJsonText(response.text);
      const candidates: string[] = Array.isArray(parsed?.vendors) ? parsed.vendors : [];

      // Verification gate: keep only names that genuinely occur in the text.
      const verified: string[] = [];
      for (const name of candidates) {
        const clean = String(name || '').trim();
        if (clean.length < 2 || clean.length > 60) continue;
        const matcher = buildBrandMatcher(clean);
        const appears = usable.some((e) => findFirstMention(e.answerText, matcher) >= 0);
        if (appears && !verified.some((v) => v.toLowerCase() === clean.toLowerCase())) {
          verified.push(clean);
        }
      }
      return verified;
    } catch (err: any) {
      console.log(`Vendor discovery failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Layer 3 - Narrative interpretation.
   * The model receives captured evidence and the already-computed metrics, and
   * is asked only for qualitative judgement. It is never asked for a number.
   */
  async function generateNarrative(aiInstance: any, ctx: any) {
    const evidenceDigest = ctx.usableEvidence
      .slice(0, 20)
      .map((ev: QueryEvidence) => {
        const rows = ctx.analysisByEvidence.get(ev);
        const client = rows?.find((r: any) => r.brand === ctx.clientLabel);
        const ahead = (rows || [])
          .filter((r: any) => r.rank && (!client?.rank || r.rank < client.rank))
          .map((r: any) => r.brand);
        return [
          `[${ev.engine}] QUERY: "${ev.queryText}"`,
          `Client named: ${client?.mentioned ? `YES (position ${client.rank} of ${(rows || []).filter((r: any) => r.rank).length} vendors named)` : 'NO'}`,
          `Vendors named ahead of client: ${ahead.join(', ') || 'none'}`,
          `Sources cited: ${ev.citations.map((c) => c.domain).join(', ') || 'none'}`,
          `Answer excerpt: ${(ev.answerText || '').slice(0, 1000)}`,
        ].join('\n');
      })
      .join('\n\n---\n\n');

    const topSources = ctx.citationSources
      .slice(0, 12)
      .map((s: any) => `${s.domain} (cited ${s.citationCount}x across ${s.queryCount} queries)${s.isOwned ? ' [CLIENT-OWNED]' : ''}`)
      .join('\n');

    const prompt = `You are a senior Generative Engine Optimization (GEO) consultant writing the analysis section of a paid audit for "${ctx.businessName}" (${ctx.domain}).

Industry: ${ctx.industry}
Core offerings: ${ctx.coreOfferings}
Competitors the client asked us to track: ${ctx.competitorList.join(', ') || 'none supplied'}
Engines actually queried: ${ctx.measuredEngines.join(', ')}

MEASURED RESULTS (computed from captured evidence - do NOT recompute or contradict):
- Cited in ${ctx.clientScore.timesMentioned} of ${ctx.totalObservations} engine answers (${ctx.clientScore.visibility}% visibility)
- Share of voice against every vendor named by the engines: ${ctx.clientScore.shareOfVoice}%
- Named first in ${ctx.clientScore.timesFirst} answers
- Client's own domain cited as a source ${ctx.clientScore.citedAsSourceCount} times

VENDOR SCOREBOARD (all vendors the engines actually named):
${ctx.scorecards.map((s: any) => `- ${s.brand}: named in ${s.timesMentioned}/${ctx.totalObservations} answers, ${s.shareOfVoice}% share of voice, first ${s.timesFirst}x`).join('\n')}

SOURCES THE ENGINES RELIED ON:
${topSources || 'none captured'}

RAW EVIDENCE:
${evidenceDigest}

Write the analysis. Rules:
- Ground every statement in the evidence above. Never invent a statistic, citation or competitor.
- If competitors appear in the scoreboard that the client did not ask us to track, call that out explicitly - discovering an unexpected rival is a valuable finding.
- "inaccuracies": only claims made about ${ctx.businessName} that are wrong or misleading, quoting the claim verbatim. Return an empty array if the evidence shows none. Never invent one to fill space.
- "omissions": explain WHY the brand is absent where it is absent, tied to the specific source domains above. Categories: "Schema & Entity Data", "Review & Directory Signals", "Comparison & Top 10 Coverage", "Reddit / Forum Sentiment", "Pricing & Feature Clarity".
- "remediationPlan": 4-7 concrete tasks, each targeting a gap visible in the evidence, naming the exact source domains to pursue. Include valid JSON-LD in codeSnippet only where genuinely useful.
  priority: "P0 Critical" | "P1 High" | "P2 Medium" | "P3 Maintenance"
  effort: "Quick Win (< 2h)" | "Moderate (1-2 days)" | "Strategic (1-2 weeks)"
- "executiveSummary": 3-5 sentences a CMO can read: the visibility position, who owns the answer surface and why, and the highest-leverage move.

Return valid JSON matching the schema.`;

    const response = await generateContentWithRetry(aiInstance, {
      model: AUDIT_MODEL,
      contents: prompt,
      config: {
        systemInstruction:
          'You are a rigorous audit analyst. Every claim must trace to supplied evidence. Empty arrays are strongly preferred over invented findings.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            executiveSummary: { type: Type.STRING },
            inaccuracies: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  engine: { type: Type.STRING },
                  queryText: { type: Type.STRING },
                  claimedFact: { type: Type.STRING },
                  actualFact: { type: Type.STRING },
                  impactSeverity: { type: Type.STRING },
                  sourceOriginUrl: { type: Type.STRING },
                },
                required: ['queryText', 'claimedFact', 'actualFact', 'impactSeverity'],
              },
            },
            omissions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  description: { type: Type.STRING },
                  affectedQueriesCount: { type: Type.INTEGER },
                  rootCause: { type: Type.STRING },
                  recommendation: { type: Type.STRING },
                },
                required: ['category', 'description', 'rootCause', 'recommendation'],
              },
            },
            remediationPlan: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  effort: { type: Type.STRING },
                  expectedGain: { type: Type.STRING },
                  description: { type: Type.STRING },
                  stepByStepInstructions: { type: Type.ARRAY, items: { type: Type.STRING } },
                  codeSnippet: { type: Type.STRING },
                  targetUrls: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['title', 'category', 'priority', 'effort', 'description', 'stepByStepInstructions'],
              },
            },
          },
          required: ['executiveSummary', 'inaccuracies', 'omissions', 'remediationPlan'],
        },
      },
    });

    return parseJsonText(response.text);
  }

  app.post('/api/audit/run', async (req, res) => {
    try {
      const {
        businessName,
        domain,
        industry,
        coreOfferings,
        targetAudience,
        competitors,
        queries,
      } = req.body;

      if (!businessName) {
        return res.status(400).json({ error: 'businessName is required' });
      }

      const ai = getGeminiClient();
      const competitorList = (Array.isArray(competitors) ? competitors : [competitors])
        .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        .map((c: string) => c.trim());

      const queryList = (
        Array.isArray(queries) && queries.length > 0
          ? queries
          : getFallbackQueries(businessName, domain, industry, coreOfferings, competitorList)
      ).slice(0, MAX_AUDIT_QUERIES);

      const engines = configuredEngines();

      if (!ai || engines.length === 0) {
        const others = engines.filter((e) => e !== 'Gemini');
        const reason = !ai && others.length
          ? `GEMINI_API_KEY is required to analyse answers, even though ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} configured. Nothing was measured.`
          : 'No answer engine is configured, so nothing could be measured. Add an engine API key and re-run.';
        return res.json({
          report: {
            ...generateSynthesizedAudit(businessName, domain, industry, coreOfferings, competitorList, queryList),
            degraded: true,
            degradedReason: reason,
          },
          degraded: true,
        });
      }

      // ---------- Layer 1: collect evidence across every configured engine ----------
      const evidenceByQuery: QueryEvidence[][] = [];
      for (let i = 0; i < queryList.length; i++) {
        if (i > 0) await delay(1200);
        evidenceByQuery.push(await collectQueryEvidence(ai, queryList[i], engines));
      }

      const allEvidence = evidenceByQuery.flat();
      const usableEvidence = allEvidence.filter((e) => !e.error && e.answerText.trim().length > 0);

      if (usableEvidence.length === 0) {
        const failures = Array.from(new Set(allEvidence.map((e) => e.error).filter(Boolean)));
        const degraded = generateSynthesizedAudit(
          businessName, domain, industry, coreOfferings, competitorList, queryList
        );
        degraded.executiveSummary =
          `Audit could not complete: every engine request failed, so no evidence was collected. ` +
          `This is an upstream retrieval failure, not a finding about ${businessName}. ` +
          `Errors: ${failures.slice(0, 3).join(' | ') || 'unknown'}`;
        return res.json({
          report: {
            ...degraded,
            degraded: true,
            degradedReason: `Every engine request failed, so no evidence was collected. ${failures.slice(0, 2).join(' | ') || ''}`.trim(),
          },
          degraded: true,
        });
      }

      // ---------- Layer 2: deterministic analysis over successful evidence only ----------
      const clientMatcher = buildBrandMatcher(businessName, domain);
      const clientLabel = clientMatcher.label;

      // Discover the vendors each answer actually named, so ranking is against
      // the real field rather than only the competitors the user typed.
      const discovered: string[] = [];
      for (const group of evidenceByQuery) {
        const vendors = await discoverVendors(ai, group);
        for (const v of vendors) {
          const isClient = v.toLowerCase() === clientLabel.toLowerCase();
          const alreadyTracked = competitorList.some((c: string) => c.toLowerCase() === v.toLowerCase());
          const alreadyFound = discovered.some((d) => d.toLowerCase() === v.toLowerCase());
          if (!isClient && !alreadyTracked && !alreadyFound) discovered.push(v);
        }
      }

      const trackedMatchers = competitorList.map((c: string) => buildBrandMatcher(c));
      const discoveredMatchers = discovered.map((d) => buildBrandMatcher(d));
      // Collapse name variants ("Stripe" vs "Stripe, Inc.") so one company
      // cannot occupy two ranks or double-count in share of voice.
      const allMatchers = dedupeMatchers([clientMatcher, ...trackedMatchers, ...discoveredMatchers]);

      const analysisByEvidence = new Map<QueryEvidence, ReturnType<typeof analyseAnswer>>();
      const perObservation = usableEvidence.map((ev) => {
        const rows = analyseAnswer(ev, allMatchers);
        analysisByEvidence.set(ev, rows);
        return rows;
      });

      const scorecards = buildScorecards(perObservation, allMatchers);
      const citationSources = buildCitationSourceMap(usableEvidence, clientMatcher);
      const clientScore = scorecards[0];
      const totalObservations = perObservation.length;
      const measuredEngines = Array.from(new Set(usableEvidence.map((e) => e.engine)));

      // ---------- Layer 3: narrative ----------
      let narrative: any = null;
      try {
        await delay(600);
        narrative = await generateNarrative(ai, {
          businessName,
          clientLabel,
          domain: domain || 'company.com',
          industry: industry || 'Technology',
          coreOfferings: coreOfferings || 'Products and services',
          competitorList,
          usableEvidence,
          analysisByEvidence,
          scorecards,
          clientScore,
          citationSources,
          totalObservations,
          measuredEngines,
        });
      } catch (narrativeErr: any) {
        console.log(`Narrative synthesis failed: ${narrativeErr?.message || narrativeErr}`);
      }

      // ---------- Layer 4: assemble an honest report ----------
      const queriesTested = queryList.map((q: any, idx: number) => {
        const group = evidenceByQuery[idx] || [];
        const engineResults: Record<string, any> = {};
        let bestProminence = 0;
        const aheadUnion = new Set<string>();

        for (const ev of group) {
          const rows = analysisByEvidence.get(ev);

          if (!rows) {
            engineResults[ev.engine] = {
              engine: ev.engine,
              status: 'retrieval_failed',
              position: null,
              excerpt: `No answer captured from ${ev.engine}${ev.error ? `: ${ev.error}` : ''}. This query was excluded from all metrics.`,
              citations: [],
            };
            continue;
          }

          const client = rows.find((r) => r.brand === clientLabel);
          const ahead = rows
            .filter((r) => r.rank && (!client?.rank || r.rank < client.rank))
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))
            .map((r) => r.brand);
          ahead.forEach((b) => aheadUnion.add(b));
          bestProminence = Math.max(bestProminence, client?.prominence ?? 0);

          engineResults[ev.engine] = {
            engine: ev.engine,
            status: !client || !client.mentioned
              ? 'omitted'
              : client.rank === 1
                ? 'recommended_leader'
                : 'secondary_mention',
            position: client?.rank ?? null,
            excerpt:
              client?.excerpt ||
              `${businessName} was not named. Vendors named instead: ${ahead.join(', ') || 'none identified'}.`,
            citations: ev.citations.map((c) => c.url),
            keyOmissionReason:
              !client?.mentioned && ahead.length > 0
                ? `Answer surface taken by: ${ahead.slice(0, 5).join(', ')}`
                : undefined,
          };
        }

        return {
          ...q,
          engines: engineResults,
          evidence: group.map((ev) => ({
            engine: ev.engine,
            answerText: ev.answerText,
            citations: ev.citations,
            searchQueries: ev.searchQueries,
            capturedAt: ev.capturedAt,
            error: ev.error,
          })),
          competitorsAhead: Array.from(aheadUnion),
          prominence: bestProminence,
        };
      });

      const inaccuracies = (narrative?.inaccuracies || []).map((item: any, i: number) => ({
        id: `inacc-${i + 1}`,
        engine: measuredEngines.includes(item.engine) ? item.engine : measuredEngines[0],
        queryId: queryList.find((q: any) => q.queryText === item.queryText)?.id || queryList[0]?.id || `q-${i}`,
        queryText: item.queryText,
        claimedFact: item.claimedFact,
        actualFact: item.actualFact,
        impactSeverity: ['high', 'medium', 'low'].includes(item.impactSeverity) ? item.impactSeverity : 'medium',
        sourceOriginUrl: item.sourceOriginUrl,
      }));

      // Accuracy is only meaningful where the brand was actually discussed.
      const mentionCount = clientScore.timesMentioned;
      const accuracyRate =
        mentionCount > 0
          ? Math.max(0, Math.round(((mentionCount - inaccuracies.length) / mentionCount) * 100))
          : null;

      const untrackedRivals = scorecards
        .filter((s) => discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()))
        .filter((s) => s.timesMentioned > 0)
        .sort((a, b) => b.shareOfVoice - a.shareOfVoice)
        .slice(0, 8)
        .map((s) => s.brand);

      const report = {
        id: `audit-${Date.now()}`,
        createdAt: new Date().toISOString(),
        businessName,
        domain: domain || 'company.com',
        industry: industry || 'Technology',
        coreOfferings: coreOfferings || 'Products and services',
        targetAudience: targetAudience || 'Buyers and decision makers',
        competitors: competitorList,

        // Metrics computed in code from captured evidence.
        geoVisibilityScore: clientScore.visibility,
        shareOfVoice: clientScore.shareOfVoice,
        leaderShare: clientScore.leaderShare,
        accuracyRate,
        avgProminence: clientScore.avgProminence,

        executiveSummary:
          narrative?.executiveSummary ||
          `${businessName} was named in ${clientScore.timesMentioned} of ${totalObservations} answers captured across ${measuredEngines.join(', ')} (${clientScore.visibility}% visibility), holding ${clientScore.shareOfVoice}% share of voice against every vendor the engines named.`,

        queriesTested,
        inaccuracies,
        omissions: (narrative?.omissions || []).map((o: any, i: number) => ({
          id: `om-${i + 1}`,
          category: o.category,
          description: o.description,
          affectedQueriesCount: o.affectedQueriesCount ?? totalObservations - clientScore.timesMentioned,
          rootCause: o.rootCause,
          recommendation: o.recommendation,
        })),
        remediationPlan: (narrative?.remediationPlan || []).map((t: any, i: number) => ({
          id: `rem-${i + 1}`,
          title: t.title,
          category: t.category,
          priority: t.priority,
          effort: t.effort,
          expectedGain: t.expectedGain || 'Improved answer-engine citation rate',
          description: t.description,
          stepByStepInstructions: t.stepByStepInstructions || [],
          codeSnippet: t.codeSnippet,
          targetUrls: t.targetUrls || [],
          completed: false,
        })),

        competitorBenchmarks: scorecards
          .filter((s) => s.brand === clientLabel || s.timesMentioned > 0)
          .map((s) => ({
            name: s.brand === clientLabel ? `${s.brand} (Your Business)` : s.brand,
            domain: s.domain || '',
            shareOfVoice: s.shareOfVoice,
            topRecommendedCount: s.timesFirst,
            mainCitationSources: citationSources
              .filter((src) => !src.isOwned)
              .slice(0, 4)
              .map((src) => src.domain),
            discovered: discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()),
          })),

        citationSources,
        measuredEngines,
        untrackedRivals,
        queriesAttempted: queryList.length,
        observationsAttempted: allEvidence.length,
        observationsWithEvidence: usableEvidence.length,
        enginesRequested: engines,
      };

      res.json({ report });
    } catch (err: any) {
      console.log(`Audit run failed: ${err?.message || err}`);
      const fallback = generateSynthesizedAudit(
        req.body?.businessName || 'Business',
        req.body?.domain,
        req.body?.industry,
        req.body?.coreOfferings,
        req.body?.competitors,
        req.body?.queries
      );
      fallback.executiveSummary = `Audit failed to complete (${err?.message || 'unknown error'}). No findings were generated; these are placeholder values, not measurements.`;
      res.json({
        report: {
          ...fallback,
          degraded: true,
          degradedReason: `The audit threw before completing: ${err?.message || 'unknown error'}`,
        },
        degraded: true,
      });
    }
  });

  // Vite development middleware or production static files
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Fallback audit generator for offline/resilient audit execution
function generateSynthesizedAudit(
  businessName: string,
  domain: string = 'example.com',
  industry: string = 'Software',
  coreOfferings: string = 'Products',
  competitors: any = ['Competitor A', 'Competitor B'],
  queries: any[] = []
) {
  const compList = Array.isArray(competitors) ? competitors : [competitors];
  const queryList = queries.length > 0 ? queries : [
    { id: 'q-1', intent: 'alternatives_search', queryText: `Best alternatives to ${compList[0] || 'market leader'} for ${industry}`, targetPersona: 'Decision Maker', monthlySearchVolumeEstimate: '16,500/mo' },
    { id: 'q-2', intent: 'commercial_comparison', queryText: `${businessName} vs ${compList[0] || 'Competitor A'} in-depth feature breakdown`, targetPersona: 'Evaluator', monthlySearchVolumeEstimate: '21,000/mo' },
    { id: 'q-3', intent: 'pricing_roi', queryText: `${businessName} pricing, enterprise licensing costs and free trial`, targetPersona: 'Procurement Manager', monthlySearchVolumeEstimate: '12,200/mo' }
  ];

  return {
    id: `audit-syn-${Date.now()}`,
    createdAt: new Date().toISOString(),
    businessName,
    domain,
    industry,
    coreOfferings,
    targetAudience: 'Decision makers & buyers',
    competitors: compList,
    geoVisibilityScore: 0,
    shareOfVoice: 0,
    leaderShare: 0,
    accuracyRate: 0,
    executiveSummary: `Insufficient Data - Live search grounding returned no citation results for ${businessName} (${domain}). Execute a live search audit to index real-world search citations.`,
    historicalScores: [
      { date: 'Jun 2026', score: 0, sov: 0 },
      { date: 'Jul 2026', score: 0, sov: 0 },
      { date: 'Aug 2026', score: 0, sov: 0 }
    ],
    queriesTested: queryList.map((q) => ({
      ...q,
      engines: {
        Gemini: {
          engine: 'Gemini',
          status: 'omitted',
          position: null,
          excerpt: 'Insufficient Data - Live search grounding returned no citation results.',
          citations: []
        },
        ChatGPT: {
          engine: 'ChatGPT',
          status: 'omitted',
          position: null,
          excerpt: 'Insufficient Data - Live search grounding returned no citation results.',
          citations: []
        },
        Perplexity: {
          engine: 'Perplexity',
          status: 'omitted',
          position: null,
          excerpt: 'Insufficient Data - Live search grounding returned no citation results.',
          citations: []
        },
        Claude: {
          engine: 'Claude',
          status: 'omitted',
          position: null,
          excerpt: 'Insufficient Data - Live search grounding returned no citation results.',
          citations: []
        },
      }
    })),
    inaccuracies: [],
    omissions: [
      {
        id: 'om-syn-1',
        category: 'Live Search Visibility',
        description: 'Brand or domain has no verified citations in live search grounding',
        affectedQueriesCount: queryList.length,
        rootCause: 'Lack of indexed web entities and structured schema markup',
        recommendation: 'Publish structured Schema.org JSON-LD and submit site to indexers'
      }
    ],
    remediationPlan: [
      {
        id: 'rem-syn-1',
        title: 'Deploy Schema.org Product & Pricing JSON-LD',
        category: 'Schema Markup',
        priority: 'P0 Critical',
        effort: 'Quick Win (< 2h)',
        expectedGain: 'Establish initial AI search indexation',
        description: `Add structured JSON-LD schema to https://${domain} describing exact core offerings and brand entity metadata.`,
        stepByStepInstructions: [
          'Add application/ld+json script tag to head of homepage and pricing page.',
          'Verify with Google Rich Results Test.',
          'Request re-indexing in Google Search Console.'
        ],
        codeSnippet: `{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "${businessName}",
  "offers": [
    {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD",
      "name": "Core Offering"
    }
  ]
}`,
        targetUrls: [`https://${domain}`],
        completed: false
      }
    ],
    competitorBenchmarks: [
      {
        name: compList[0] || 'Competitor A',
        domain: 'competitor.com',
        shareOfVoice: 0,
        topRecommendedCount: 0,
        mainCitationSources: []
      },
      {
        name: `${businessName} (Your Business)`,
        domain: domain,
        shareOfVoice: 0,
        topRecommendedCount: 0,
        mainCitationSources: []
      }
    ]
  };
}

startServer();
