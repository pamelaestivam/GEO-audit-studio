/**
 * Answer-engine provider adapters.
 *
 * Each adapter performs a genuine web-grounded call to a different vendor and
 * returns the answer text plus the sources that vendor actually cited. An engine
 * is only ever queried when its API key is configured; a missing key means the
 * engine is reported as "not measured" rather than being simulated by another
 * model.
 */

import { extractDomain } from './analysis';

export type EngineName = 'Gemini' | 'ChatGPT' | 'Perplexity' | 'Claude';

export const ALL_ENGINES: EngineName[] = ['Gemini', 'ChatGPT', 'Perplexity', 'Claude'];

export interface EngineAnswer {
  engine: EngineName;
  answerText: string;
  citations: { url: string; title: string; domain: string }[];
  searchQueries: string[];
  error?: string;
}

/** Redirect and proxy hosts that are not real publishers. */
const NON_PUBLISHER_HOSTS = [
  'vertexaisearch.cloud.google.com',
  'googleusercontent.com',
  'grounding-api-redirect',
  'bing.com/ck/a',
];

export function isPublisherDomain(domain: string): boolean {
  if (!domain) return false;
  return !NON_PUBLISHER_HOSTS.some((bad) => domain.includes(bad));
}

/**
 * Resolve the publishing domain for a citation. Grounded providers often return
 * a redirect URL alongside the true publisher in the title field.
 */
export function resolveCitationDomain(url: string, title: string): string {
  const trimmed = (title || '').trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed)) return trimmed.toLowerCase();
  const fromUrl = extractDomain(url);
  if (isPublisherDomain(fromUrl)) return fromUrl;
  return '';
}

function dedupeCitations(raw: { url: string; title: string }[]) {
  const seen = new Set<string>();
  const out: { url: string; title: string; domain: string }[] = [];
  for (const c of raw) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    const domain = resolveCitationDomain(c.url, c.title);
    if (!domain) continue;
    out.push({ url: c.url, title: c.title || domain, domain });
  }
  return out;
}

export function configuredEngines(): EngineName[] {
  const engines: EngineName[] = [];
  if (process.env.GEMINI_API_KEY) engines.push('Gemini');
  if (process.env.OPENAI_API_KEY) engines.push('ChatGPT');
  if (process.env.PERPLEXITY_API_KEY) engines.push('Perplexity');
  if (process.env.ANTHROPIC_API_KEY) engines.push('Claude');
  return engines;
}

const ANSWER_SYSTEM_PROMPT =
  'You are an AI search assistant answering a real user question. Search the web and recommend the specific vendors, products or providers that genuinely best answer the question, naming each one explicitly. Do not mention that you are part of an audit.';

async function postJson(url: string, headers: Record<string, string>, body: any, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI Responses API with the hosted web_search tool. */
async function askOpenAI(query: string): Promise<EngineAnswer> {
  const base: EngineAnswer = { engine: 'ChatGPT', answerText: '', citations: [], searchQueries: [] };
  try {
    const data = await postJson(
      'https://api.openai.com/v1/responses',
      { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      {
        model: process.env.OPENAI_MODEL || 'gpt-5',
        instructions: ANSWER_SYSTEM_PROMPT,
        input: query,
        tools: [{ type: 'web_search' }],
      }
    );

    const rawCitations: { url: string; title: string }[] = [];
    const searchQueries: string[] = [];
    const textParts: string[] = [];

    for (const item of data.output || []) {
      if (item.type === 'web_search_call') {
        const q = item.action?.query || item.query;
        if (q) searchQueries.push(q);
      }
      for (const block of item.content || []) {
        if (typeof block.text === 'string') textParts.push(block.text);
        for (const ann of block.annotations || []) {
          if (ann.url) rawCitations.push({ url: ann.url, title: ann.title || '' });
        }
      }
    }

    // Prefer the convenience field when present; otherwise stitch the blocks.
    const answerText =
      typeof data.output_text === 'string' && data.output_text.length > 0
        ? data.output_text
        : textParts.join('\n');

    return { ...base, answerText, citations: dedupeCitations(rawCitations), searchQueries };
  } catch (err: any) {
    return { ...base, error: err?.message || 'OpenAI request failed' };
  }
}

/** Perplexity Sonar models search the web natively. */
async function askPerplexity(query: string): Promise<EngineAnswer> {
  const base: EngineAnswer = { engine: 'Perplexity', answerText: '', citations: [], searchQueries: [] };
  try {
    const data = await postJson(
      'https://api.perplexity.ai/chat/completions',
      { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
      {
        model: process.env.PERPLEXITY_MODEL || 'sonar',
        messages: [
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
      }
    );

    const answerText = data.choices?.[0]?.message?.content || '';

    // Newer responses carry search_results; older ones a bare citations array.
    const rawCitations: { url: string; title: string }[] = [];
    for (const r of data.search_results || []) {
      if (r?.url) rawCitations.push({ url: r.url, title: r.title || '' });
    }
    for (const c of data.citations || []) {
      if (typeof c === 'string') rawCitations.push({ url: c, title: '' });
      else if (c?.url) rawCitations.push({ url: c.url, title: c.title || '' });
    }

    return { ...base, answerText, citations: dedupeCitations(rawCitations) };
  } catch (err: any) {
    return { ...base, error: err?.message || 'Perplexity request failed' };
  }
}

/** Anthropic Messages API with the web_search server tool. */
async function askAnthropic(query: string): Promise<EngineAnswer> {
  const base: EngineAnswer = { engine: 'Claude', answerText: '', citations: [], searchQueries: [] };
  try {
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      }
    );

    let answerText = '';
    const rawCitations: { url: string; title: string }[] = [];
    const searchQueries: string[] = [];

    for (const block of data.content || []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        answerText += block.text;
        for (const cit of block.citations || []) {
          if (cit.url) rawCitations.push({ url: cit.url, title: cit.title || '' });
        }
      }
      if (block.type === 'server_tool_use' && block.input?.query) {
        searchQueries.push(block.input.query);
      }
      if (block.type === 'web_search_tool_result') {
        for (const r of block.content || []) {
          if (r?.url) rawCitations.push({ url: r.url, title: r.title || '' });
        }
      }
    }

    return { ...base, answerText, citations: dedupeCitations(rawCitations), searchQueries };
  } catch (err: any) {
    return { ...base, error: err?.message || 'Anthropic request failed' };
  }
}

/** Query one non-Gemini engine. Gemini is handled in server.ts via its SDK. */
export async function askEngine(engine: EngineName, query: string): Promise<EngineAnswer> {
  switch (engine) {
    case 'ChatGPT':
      return askOpenAI(query);
    case 'Perplexity':
      return askPerplexity(query);
    case 'Claude':
      return askAnthropic(query);
    default:
      return {
        engine,
        answerText: '',
        citations: [],
        searchQueries: [],
        error: `${engine} must be queried through its own SDK path`,
      };
  }
}

export { dedupeCitations };
