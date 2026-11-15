/**
 * The engine probe (scripts/engine-probe.mjs, docs/PLAN_2026-11.md P1), run as a real child process against local fakes of the
 * three providers. What is proved:
 *   - the printed blocks: status, "web search ran", source count, field names, the reply, and on an error the status and body;
 *   - a searched reply, a refused search (429), a plain reply, a refused look-up shape (400) and a 401 each print as themselves;
 *   - the call budget: 13 calls at 2 questions, 17 at 3; a run over the budget, or a bad --questions, is refused BEFORE any call;
 *   - a candidate with no key prints SKIP and makes no call; no key at all exits 0 with a SKIP line;
 *   - THE LOG IS PUBLIC: the fake failures carry the key, a `projects/<digits>` string and a long number in their bodies, and none
 *     of them reaches the output (I-30: a test of scrubbing proves nothing if the failure has nothing to scrub).
 * Run: npx tsx test/engineProbe.test.ts
 */
import http from 'http';
import { spawn } from 'child_process';
import { randomPort } from './ports';
// @ts-ignore - a plain ES module script with no type declarations
import { scrub } from '../scripts/engine-probe.mjs';

let failures = 0;
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}
process.on('exit', (c) => {
  if (c === 0 && failures) process.exitCode = 1;
});

const GKEY = 'AIzaSyPROBEFAKEGEMINIKEY1234567890';
const MKEY = 'mistralFAKEKEYabcdefghijklmnop';
const QKEY = 'gsk_FAKEGROQKEYabcdefghijklmnopqrs';
const SECRET_BITS = ['projects/123456789012', '123456789012', 'projects/987654321098'];

type Hit = { provider: string; path: string; body: any };
function fakeProvider(provider: string, hits: Hit[], handler: (path: string, body: any) => { status: number; json?: any; text?: string }) {
  const port = randomPort(8100, 400);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* empty */
      }
      hits.push({ provider, path: req.url || '', body });
      const r = handler(req.url || '', body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.text ?? JSON.stringify(r.json));
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })),
  );
}

const geminiHandler = (path: string, body: any) => {
  const model = path.split('/models/')[1]?.split(':')[0];
  const hasTool = !!body.tools?.length;
  const lookup = body.generationConfig?.responseMimeType === 'application/json';
  if (model === 'gemini-2.5-flash-lite' && lookup)
    return { status: 400, text: JSON.stringify({ error: { code: 400, message: `Tool use with a response mime type is unsupported. key=${GKEY} in projects/123456789012 request 123456789012` } }) };
  if (model === 'gemini-3.6-flash' && hasTool && !lookup)
    return { status: 429, text: JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. projects/987654321098', status: 'RESOURCE_EXHAUSTED' } }) };
  const grounded = hasTool;
  return {
    status: 200,
    json: {
      candidates: [{
        content: { parts: [{ text: lookup ? '{"names":["Poke A","Poke B"]}' : 'Poke A and Poke B are well regarded.' }] },
        ...(grounded ? { groundingMetadata: { webSearchQueries: ['best poke austin'], groundingChunks: [{ web: { uri: 'https://a.test', title: 'a' } }, { web: { uri: 'https://b.test', title: 'b' } }] } } : {}),
      }],
      usageMetadata: { promptTokenCount: 5 },
    },
  };
};
const mistralHandler = () => ({
  status: 200,
  json: {
    conversation_id: 'conv_x',
    outputs: [
      { type: 'tool.execution', name: 'web_search' },
      { type: 'message.output', content: [{ type: 'text', text: 'Try Poke A. ' }, { type: 'tool_reference', tool: 'web_search', title: 'A', url: 'https://a.test' }, { type: 'tool_reference', tool: 'web_search', title: 'B', url: 'https://b.test' }, { type: 'tool_reference', tool: 'web_search', title: 'C', url: 'https://c.test' }] },
    ],
  },
});
const groqHandler401 = () => ({ status: 401, text: JSON.stringify({ error: { message: `Invalid API key ${QKEY} for org projects/123456789012`, type: 'invalid_request_error' } }) });
const groqHandlerOk = (_p: string, body: any) => ({
  status: 200,
  json: { choices: [{ message: { content: 'Poke A.', ...(body.tools ? { executed_tools: [{ type: 'search', search_results: { results: [{ url: 'https://a.test' }, { url: 'https://b.test' }] } }] } : {}) } }] },
});

async function run(extraEnv: Record<string, string | undefined>, argv: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PROBE_')) env[k] = v;
  for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) env[k] = v;
  const child = spawn('node', ['scripts/engine-probe.mjs', ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? -1)));
  return { output, code };
}
const leaks = (text: string) => [GKEY, MKEY, QKEY, ...SECRET_BITS].filter((s) => text.includes(s));

async function main() {
  // ---- scrub itself
  {
    const s = scrub(`a ${GKEY} b projects/42 c projects/123456789012 d 1234567890 e 123456789 f`, [GKEY]);
    assert('scrub removes a key, a project number and a run of ten digits, and keeps a nine-digit number', !s.includes(GKEY) && !/projects\/\d/.test(s) && !s.includes('1234567890') && s.includes('123456789 f'), s);
  }

  // ---- no key at all
  {
    const r = await run({}, []);
    assert('no key at all: exit 0 and a SKIP line for each candidate and for all', r.code === 0 && /SKIP Gemini: no key/.test(r.output) && /SKIP Mistral: no key/.test(r.output) && /SKIP Groq: no key/.test(r.output) && /SKIP all: no key at all/.test(r.output), r.output);
  }

  // ---- everything configured, N = 2
  const hits: Hit[] = [];
  const g = await fakeProvider('gemini', hits, geminiHandler);
  const m = await fakeProvider('mistral', hits, mistralHandler);
  const q = await fakeProvider('groq', hits, groqHandler401);
  const base = { PROBE_GEMINI_API_KEY: GKEY, PROBE_MISTRAL_API_KEY: MKEY, PROBE_GROQ_API_KEY: QKEY, PROBE_GEMINI_BASE_URL: g.url, PROBE_MISTRAL_BASE_URL: m.url, PROBE_GROQ_BASE_URL: q.url };
  {
    const r = await run(base, []);
    const calls = (p: string) => hits.filter((h) => h.provider === p).length;
    assert('N=2 makes 8 Gemini, 2 Mistral and 3 Groq calls (13 in all)', calls('gemini') === 8 && calls('mistral') === 2 && calls('groq') === 3, `${calls('gemini')} ${calls('mistral')} ${calls('groq')}`);
    assert('the run exits 0 even though some calls failed (a failure is a result)', r.code === 0, String(r.code));
    assert('a plain Gemini call is sent with no tools, a searched one with googleSearch, the look-up shape with both and a schema',
      hits.some((h) => h.provider === 'gemini' && !h.body.tools) && hits.some((h) => h.provider === 'gemini' && h.body.tools?.[0]?.googleSearch && !h.body.generationConfig) && hits.some((h) => h.provider === 'gemini' && h.body.tools?.[0]?.googleSearch && h.body.generationConfig?.responseSchema));
    assert('Mistral is asked through /v1/conversations with the web_search tool; Groq with browser_search',
      hits.some((h) => h.path === '/v1/conversations' && h.body.tools?.[0]?.type === 'web_search') && hits.some((h) => h.provider === 'groq' && h.body.tools?.[0]?.type === 'browser_search'));
    assert('a searched Gemini reply prints "web search ran: yes", 2 sources, field names and the reply', /web search ran: yes\nsources returned: 2\nfields: candidates\[\{content,groundingMetadata\}\] usageMetadata\{promptTokenCount\}\nreply \(\d+ characters\): Poke A and Poke B/.test(r.output), r.output.slice(0, 1500));
    assert('a plain Gemini reply prints "web search ran: no"', /\(a\) plain call, no tools\nHTTP status: 200\nweb search ran: no/.test(r.output));
    assert('a refused search prints the status and the body, and says whether a search ran is unknown', /gemini-3\.6-flash: \(b\) search call 1 of 2[^\n]*\nHTTP status: 429\nerror body[^\n]*exceeded your current quota/.test(r.output));
    assert('a refused look-up shape prints its 400', /gemini-2\.5-flash-lite: \(c\)[^\n]*\nHTTP status: 400\nerror body/.test(r.output));
    assert('Mistral prints 3 sources from tool_reference chunks', /mistral-medium-latest: search call 1 of 2[^\n]*\nHTTP status: 200\nweb search ran: yes\nsources returned: 3/.test(r.output));
    assert('a 401 prints as a 401', /HTTP status: 401\nerror body/.test(r.output));
    assert('the output ends by saying how many calls were made', /engine probe finished: 13 call\(s\) made \(13 planned\)/.test(r.output));
    assert('NO key, project number or long number appears anywhere in the output (the fake failures carried them)', leaks(r.output).length === 0 && !/\d{10,}/.test(r.output), leaks(r.output).join(' | '));
    assert('the scrub marker is present, so the failures did carry something to remove', /\[key removed\]/.test(r.output) && /\[number removed\]/.test(r.output));
  }

  // ---- a long reply is cut
  {
    const lh: Hit[] = [];
    const lg = await fakeProvider('gemini', lh, () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: 'x'.repeat(9000) }] } }] } }));
    const r = await run({ PROBE_GEMINI_API_KEY: GKEY, PROBE_GEMINI_BASE_URL: lg.url }, ['--candidates', 'gemini', '--questions', '1']);
    const line = r.output.split('\n').find((l) => l.startsWith('reply (')) || '';
    assert('a 9,000 character reply is printed cut at 4,000 and says so', /cut at 4000/.test(line) && line.length < 4100, String(line.length));
    lg.close();
  }

  // ---- the cut must not leave the start of a key; a reply in the wrong shape is "unknown", not "no"
  {
    const ch: Hit[] = [];
    const cg = await fakeProvider('gemini', ch, (_p, body) =>
      body.tools ? { status: 400, text: 'x'.repeat(497) + GKEY + ' end' } : { status: 200, text: '<html>proxy page</html>' });
    const r = await run({ PROBE_GEMINI_API_KEY: GKEY, PROBE_GEMINI_BASE_URL: cg.url }, ['--candidates', 'gemini', '--questions', '1']);
    assert('a key straddling the 500 character cut leaves not even its first characters', !r.output.includes('AIz') && !r.output.includes(GKEY.slice(0, 8)), r.output.split('\n').filter((l) => l.includes('xxx')).map((l) => l.slice(-40)).join('|'));
    assert('a 200 that is not JSON prints "unknown" with the raw reply, never "no"', /\(a\) plain call, no tools\nHTTP status: 200\nweb search ran: unknown[^\n]*\nraw reply[^\n]*proxy page/.test(r.output), r.output.slice(0, 600));
    cg.close();
    const eh: Hit[] = [];
    const eg = await fakeProvider('gemini', eh, () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }));
    const e = await run({ PROBE_GEMINI_API_KEY: GKEY, PROBE_GEMINI_BASE_URL: eg.url }, ['--candidates', 'gemini', '--questions', '1']);
    assert('a 200 with no candidates is "unknown" too', /web search ran: unknown/.test(e.output) && !/web search ran: no/.test(e.output), e.output.slice(0, 500));
    eg.close();
    const mh: Hit[] = [];
    const mg = await fakeProvider('mistral', mh, () => ({ status: 401, text: `Unauthorized key ${MKEY} masked ${MKEY.slice(0, 8)}...${MKEY.slice(-8)}` }));
    const mr = await run({ PROBE_MISTRAL_API_KEY: MKEY, PROBE_MISTRAL_BASE_URL: mg.url }, ['--candidates', 'mistral', '--questions', '1']);
    assert('a Mistral key echoed whole or masked is removed', !mr.output.includes(MKEY) && !mr.output.includes(MKEY.slice(0, 8)) && !mr.output.includes(MKEY.slice(-8)) && /\[key removed\]/.test(mr.output), mr.output);
    mg.close();
  }
  {
    const before = hits.length;
    const r = await run(base, ['--candidates', 'groq,groq', '--questions', '1']);
    assert('a candidate named twice runs once (2 calls at N=1)', hits.length - before === 2 && /2 call\(s\) planned/.test(r.output), r.output.slice(0, 200));
  }

  // ---- candidates filter, and a candidate without a key
  {
    const before = hits.length;
    const r = await run({ ...base, PROBE_MISTRAL_API_KEY: undefined }, ['--candidates', 'mistral,groq', '--questions', '1']);
    const newHits = hits.slice(before);
    assert('Mistral without a key is skipped by name and makes no call; Groq still runs (2 calls at N=1)', /SKIP Mistral: no key/.test(r.output) && newHits.length === 2 && newHits.every((h) => h.provider === 'groq'), `${newHits.length}`);
  }

  // ---- budget and argument refusals make no call
  {
    const before = hits.length;
    const a = await run({ ...base, PROBE_CALL_BUDGET: '5' }, []);
    assert('a run over the call budget is refused whole, says so, exits non-zero and makes no call', a.code === 2 && /REFUSED: this run would make 13 calls and the budget is 5/.test(a.output) && hits.length === before, a.output);
    const b = await run(base, ['--questions', '4']);
    assert('--questions 4 is refused (at most 3) with no call', b.code === 2 && /REFUSED: --questions/.test(b.output) && hits.length === before, b.output);
    const c = await run(base, ['--candidates', 'bing']);
    assert('an unknown candidate is refused by name, not dropped', c.code === 2 && /unknown candidate\(s\) bing/.test(c.output) && hits.length === before, c.output);
    const d = await run(base, ['--questions', '3']);
    assert('three questions make 17 calls and are allowed', d.code === 0 && /17 call\(s\) planned/.test(d.output), d.output.slice(0, 300));
  }
  // ---- Groq working
  {
    const wh: Hit[] = [];
    const wq = await fakeProvider('groq', wh, groqHandlerOk);
    const r = await run({ PROBE_GROQ_API_KEY: QKEY, PROBE_GROQ_BASE_URL: wq.url }, ['--candidates', 'groq', '--questions', '1']);
    assert('Groq: a searched reply counts its sources and a plain one says no search', /browser_search call 1 of 1[^\n]*\nHTTP status: 200\nweb search ran: yes\nsources returned: 2/.test(r.output) && /one plain call, no tools\nHTTP status: 200\nweb search ran: no/.test(r.output), r.output);
    wq.close();
  }
  g.close();
  m.close();
  q.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll engine probe checks passed.');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
