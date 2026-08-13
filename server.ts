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
  extractDomain,
  type QueryEvidence,
} from './src/analysis';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** Single source of truth for the audit model, so it can be swapped in one place. */
const AUDIT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

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

  // Helper: Fuzzy matching for Brand and Domain in grounding results
  const isBrandOrDomainCited = (
    businessName: string | undefined,
    domain: string | undefined,
    groundedText: string | undefined,
    groundingChunks: any[] | undefined
  ): boolean => {
    if (!businessName && !domain) return false;

    const textLower = (groundedText || '').toLowerCase();

    // 1. Clean domain and extract domain root (e.g. "archeraviation.com" -> "archeraviation")
    const rawDomain = (domain || '')
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');

    const domainParts = rawDomain.split('.').filter((p) => p.length >= 2);
    const domainRoot = domainParts[0] || rawDomain;

    // Check if domain or domainRoot appears in groundedText or groundingChunks
    let domainFound = false;

    if (rawDomain && rawDomain.length >= 3 && textLower.includes(rawDomain)) {
      domainFound = true;
    }
    if (!domainFound && domainRoot && domainRoot.length >= 3 && textLower.includes(domainRoot)) {
      domainFound = true;
    }

    if (!domainFound && groundingChunks && Array.isArray(groundingChunks)) {
      for (const chunk of groundingChunks) {
        const uri = (chunk.web?.uri || '').toLowerCase();
        const title = (chunk.web?.title || '').toLowerCase();

        if (rawDomain && (uri.includes(rawDomain) || title.includes(rawDomain))) {
          domainFound = true;
          break;
        }
        if (domainRoot && domainRoot.length >= 3 && (uri.includes(domainRoot) || title.includes(domainRoot))) {
          domainFound = true;
          break;
        }
      }
    }

    if (domainFound) return true;

    // 2. Clean brand name & sub-tokens (e.g. "Archer Aviation" -> "archer aviation", "archer")
    const rawBrand = (businessName || '').toLowerCase().trim();
    const stopWords = new Set([
      'inc',
      'llc',
      'corp',
      'corporation',
      'ltd',
      'company',
      'the',
      'and',
      'app',
      'io',
      'com',
      'ai',
      'co',
      'group',
      'services',
      'solutions',
      'software',
      'tech',
      'technologies'
    ]);

    const brandWords = rawBrand
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));

    const primaryBrandWord = brandWords[0] || rawBrand;

    let brandFound = false;

    // Check if full brand name or primary brand word appears in grounded response text
    if (rawBrand && textLower.includes(rawBrand)) {
      brandFound = true;
    } else if (primaryBrandWord && primaryBrandWord.length >= 3 && textLower.includes(primaryBrandWord)) {
      brandFound = true;
    }

    // Check if brand or brand words appear in search snippet titles
    if (!brandFound && groundingChunks && Array.isArray(groundingChunks)) {
      for (const chunk of groundingChunks) {
        const title = (chunk.web?.title || '').toLowerCase();
        if (rawBrand && title.includes(rawBrand)) {
          brandFound = true;
          break;
        }
        if (primaryBrandWord && primaryBrandWord.length >= 3 && title.includes(primaryBrandWord)) {
          brandFound = true;
          break;
        }
        for (const bw of brandWords) {
          if (bw.length >= 3 && title.includes(bw)) {
            brandFound = true;
            break;
          }
        }
        if (brandFound) break;
      }
    }

    return brandFound;
  };

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
Focus on high-intent real-world buyer queries that prospective customers ask AI search engines (like Perplexity, ChatGPT Search, Gemini, Claude, SearchGPT) regarding core offerings: "${coreOfferings || 'products & services'}".
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
  app.post('/api/audit/evaluate-query', async (req, res) => {
    try {
      const {
        businessName,
        domain,
        industry,
        coreOfferings,
        targetAudience,
        competitors,
        queryText
      } = req.body;

      if (!businessName || !queryText) {
        return res.status(400).json({ error: 'businessName and queryText are required' });
      }

      const ai = getGeminiClient();
      const queryId = `q-user-${Date.now()}`;

      if (!ai) {
        return res.json({
          evaluatedQuery: {
            id: queryId,
            intent: 'feature_specific',
            queryText,
            targetPersona: 'Target Customer',
            monthlySearchVolumeEstimate: '8,500/mo',
            engines: {
              Gemini: { engine: 'Gemini', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding unavailable.', citations: [] },
              ChatGPT: { engine: 'ChatGPT', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding unavailable.', citations: [] },
              Perplexity: { engine: 'Perplexity', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding unavailable.', citations: [] },
              Claude: { engine: 'Claude', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding unavailable.', citations: [] },
              SearchGPT: { engine: 'SearchGPT', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding unavailable.', citations: [] }
            }
          }
        });
      }

      // Step 1: Execute real grounded search using Gemini with googleSearch enabled and threshold 0.0
      let liveSourceUrls: string[] = [];
      let groundedText = '';
      let groundingChunks: any[] = [];

      try {
        const searchGrounded = await generateContentWithRetry(ai, {
          model: AUDIT_MODEL,
          contents: `Search Query: "${queryText}". Answer this user query as an AI Search Engine using live web search data. Indicate top recommended solutions and evaluate "${businessName}" (${domain || 'N/A'}) if relevant.`,
          config: {
            systemInstruction: 'You are a strict data auditing tool. Rely strictly on live web search grounding. Do not generate placeholders.',
            tools: [{ googleSearch: {} }]
          }
        });

        groundedText = searchGrounded.text || '';
        const candidate = searchGrounded.candidates?.[0];
        groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];

        // Debug Log Output for Grounding Metadata
        console.log('=== GROUNDING METADATA DEBUG (evaluate-query) ===');
        console.log(JSON.stringify(candidate?.groundingMetadata, null, 2));

        const extractedUrls = groundingChunks
          .map((c: any) => c.web?.uri)
          .filter((uri: any): uri is string => typeof uri === 'string' && uri.length > 0);

        liveSourceUrls = Array.from(new Set(extractedUrls));
      } catch (searchErr) {
        console.log('Single query grounding info: Fallback engaged');
      }

      // Fuzzy Brand & URL Matching
      const isBrandCited = isBrandOrDomainCited(businessName, domain, groundedText, groundingChunks);

      // Step 2: Evaluate 5 AI engine positions with live grounding context
      const evaluatePrompt = `You are an expert AI Search & Generative Engine Optimization (GEO) Auditor.
Evaluate how 5 AI Search Engines (Gemini, ChatGPT, Perplexity, Claude, SearchGPT) respond to this search query regarding "${businessName}" (Domain: ${domain || 'company.com'}):

QUERY: "${queryText}"
LIVE GROUNDED SEARCH RESPONSE:
${groundedText}

REAL GROUNDING SOURCE URLS FROM WEBPAGE CHUNKS:
${JSON.stringify(liveSourceUrls)}

IS BRAND CITED IN SEARCH GROUNDING: ${isBrandCited ? 'YES' : 'NO'}

INSTRUCTIONS:
Evaluate how each of the 5 AI Search engines responds:
- status: "recommended_leader" (ranked #1), "secondary_mention" (ranked #2 or #3), "omitted" (left out), "inaccurate_claim", or "negative_sentiment".
- position: 1, 2, 3, or null if omitted.
- excerpt: Concise summary quote.
- citations: Array of actual source URLs selected from REAL GROUNDING SOURCE URLS. If omitted, return [].
- keyInaccuracy: (if status is inaccurate_claim) brief explanation.
- keyOmissionReason: (if status is omitted) reason for omission.

Return a JSON object matching the schema.`;

      const engineResultSchema = {
        type: Type.OBJECT,
        properties: {
          engine: { type: Type.STRING },
          status: { type: Type.STRING },
          position: { type: Type.INTEGER },
          excerpt: { type: Type.STRING },
          citations: { type: Type.ARRAY, items: { type: Type.STRING } },
          keyInaccuracy: { type: Type.STRING },
          keyOmissionReason: { type: Type.STRING }
        },
        required: ['engine', 'status', 'excerpt', 'citations']
      };

      const response = await generateContentWithRetry(ai, {
        model: AUDIT_MODEL,
        contents: evaluatePrompt,
        config: {
          systemInstruction: 'You are a strict data auditing tool. Do not generate fictional URLs or metrics. Use only provided live source URLs.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              intent: { type: Type.STRING },
              targetPersona: { type: Type.STRING },
              monthlySearchVolumeEstimate: { type: Type.STRING },
              engines: {
                type: Type.OBJECT,
                properties: {
                  Gemini: engineResultSchema,
                  ChatGPT: engineResultSchema,
                  Perplexity: engineResultSchema,
                  Claude: engineResultSchema,
                  SearchGPT: engineResultSchema
                },
                required: ['Gemini', 'ChatGPT', 'Perplexity', 'Claude', 'SearchGPT']
              }
            },
            required: ['intent', 'targetPersona', 'monthlySearchVolumeEstimate', 'engines']
          }
        }
      });

      const parsed = parseJsonText(response.text);
      if (parsed && parsed.engines) {
        // Guarantee actual grounding URLs are attached if engine citations empty
        Object.keys(parsed.engines).forEach((engKey) => {
          const engObj = parsed.engines[engKey];
          if (!engObj.citations || engObj.citations.length === 0) {
            engObj.citations = isBrandCited ? liveSourceUrls : [];
          }
        });

        return res.json({
          evaluatedQuery: {
            id: queryId,
            intent: parsed.intent || 'feature_specific',
            queryText,
            targetPersona: parsed.targetPersona || 'Target Customer',
            monthlySearchVolumeEstimate: parsed.monthlySearchVolumeEstimate || '10,000/mo',
            engines: parsed.engines,
            isBrandCited
          }
        });
      }

      throw new Error('Failed to parse query evaluation response');
    } catch (err: any) {
      console.log('Single query evaluation info: Fallback engaged');
      const { queryText } = req.body;
      res.json({
        evaluatedQuery: {
          id: `q-user-${Date.now()}`,
          intent: 'feature_specific',
          queryText: queryText || 'Target Query',
          targetPersona: 'Target Customer',
          monthlySearchVolumeEstimate: '8,500/mo',
          engines: {
            Gemini: { engine: 'Gemini', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding returned no results.', citations: [] },
            ChatGPT: { engine: 'ChatGPT', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding returned no results.', citations: [] },
            Perplexity: { engine: 'Perplexity', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding returned no results.', citations: [] },
            Claude: { engine: 'Claude', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding returned no results.', citations: [] },
            SearchGPT: { engine: 'SearchGPT', status: 'omitted', position: null, excerpt: 'Insufficient Data - Live search grounding returned no results.', citations: [] }
          }
        }
      });
    }
  });

  // POST: Execute complete live AI Search Audit
  /**
   * Layer 1 - Evidence collection.
   * Runs one grounded answer-engine query and captures exactly what came back:
   * verbatim text, real source URLs, and the searches the engine actually ran.
   */
  async function collectQueryEvidence(
    aiInstance: any,
    query: any,
    businessName: string,
    domain?: string
  ): Promise<QueryEvidence> {
    const base: QueryEvidence = {
      queryId: query.id,
      queryText: query.queryText,
      answerText: '',
      citations: [],
      searchQueries: [],
      capturedAt: new Date().toISOString(),
      engine: 'Gemini (Google Search grounded)',
    };

    try {
      const response = await generateContentWithRetry(aiInstance, {
        model: AUDIT_MODEL,
        contents: `${query.queryText}`,
        config: {
          systemInstruction:
            'You are an AI search assistant answering a real user question. Use live web search. Recommend the specific vendors, products or providers that genuinely best answer the question, naming them explicitly. Do not mention that you are part of an audit.',
          tools: [{ googleSearch: {} }],
        },
      });

      const candidate = response.candidates?.[0];
      const metadata = candidate?.groundingMetadata;
      const chunks = metadata?.groundingChunks || [];

      const seen = new Set<string>();
      const citations = chunks
        .map((chunk: any) => {
          const url = chunk?.web?.uri || '';
          const title = chunk?.web?.title || '';
          // Grounding chunks expose the real publisher in `title` (often a bare
          // domain) while `uri` is a vertexaisearch redirect, so prefer the title.
          const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title.trim())
            ? title.trim().toLowerCase()
            : extractDomain(url);
          return { url, title, domain };
        })
        .filter((c: any) => {
          if (!c.url || seen.has(c.url)) return false;
          seen.add(c.url);
          return true;
        });

      return {
        ...base,
        answerText: response.text || '',
        citations,
        searchQueries: metadata?.webSearchQueries || [],
      };
    } catch (err: any) {
      console.log(`Evidence collection failed for "${query.queryText}": ${err?.message || err}`);
      return { ...base, error: err?.message || 'grounded search failed' };
    }
  }

  /**
   * Layer 3 - Narrative interpretation.
   * The model is given the captured evidence and the already-computed metrics.
   * It is asked only for qualitative judgement, never for numbers.
   */
  async function generateNarrative(aiInstance: any, ctx: any) {
    const evidenceDigest = ctx.evidenceList
      .map((ev: QueryEvidence, i: number) => {
        const row = ctx.perQuery[i].find((r: any) => r.brand === ctx.businessName);
        return [
          `QUERY ${i + 1}: "${ev.queryText}"`,
          `Client mentioned: ${row?.mentioned ? `YES (named #${row.rank} of the brands listed)` : 'NO'}`,
          `Brands named ahead of client: ${ctx.perQuery[i]
            .filter((r: any) => r.rank && (!row?.rank || r.rank < row.rank))
            .map((r: any) => r.brand)
            .join(', ') || 'none'}`,
          `Sources the engine cited: ${ev.citations.map((c) => c.domain).join(', ') || 'none'}`,
          `Answer excerpt: ${(ev.answerText || '').slice(0, 1200)}`,
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
Tracked competitors: ${ctx.competitorList.join(', ') || 'none supplied'}

MEASURED RESULTS (already computed from captured evidence - do NOT recompute or contradict these):
- Answer-engine visibility: cited in ${ctx.clientScore.timesMentioned} of ${ctx.totalQueries} queries (${ctx.clientScore.visibility}%)
- Share of voice vs tracked competitors: ${ctx.clientScore.shareOfVoice}%
- Named first in ${ctx.clientScore.timesFirst} of ${ctx.totalQueries} queries
- Client's own domain appeared as a cited source ${ctx.clientScore.citedAsSourceCount} times

COMPETITOR SCORECARD:
${ctx.scorecards.map((s: any) => `- ${s.brand}: mentioned in ${s.timesMentioned}/${ctx.totalQueries} queries, ${s.shareOfVoice}% share of voice, named first ${s.timesFirst}x`).join('\n')}

SOURCES THE ANSWER ENGINE ACTUALLY RELIED ON:
${topSources || 'none captured'}

RAW EVIDENCE:
${evidenceDigest}

Write the analysis. Rules:
- Ground every statement in the evidence above. Never invent a statistic, a citation, or a competitor.
- "inaccuracies": only list claims the engine made about ${ctx.businessName} that are wrong or misleading, quoting the claim verbatim from the evidence. If the evidence shows none, return an empty array. Never fabricate one to fill space.
- "omissions": explain WHY the brand is absent where it is absent, tied to the specific source domains above (e.g. absent from the review aggregators and comparison pages the engine cites). Use category values from: "Schema & Entity Data", "Review & Directory Signals", "Comparison & Top 10 Coverage", "Reddit / Forum Sentiment", "Pricing & Feature Clarity".
- "remediationPlan": 4-7 concrete tasks the client's marketing team can execute, each targeting a specific gap visible in the evidence. Prefer naming the exact source domains to go after. Include a realistic codeSnippet (valid JSON-LD) only where genuinely useful.
  priority: "P0 Critical" | "P1 High" | "P2 Medium" | "P3 Maintenance"
  effort: "Quick Win (< 2h)" | "Moderate (1-2 days)" | "Strategic (1-2 weeks)"
- "executiveSummary": 3-5 sentences a CMO can read. State the visibility position, who is winning the answer surface and why, and the single highest-leverage move.

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

      const queryList =
        Array.isArray(queries) && queries.length > 0
          ? queries
          : getFallbackQueries(businessName, domain, industry, coreOfferings, competitorList);

      if (!ai) {
        return res.json({
          report: generateSynthesizedAudit(businessName, domain, industry, coreOfferings, competitorList, queryList),
        });
      }

      // ---------- Layer 1: collect evidence ----------
      const evidenceList: QueryEvidence[] = [];
      for (let i = 0; i < queryList.length; i++) {
        if (i > 0) await delay(1200);
        evidenceList.push(await collectQueryEvidence(ai, queryList[i], businessName, domain));
      }

      const usable = evidenceList.filter((e) => !e.error && e.answerText.length > 0);
      if (usable.length === 0) {
        const degraded = generateSynthesizedAudit(
          businessName, domain, industry, coreOfferings, competitorList, queryList
        );
        degraded.executiveSummary =
          `Audit could not complete: live search grounding returned no answers for any of the ${queryList.length} queries. ` +
          `This is an upstream retrieval failure, not a finding about ${businessName}. Re-run the audit; if it persists the grounding quota or API key needs attention.`;
        return res.json({ report: degraded, degraded: true });
      }

      // ---------- Layer 2: deterministic analysis ----------
      const clientMatcher = buildBrandMatcher(businessName, domain);
      const competitorMatchers = competitorList.map((c: string) => buildBrandMatcher(c));
      const allMatchers = [clientMatcher, ...competitorMatchers];

      const perQuery = evidenceList.map((ev) => analyseAnswer(ev, allMatchers));
      const scorecards = buildScorecards(perQuery, allMatchers);
      const citationSources = buildCitationSourceMap(evidenceList, clientMatcher);
      const clientScore = scorecards[0];
      const totalQueries = evidenceList.length;

      // ---------- Layer 3: narrative ----------
      let narrative: any = null;
      try {
        await delay(800);
        narrative = await generateNarrative(ai, {
          businessName,
          domain: domain || 'company.com',
          industry: industry || 'Technology',
          coreOfferings: coreOfferings || 'Products and services',
          competitorList,
          evidenceList,
          perQuery,
          scorecards,
          clientScore,
          citationSources,
          totalQueries,
        });
      } catch (narrativeErr: any) {
        console.log(`Narrative synthesis failed: ${narrativeErr?.message || narrativeErr}`);
      }

      // ---------- Layer 4: assemble an honest report ----------
      const queriesTested = queryList.map((q: any, idx: number) => {
        const ev = evidenceList[idx];
        const row = perQuery[idx]?.find((r) => r.brand === businessName);
        const aheadOf = perQuery[idx]
          ?.filter((r) => r.rank && (!row?.rank || r.rank < row.rank))
          .map((r) => r.brand) || [];

        const status = !row || !row.mentioned
          ? 'omitted'
          : row.rank === 1
            ? 'recommended_leader'
            : 'secondary_mention';

        const excerpt = row?.excerpt
          || (ev?.error
            ? `Retrieval error: ${ev.error}`
            : `${businessName} was not named in this answer. Brands named instead: ${aheadOf.join(', ') || 'none identified'}.`);

        return {
          ...q,
          engines: {
            Gemini: {
              engine: 'Gemini',
              status,
              position: row?.rank ?? null,
              excerpt,
              citations: ev?.citations.map((c) => c.url) || [],
              keyOmissionReason:
                status === 'omitted' && aheadOf.length > 0
                  ? `Answer surface was taken by: ${aheadOf.join(', ')}`
                  : undefined,
            },
          },
          evidence: ev
            ? {
                answerText: ev.answerText,
                citations: ev.citations,
                searchQueries: ev.searchQueries,
                capturedAt: ev.capturedAt,
                engine: ev.engine,
                error: ev.error,
              }
            : undefined,
          competitorsAhead: aheadOf,
          prominence: row?.prominence ?? 0,
        };
      });

      const inaccuracies = (narrative?.inaccuracies || []).map((item: any, i: number) => ({
        id: `inacc-${i + 1}`,
        engine: 'Gemini',
        queryId: queryList.find((q: any) => q.queryText === item.queryText)?.id || queryList[0]?.id || `q-${i}`,
        queryText: item.queryText,
        claimedFact: item.claimedFact,
        actualFact: item.actualFact,
        impactSeverity: ['high', 'medium', 'low'].includes(item.impactSeverity) ? item.impactSeverity : 'medium',
        sourceOriginUrl: item.sourceOriginUrl,
      }));

      const mentionCount = clientScore.timesMentioned;
      const accuracyRate = mentionCount > 0
        ? Math.max(0, Math.round(((mentionCount - inaccuracies.length) / mentionCount) * 100))
        : 0;

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
          `${businessName} was cited in ${clientScore.timesMentioned} of ${totalQueries} audited answer-engine queries (${clientScore.visibility}% visibility), holding ${clientScore.shareOfVoice}% share of voice against ${competitorList.length} tracked competitors.`,

        queriesTested,
        inaccuracies,
        omissions: (narrative?.omissions || []).map((o: any, i: number) => ({
          id: `om-${i + 1}`,
          category: o.category,
          description: o.description,
          affectedQueriesCount: o.affectedQueriesCount ?? totalQueries - clientScore.timesMentioned,
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

        competitorBenchmarks: scorecards.map((s) => ({
          name: s.brand === businessName ? `${s.brand} (Your Business)` : s.brand,
          domain: s.domain || '',
          shareOfVoice: s.shareOfVoice,
          topRecommendedCount: s.timesFirst,
          mainCitationSources: citationSources
            .filter((src) => !src.isOwned)
            .slice(0, 4)
            .map((src) => src.domain),
        })),

        // New evidence-first artefacts.
        citationSources,
        measuredEngines: ['Gemini (Google Search grounded)'],
        queriesAttempted: queryList.length,
        queriesWithEvidence: usable.length,
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
      res.json({ report: fallback, degraded: true });
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
        SearchGPT: {
          engine: 'SearchGPT',
          status: 'omitted',
          position: null,
          excerpt: 'Insufficient Data - Live search grounding returned no citation results.',
          citations: []
        }
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
