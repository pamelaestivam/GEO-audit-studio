/**
 * Answer-engine provider adapters.
 *
 * Each adapter performs a genuine web-grounded call to a different vendor and
 * returns the answer text plus the sources that vendor cited in it. (For Claude
 * that is the citations on the answer's text blocks - not every search result the
 * tool retrieved, which would inflate Claude's source counts.) An engine
 * is only ever queried when its API key is configured; a missing key means the
 * engine is reported as "not measured" rather than being simulated by another
 * model.
 */

import { extractDomain } from './analysis.js';
import { describeProviderError, type ReadableError } from './errors.js';

export type EngineName = 'Gemini' | 'ChatGPT' | 'Perplexity' | 'Claude';

export const ALL_ENGINES: EngineName[] = ['Gemini', 'ChatGPT', 'Perplexity', 'Claude'];

export interface EngineAnswer {
  engine: EngineName;
  answerText: string;
  citations: { url: string; title: string; domain: string }[];
  searchQueries: string[];
  /** A readable sentence, already worded for this provider - never a raw payload. */
  error?: string;
  errorKind?: ReadableError['kind'];
  /** The raw provider text, for the server log only. */
  rawError?: string;
}

/** A failed lookup whose reason this adapter already knows in words. */
function failed(base: EngineAnswer, message: string, kind: ReadableError['kind'] = 'unknown'): EngineAnswer {
  return { ...base, error: message, errorKind: kind };
}

/** A failed lookup from a thrown HTTP/network error: described once, here, for the right provider. */
function failedFrom(base: EngineAnswer, err: any, fallback: string): EngineAnswer {
  const raw = String(err?.message || fallback);
  const readable = describeProviderError(raw, base.engine);
  return { ...base, error: readable.message, errorKind: readable.kind, rawError: raw };
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

/**
 * The default Claude model. `claude-sonnet-4-5` was the default until it was
 * deprecated (2026-09-30, retired 2026-11-30 per Anthropic's model deprecations
 * page): a default that stops answering turns every Claude observation into a
 * failed lookup on the retirement date. Override with ANTHROPIC_MODEL.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

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
    let refusal = '';

    for (const item of data.output || []) {
      if (item.type === 'web_search_call') {
        const q = item.action?.query || item.query;
        if (q) searchQueries.push(q);
      }
      for (const block of item.content || []) {
        if (block?.type === 'refusal' && typeof block.refusal === 'string') {
          refusal = block.refusal;
        }
        if (typeof block.text === 'string') textParts.push(block.text);
        for (const ann of block.annotations || []) {
          if (ann.url) rawCitations.push({ url: ann.url, title: ann.title || '' });
        }
      }
    }

    // A 200 that carries no finished answer must read as a failed lookup, not as
    // "the brand was not named".
    if (data.status === 'failed' || data.status === 'incomplete' || data.error) {
      const why = data.error?.message || data.incomplete_details?.reason || data.status;
      return failed(base, `ChatGPT did not finish its answer (${String(why).slice(0, 120)}), so it was not counted. Re-run the audit.`);
    }
    // Prefer the convenience field when present; otherwise stitch the blocks.
    const answerText =
      typeof data.output_text === 'string' && data.output_text.length > 0
        ? data.output_text
        : textParts.join('\n');

    if (!answerText.trim() && refusal) {
      return failed(base, 'ChatGPT declined to answer this question, so it was not counted.');
    }
    return { ...base, answerText, citations: dedupeCitations(rawCitations), searchQueries };
  } catch (err: any) {
    return failedFrom(base, err, 'OpenAI request failed');
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

    if (data.error) {
      return failed(base, `Perplexity returned an error instead of an answer (${String(data.error?.message || data.error).slice(0, 120)}). Re-run the audit.`);
    }
    const rawContent = data.choices?.[0]?.message?.content;
    const answerText = Array.isArray(rawContent)
      ? rawContent.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('')
      : typeof rawContent === 'string'
        ? rawContent
        : '';

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
    return failedFrom(base, err, 'Perplexity request failed');
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
        model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
        // Output tokens are the narration, the search queries and the vendor list;
        // retrieved pages are input. 2000 was close to the ceiling for a list-heavy
        // answer, and a truncated answer is now (correctly) a failed lookup.
        max_tokens: 4096,
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      }
    );

    let answerText = '';
    const rawCitations: { url: string; title: string }[] = [];
    const searchQueries: string[] = [];

    // `data.content` is a list of blocks; so is a search result's `content` - except
    // when the search itself failed, where Anthropic answers HTTP 200 with a single
    // `web_search_tool_result_error` OBJECT there (too_many_requests, unavailable,
    // ...). Iterating that object threw, discarding an answer that had been written.
    const asList = (v: unknown): any[] => (Array.isArray(v) ? v : []);
    // Adjacent text blocks are ONE passage split at citation boundaries ("Pokeworks"
    // + "'s menu"), so they are concatenated exactly. Text on either side of a tool
    // call is separate prose ("...search for that." + "Based on..."), and is
    // separated by a blank line so the two sentences do not run together.
    let toolBoundary = false;
    for (const block of asList(data.content)) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        answerText += (toolBoundary && answerText ? '\n\n' : '') + block.text;
        toolBoundary = false;
        for (const cit of asList(block.citations)) {
          if (cit?.url) rawCitations.push({ url: cit.url, title: cit.title || '' });
        }
      } else if (block?.type === 'server_tool_use' || block?.type === 'web_search_tool_result') {
        toolBoundary = true;
      }
      if (block?.type === 'server_tool_use' && block.input?.query) {
        searchQueries.push(block.input.query);
      }
    }

    // Only a finished answer is an answer. An answer that stopped early (length
    // limit, a paused search, a refusal, an exceeded context window) is not one
    // that left the brand out, and counted as success it would be scored as
    // "brand not named".
    const stop = data.stop_reason;
    if (stop !== undefined && stop !== null && stop !== 'end_turn' && stop !== 'stop_sequence') {
      const why =
        stop === 'max_tokens' ? 'it hit the length limit' : stop === 'pause_turn' ? 'its search was paused' : stop === 'refusal' ? 'it declined' : `it stopped with "${String(stop).slice(0, 40)}"`;
      return failed(base, `Claude's answer was cut off before it finished (${why}), so it was not counted. Re-run the audit.`);
    }

    return { ...base, answerText, citations: dedupeCitations(rawCitations), searchQueries };
  } catch (err: any) {
    return failedFrom(base, err, 'Anthropic request failed');
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
