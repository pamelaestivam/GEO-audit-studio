#!/usr/bin/env node
/**
 * Engine probe: what do real answer engines actually return? (docs/PLAN_2026-11.md P1)
 *
 * Plain Node, no dependency. For each candidate whose key is in the environment it asks a few fixed, harmless
 * questions and prints one block per call: the HTTP status, whether a web search ran, how many sources came
 * back, the NAMES of the reply's top-level and second-level fields, the reply cut at 4,000 characters, and on an
 * error the status and the first 500 characters of the body.
 *
 * THE LOG IS PUBLIC (the repository is public, and a workflow log is readable by anyone). Everything printed goes
 * through `scrub`, which removes every key value, anything shaped like `projects/<digits>` and any run of ten or
 * more digits. Nothing is ever written to a file or uploaded.
 *
 * Usage: node scripts/engine-probe.mjs [--questions N] [--candidates all|gemini,mistral,groq]
 * Keys: PROBE_GEMINI_API_KEY, PROBE_MISTRAL_API_KEY, PROBE_GROQ_API_KEY. A candidate with no key prints a SKIP line.
 * The *_BASE_URL variables exist so the test can point each provider at a local fake; they are not for real runs.
 * Budget: at most 20 calls a run (PROBE_CALL_BUDGET may only lower it); a run that would exceed it is refused whole.
 */

const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash-lite'];
const MISTRAL_MODEL = 'mistral-medium-latest';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const QUESTIONS = [
  'What are the best poke restaurants in Austin, Texas?',
  'What are the best-rated ramen restaurants in Seattle, Washington?',
  'What are the best coffee shops in Portland, Oregon?',
];
const MAX_QUESTIONS = 3;
const HARD_BUDGET = 20;
const REPLY_CUT = 4000;
const ERROR_CUT = 500;
const TIMEOUT_MS = 60000;

const env = process.env;
const KEY_VARS = ['PROBE_GEMINI_API_KEY', 'PROBE_MISTRAL_API_KEY', 'PROBE_GROQ_API_KEY'];

/** Remove everything that must never reach a public log. */
export function scrub(text, keys = KEY_VARS.map((k) => env[k]).filter(Boolean)) {
  let s = String(text ?? '');
  for (const k of keys) {
    if (k && k.length >= 4) s = s.split(k).join('[key removed]');
  }
  s = s.replace(/projects\/\d+/gi, 'projects/[number removed]');
  s = s.replace(/\d{10,}/g, '[number removed]');
  return s;
}
const out = (line = '') => console.log(scrub(line));

function args(argv) {
  const a = { questions: 2, candidates: 'all' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--questions') a.questions = Number(argv[++i]);
    else if (argv[i] === '--candidates') a.candidates = String(argv[++i] || 'all');
    else {
      out(`REFUSED: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return a;
}

async function post(url, headers, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: printed as text below */
    }
    return { status: res.status, ok: res.ok, text, json };
  } catch (e) {
    return { status: 0, ok: false, text: `no reply: ${e?.cause?.code || e?.name || 'error'} ${e?.message || ''}`, json: null };
  }
}

/** Names only: top-level and second-level field names of a reply. */
export function fieldNames(json) {
  if (!json || typeof json !== 'object') return '(not an object)';
  const parts = [];
  for (const [k, v] of Object.entries(json)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) parts.push(`${k}{${Object.keys(v).join(',')}}`);
    else if (Array.isArray(v) && v[0] && typeof v[0] === 'object') parts.push(`${k}[{${Object.keys(v[0]).join(',')}}]`);
    else parts.push(k);
  }
  return parts.join(' ');
}

function block(label, r, read) {
  out(`--- ${label}`);
  out(`HTTP status: ${r.status}`);
  if (!r.ok) {
    out(`error body (first ${ERROR_CUT} characters): ${r.text.slice(0, ERROR_CUT)}`);
    out('web search ran: unknown (no answer)');
    out('');
    return;
  }
  const info = read(r.json);
  out(`web search ran: ${info.searched ? 'yes' : 'no'}`);
  out(`sources returned: ${info.sources}`);
  out(`fields: ${fieldNames(r.json)}`);
  const text = info.text || '';
  out(`reply (${text.length} characters${text.length > REPLY_CUT ? `, cut at ${REPLY_CUT}` : ''}): ${text.slice(0, REPLY_CUT)}`);
  out('');
}

// ---------- Gemini ----------
export function readGemini(j) {
  const cand = j?.candidates?.[0];
  const gm = cand?.groundingMetadata;
  const queries = Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries.length : 0;
  const chunks = Array.isArray(gm?.groundingChunks) ? gm.groundingChunks.length : 0;
  const text = (cand?.content?.parts || []).map((p) => p?.text || '').join('');
  return { searched: queries > 0 || chunks > 0, sources: chunks, text };
}
async function geminiCall(base, key, model, question, extra) {
  return post(`${base}/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': key }, {
    contents: [{ role: 'user', parts: [{ text: question }] }],
    ...extra,
  });
}
async function probeGemini(n, key) {
  const base = env.PROBE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  for (const model of GEMINI_MODELS) {
    out(`=== Gemini ${model}`);
    let r = await geminiCall(base, key, model, QUESTIONS[0], {});
    block(`${model}: (a) plain call, no tools`, r, readGemini);
    for (let i = 0; i < n; i++) {
      r = await geminiCall(base, key, model, QUESTIONS[i], { tools: [{ googleSearch: {} }] });
      block(`${model}: (b) search call ${i + 1} of ${n}: ${QUESTIONS[i]}`, r, readGemini);
    }
    r = await geminiCall(base, key, model, `List the two best poke restaurants in Austin, Texas as JSON with a "names" array.`, {
      tools: [{ googleSearch: {} }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { names: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['names'] },
      },
    });
    block(`${model}: (c) look-up shape: search together with a JSON reply and a schema`, r, readGemini);
  }
}

// ---------- Mistral ----------
export function readMistral(j) {
  const outputs = Array.isArray(j?.outputs) ? j.outputs : [];
  let searched = outputs.some((o) => /tool\.execution|tool_execution/.test(String(o?.type)) && /search/.test(String(o?.name || '')));
  let sources = 0;
  let text = '';
  for (const o of outputs) {
    const c = o?.content;
    if (typeof c === 'string') text += c;
    else if (Array.isArray(c))
      for (const ch of c) {
        if (ch?.type === 'text') text += ch.text || '';
        if (ch?.type === 'tool_reference') sources++;
      }
  }
  if (sources > 0) searched = true;
  return { searched, sources, text };
}
async function probeMistral(n, key) {
  const base = env.PROBE_MISTRAL_BASE_URL || 'https://api.mistral.ai';
  out(`=== Mistral ${MISTRAL_MODEL}`);
  for (let i = 0; i < n; i++) {
    const r = await post(`${base}/v1/conversations`, { authorization: `Bearer ${key}` }, {
      model: MISTRAL_MODEL,
      inputs: QUESTIONS[i],
      tools: [{ type: 'web_search' }],
      store: false,
    });
    block(`${MISTRAL_MODEL}: search call ${i + 1} of ${n}: ${QUESTIONS[i]}`, r, readMistral);
  }
}

// ---------- Groq ----------
export function readGroq(j) {
  const m = j?.choices?.[0]?.message;
  const executed = Array.isArray(m?.executed_tools) ? m.executed_tools : [];
  const annotations = Array.isArray(m?.annotations) ? m.annotations : [];
  let sources = annotations.length;
  for (const t of executed) {
    const results = t?.search_results?.results;
    if (Array.isArray(results)) sources = Math.max(sources, results.length);
  }
  return { searched: executed.length > 0 || annotations.length > 0, sources, text: m?.content || '' };
}
async function probeGroq(n, key) {
  const base = env.PROBE_GROQ_BASE_URL || 'https://api.groq.com';
  out(`=== Groq ${GROQ_MODEL}`);
  const call = (q, tools) =>
    post(`${base}/openai/v1/chat/completions`, { authorization: `Bearer ${key}` }, {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: q }],
      ...(tools ? { tools } : {}),
    });
  for (let i = 0; i < n; i++) {
    const r = await call(QUESTIONS[i], [{ type: 'browser_search' }]);
    block(`${GROQ_MODEL}: browser_search call ${i + 1} of ${n}: ${QUESTIONS[i]}`, r, readGroq);
  }
  const r = await call(QUESTIONS[0], null);
  block(`${GROQ_MODEL}: one plain call, no tools`, r, readGroq);
}

const CANDIDATES = {
  gemini: { name: 'Gemini', keyVar: 'PROBE_GEMINI_API_KEY', calls: (n) => 2 * n + 4, run: probeGemini },
  mistral: { name: 'Mistral', keyVar: 'PROBE_MISTRAL_API_KEY', calls: (n) => n, run: probeMistral },
  groq: { name: 'Groq', keyVar: 'PROBE_GROQ_API_KEY', calls: (n) => n + 1, run: probeGroq },
};

async function main() {
  const a = args(process.argv.slice(2));
  if (!Number.isInteger(a.questions) || a.questions < 1 || a.questions > MAX_QUESTIONS) {
    out(`REFUSED: --questions must be a whole number from 1 to ${MAX_QUESTIONS} (got ${a.questions}). Nothing was called.`);
    process.exit(2);
  }
  const wanted = a.candidates === 'all' ? Object.keys(CANDIDATES) : a.candidates.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((w) => !CANDIDATES[w]);
  if (unknown.length || wanted.length === 0) {
    out(`REFUSED: unknown candidate(s) ${unknown.join(', ') || '(none given)'}; choose from ${Object.keys(CANDIDATES).join(', ')} or all. Nothing was called.`);
    process.exit(2);
  }
  const budget = Math.min(HARD_BUDGET, Number(env.PROBE_CALL_BUDGET) || HARD_BUDGET);
  const active = [];
  for (const w of wanted) {
    const c = CANDIDATES[w];
    if (env[c.keyVar]) active.push(c);
    else out(`SKIP ${c.name}: no key`);
  }
  if (active.length === 0) {
    out('SKIP all: no key at all, nothing was called. Add the secrets named in docs/PROGRAM.md O-8.');
    return;
  }
  const planned = active.reduce((s, c) => s + c.calls(a.questions), 0);
  if (planned > budget) {
    out(`REFUSED: this run would make ${planned} calls and the budget is ${budget}. Nothing was called. Use fewer questions or fewer candidates.`);
    process.exit(2);
  }
  out(`engine probe: ${active.map((c) => c.name).join(', ')}; ${a.questions} question(s); ${planned} call(s) planned (budget ${budget}).`);
  out('');
  for (const c of active) {
    try {
      await c.run(a.questions, env[c.keyVar]);
    } catch (e) {
      out(`ERROR ${c.name}: the probe itself failed: ${e?.message || e}`);
    }
  }
  out(`engine probe finished: ${planned} call(s) made.`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    out(`ERROR: ${e?.message || e}`);
    process.exit(1);
  });
}
