/**
 * The ChatGPT / Perplexity / Claude adapters, against response bodies shaped as
 * each vendor's published API documents them (fetch is stubbed; nothing leaves
 * the machine). Until this file existed no test executed these adapters at all:
 * mutating the Claude citation parsing to return nothing left the whole suite
 * green. These are fixtures written from the documentation, NOT recordings of a
 * live response - they prove the adapters send what the docs say and parse the
 * documented shapes, and say nothing about what the real services return today.
 *
 * Run: npx tsx test/providers.test.ts
 */
import { askEngine, DEFAULT_ANTHROPIC_MODEL } from '../src/providers';
import { describeProviderError } from '../src/errors';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

const realFetch = globalThis.fetch;
let sent: { url: string; headers: Record<string, string>; body: any } = { url: '', headers: {}, body: null };
function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init: any) => {
    sent = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}
const domains = (a: { citations: { domain: string }[] }) => a.citations.map((c) => c.domain).sort();

async function main() {
  process.env.OPENAI_API_KEY = 'oa-key';
  process.env.PERPLEXITY_API_KEY = 'pp-key';
  process.env.ANTHROPIC_API_KEY = 'an-key';
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.OPENAI_MODEL;
  delete process.env.PERPLEXITY_MODEL;

  // ======================= ChatGPT (OpenAI Responses API) =======================
  stub(200, {
    status: 'completed',
    output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'best poke austin' } },
      {
        id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
        content: [{
          type: 'output_text',
          text: 'Top picks: **Pokeworks** and **Sweetfin**.',
          annotations: [
            { type: 'url_citation', url: 'https://www.yelp.com/biz/pokeworks', title: 'Pokeworks - Yelp', start_index: 0, end_index: 5 },
            { type: 'url_citation', url: 'https://sweetfin.com/menu', title: 'sweetfin.com', start_index: 6, end_index: 9 },
          ],
        }],
      },
    ],
  });
  const gpt = await askEngine('ChatGPT', 'best poke in Austin');
  check('ChatGPT sends to the Responses endpoint', sent.url, 'https://api.openai.com/v1/responses');
  check('ChatGPT authenticates with a Bearer key', sent.headers.Authorization, 'Bearer oa-key');
  check('ChatGPT turns web search on and sends the question', [sent.body.tools, sent.body.input], [[{ type: 'web_search' }], 'best poke in Austin']);
  check('ChatGPT default model', sent.body.model, 'gpt-5');
  check('ChatGPT: answer text from the message item (REST bodies carry no output_text convenience field)', gpt.answerText, 'Top picks: **Pokeworks** and **Sweetfin**.');
  check('ChatGPT: citations become publisher domains', domains(gpt), ['sweetfin.com', 'yelp.com']);
  check('ChatGPT: the search it ran is recorded', gpt.searchQueries, ['best poke austin']);
  check('ChatGPT: no error on a good answer', gpt.error, undefined);
  process.env.OPENAI_MODEL = 'gpt-custom';
  await askEngine('ChatGPT', 'q');
  check('ChatGPT: OPENAI_MODEL overrides the model', sent.body.model, 'gpt-custom');
  delete process.env.OPENAI_MODEL;

  stub(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial answ' }] }] });
  const gptInc = await askEngine('ChatGPT', 'q');
  check('ChatGPT: an incomplete answer is a failed lookup, not "brand not named"', /did not finish/.test(gptInc.error || ''), true);
  stub(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] });
  check('ChatGPT: a refusal says so', /declined to answer/.test((await askEngine('ChatGPT', 'q')).error || ''), true);

  // ======================= Perplexity =======================
  stub(200, { choices: [{ message: { role: 'assistant', content: 'Pokeworks is popular [1].' } }], citations: ['https://www.pokeworks.com/austin'] });
  const pplxCit = await askEngine('Perplexity', 'best poke in Austin');
  check('Perplexity sends to chat/completions with a Bearer key and the question', [sent.url, sent.headers.Authorization, sent.body.messages.at(-1)], ['https://api.perplexity.ai/chat/completions', 'Bearer pp-key', { role: 'user', content: 'best poke in Austin' }]);
  check('Perplexity default model', sent.body.model, 'sonar');
  check('Perplexity: answer text', pplxCit.answerText, 'Pokeworks is popular [1].');
  check('Perplexity: the `citations` array alone is read', domains(pplxCit), ['pokeworks.com']);
  stub(200, { choices: [{ message: { content: 'x' } }], search_results: [{ title: 'Eater', url: 'https://www.eater.com/austin', date: '2026-01-01', snippet: '...' }] });
  check('Perplexity: `search_results` alone is read', domains(await askEngine('Perplexity', 'q')), ['eater.com']);
  stub(200, { choices: [{ message: { content: 'x' } }], citations: ['https://www.pokeworks.com/a'], search_results: [{ url: 'https://www.pokeworks.com/a', title: 't' }] });
  check('Perplexity: a URL in both lists is one citation', (await askEngine('Perplexity', 'q')).citations.length, 1);
  stub(200, { choices: [{ message: { content: [{ type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] } }] });
  check('Perplexity: content given as parts is joined, never an array downstream', (await askEngine('Perplexity', 'q')).answerText, 'Part one. Part two.');
  stub(200, { error: { message: 'internal problem' } });
  check('Perplexity: a 200 carrying an error body is a failed lookup', /returned an error instead of an answer/.test((await askEngine('Perplexity', 'q')).error || ''), true);

  // ======================= Claude (Messages API + web_search server tool) =======================
  stub(200, {
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: "I'll search for that." },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'best poke austin' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.tripadvisor.com/x', title: 'Poke - Tripadvisor', encrypted_content: 'zz', page_age: null }] },
      { type: 'text', text: 'Pokeworks', citations: [{ type: 'web_search_result_location', url: 'https://www.pokeworks.com/austin', title: 'Pokeworks', encrypted_index: 'e', cited_text: 'x' }] },
      { type: 'text', text: "'s menu, " },
      { type: 'text', text: 'and Sweetfin' },
      { type: 'text', text: '.' },
    ],
  });
  const claude = await askEngine('Claude', 'best poke in Austin');
  check('Claude sends to the Messages endpoint with key and version headers', [sent.url, sent.headers['x-api-key'], sent.headers['anthropic-version']], ['https://api.anthropic.com/v1/messages', 'an-key', '2023-06-01']);
  check('Claude turns on the web_search server tool with a use cap', sent.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  check('Claude sends the question as the user turn', sent.body.messages, [{ role: 'user', content: 'best poke in Austin' }]);
  check('Claude has room for a list-heavy answer (max_tokens 4096)', sent.body.max_tokens, 4096);
  check('Claude default model is exactly claude-sonnet-5-5 (claude-sonnet-4-5 retires 2026-11-30)', [sent.body.model, DEFAULT_ANTHROPIC_MODEL], ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  check('Claude: adjacent text blocks are one passage (no spaces invented inside "Pokeworks\'s menu, and Sweetfin."); a tool call separates prose with a blank line', claude.answerText, "I'll search for that.\n\nPokeworks's menu, and Sweetfin.");
  check('Claude: citations are the sources cited in the answer text, NOT every search result retrieved (tripadvisor was retrieved, never cited)', domains(claude), ['pokeworks.com']);
  check('Claude: the search it ran is recorded', claude.searchQueries, ['best poke austin']);
  process.env.ANTHROPIC_MODEL = 'claude-custom';
  await askEngine('Claude', 'q');
  check('Claude: ANTHROPIC_MODEL overrides the model', sent.body.model, 'claude-custom');
  delete process.env.ANTHROPIC_MODEL;

  // A failed search comes back as HTTP 200 with a single error OBJECT as the result content.
  stub(200, {
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 's2', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
      { type: 'text', text: 'Pokeworks is a well-known option.' },
    ],
  });
  const degraded = await askEngine('Claude', 'q');
  check('Claude: a failed search does not discard the answer that was written', [degraded.error, degraded.answerText], [undefined, 'Pokeworks is a well-known option.']);
  for (const stop of ['pause_turn', 'max_tokens', 'refusal', 'model_context_window_exceeded']) {
    stub(200, { stop_reason: stop, content: [{ type: 'text', text: 'Let me look' }] });
    const cut = await askEngine('Claude', 'q');
    check(`Claude: stop_reason ${stop} is a failed lookup, not an answer that left the brand out`, /cut off before it finished/.test(cut.error || ''), true);
  }

  // ======================= What the adapter hands the server is already a sentence =======================
  // (The server used to run describeProviderError over it AGAIN, flattening every
  // specific reason to "unexpected error".)
  stub(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  const inc = await askEngine('ChatGPT', 'q');
  check('ChatGPT incomplete: the reason is in the sentence and the kind is set by the adapter', [/max_output_tokens/.test(inc.error || ''), inc.errorKind], [true, 'unknown']);
  stub(200, { status: 'failed', error: { message: 'server had an error' }, output: [] });
  check('ChatGPT failed with an error body: a failed lookup naming the reason', /server had an error/.test((await askEngine('ChatGPT', 'q')).error || ''), true);
  stub(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'Pokeworks is good.' }] }] });
  check('ChatGPT: a refusal block beside real text keeps the text', (await askEngine('ChatGPT', 'q')).answerText, 'Pokeworks is good.');
  stub(429, '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}');
  const bill = await askEngine('ChatGPT', 'q');
  check('an HTTP error comes back already worded for the provider, with its kind', [/out of credit/.test(bill.error || ''), bill.errorKind, /\{/.test(bill.error || ''), (bill.rawError || '').startsWith('HTTP 429')], [true, 'quota', false, true]);
  stub(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-gone"}}');
  const gone = await askEngine('Claude', 'q');
  check('a retired Claude model names ANTHROPIC_MODEL, not all four variables', [/ANTHROPIC_MODEL/.test(gone.error || ''), /GEMINI_MODEL|OPENAI_MODEL/.test(gone.error || '')], [true, false]);
  stub(404, '{"error":{"message":"The model `gpt-gone` does not exist or you do not have access to it."}}');
  check('a ChatGPT model that does not exist (or no access) names OPENAI_MODEL', /OPENAI_MODEL/.test((await askEngine('ChatGPT', 'q')).error || ''), true);
  process.env.PERPLEXITY_MODEL = 'sonar-pro';
  stub(200, { choices: [{ message: { content: ['Part one. ', { text: 'Part two.' }] } }] });
  const ppl = await askEngine('Perplexity', 'q');
  check('Perplexity: PERPLEXITY_MODEL overrides the model', sent.body.model, 'sonar-pro');
  check('Perplexity: content parts may be plain strings or objects', ppl.answerText, 'Part one. Part two.');
  delete process.env.PERPLEXITY_MODEL;
  check('the billing sentence is a quota kind and a daily-style wall', [describeProviderError('insufficient_quota', 'ChatGPT').kind, describeProviderError('billing_hard_limit_reached', 'ChatGPT').isDailyQuota], ['quota', true]);
  check('Claude: pause vs length-limit give different reasons', [/paused/.test(((await (async () => { stub(200, { stop_reason: 'pause_turn', content: [] }); return askEngine('Claude', 'q'); })()).error) || ''), /length limit/.test(((await (async () => { stub(200, { stop_reason: 'max_tokens', content: [] }); return askEngine('Claude', 'q'); })()).error) || '')], [true, true]);

  // ======================= Errors name the right provider and the right fix =======================
  const sentence = (provider: string, raw: string) => describeProviderError(raw, provider).message;
  const noGoogle = (m: string) => !/aistudio|Pacific|google|Enabling billing on the (API )?key/i.test(m);
  for (const [provider, raw] of [
    ['Claude', 'HTTP 429: {"error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'],
    ['ChatGPT', 'HTTP 429: {"error":{"type":"requests","message":"Rate limit reached for gpt-5. Please try again in 6s."}}'],
    ['Perplexity', 'HTTP 429: {"error":{"message":"Too many requests"}}'],
  ] as const) {
    const m = sentence(provider, raw);
    check(`${provider}: a per-minute 429 never sends the owner to Google`, noGoogle(m), true);
    check(`${provider}: ...and is a sentence with no JSON`, /[{}"]/.test(m), false);
  }
  check('a rate limit that states a wait (retryDelay) for a non-Google provider still never sends the owner to Google', noGoogle(sentence('Claude', '429 rate limit {"retryDelay":"30s"}')), true);
  check('Claude: a daily-limit 429 never sends the owner to Google', noGoogle(sentence('Claude', 'HTTP 429: {"error":{"message":"daily limit reached"}}')), true);
  const billing = sentence('ChatGPT', 'HTTP 429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}');
  check('ChatGPT: insufficient_quota is a billing problem, not "wait a minute"', /out of credit/.test(billing) && !/Wait a minute/i.test(billing), true);
  check('Claude: a low credit balance is a billing problem', /out of credit/.test(sentence('Claude', 'HTTP 400: {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}')), true);
  check('Claude: a retired/unknown model id is named as such', /does not recognise \(or this key cannot use\) the model/.test(sentence('Claude', 'HTTP 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5"}}')), true);
  check('a Gemini daily quota still gets the Pacific-midnight reset', /Pacific/.test(sentence('Gemini', '429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProject')), true);
  check('a Gemini per-minute limit still points at the AI Studio key page', /aistudio\.google\.com/.test(sentence('Gemini', '429 RESOURCE_EXHAUSTED rate limit')), true);

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? '\nAll provider adapter checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
