/**
 * The failure diagnostics themselves are tested, because a diagnostic nobody checks can quietly stop working just when
 * it is needed (TECH_DEBT 2.14):
 *   1. `underlyingCause` (what the server logs about a failed provider request): the real cause of a connection failure,
 *      nothing for the bare undici wrapper, no key, bounded, and it never throws;
 *   2. `captureOutput` (what the end-to-end suites print for a server when they fail): keeps the server's own lines,
 *      leaves out the per-request access log (counted), survives a line split across chunks, and says if the process ended;
 *   3. against the real built server with Gemini pointed at a port nothing listens on: the server's log names
 *      ECONNREFUSED and says it gave up, while the sentence the person sees does not carry the technical cause.
 * Needs a current dist/. Run: npx tsx test/diagnostics.test.ts
 */
import { spawn } from 'child_process';
import net from 'net';
import { underlyingCause } from '../src/errors';
import { captureOutput } from './serverOutput';
import { randomPort } from './ports';
import { TEST_AUTH_ENV, installAuthFetch } from './authHelper';

installAuthFetch();

let failures = 0;
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

// ---- 1. underlyingCause
{
  const refused = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), { code: 'ECONNREFUSED' }) });
  assert('a refused connection is named by its code and message', underlyingCause(refused) === ' (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5000)', underlyingCause(refused));
  assert('a bare "fetch failed" with no cause adds nothing', underlyingCause(new Error('fetch failed')) === '');
  const reset = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  assert('a reset connection is told apart from a refused one', underlyingCause(reset).includes('ECONNRESET') && !underlyingCause(reset).includes('ECONNREFUSED'));
  const withKey = new Error('request to https://x.test/v1?alt=json&key=AIzaSECRETVALUE123 failed');
  assert('a key in a quoted URL is removed', !underlyingCause(withKey).includes('AIzaSECRETVALUE123') && !/key=/i.test(underlyingCause(withKey)), underlyingCause(withKey));
  assert('the message is bounded', underlyingCause(new Error('x'.repeat(5000))).length < 160);
  assert('whitespace and newlines are collapsed to one line', !/\n/.test(underlyingCause(new Error('a\n\nb\tc'))));
  assert('an api-key header value and an authorization value are removed', !/SECRET1|SECRET2/.test(underlyingCause(new Error('x-goog-api-key: SECRET1 and authorization: Bearer SECRET2'))), underlyingCause(new Error('x-goog-api-key: SECRET1 and authorization: Bearer SECRET2')));
  assert('credentials in a URL are removed', !/hunter2/.test(underlyingCause(new Error('connect to https://user:hunter2@host.test/x failed'))), underlyingCause(new Error('connect to https://user:hunter2@host.test/x failed')));
  const hostile = { get message(): string { throw new Error('boom'); }, toString() { throw new Error('boom'); } };
  assert('an error object that throws when read does not break the log line', underlyingCause(hostile) === '');
  assert('null, undefined and a plain string do not throw', [null, undefined, 'boom', 42, {}].every((v) => typeof underlyingCause(v as any) === 'string'));
}

// ---- 2. captureOutput, against a real child process that prints in awkward chunks
async function capturedFrom(script: string) {
  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = captureOutput(child);
  await new Promise((r) => child.on('exit', r));
  await new Promise((r) => setTimeout(r, 50));
  return out;
}
(async () => {
  const access = '{"t":"2026-10-10T00:00:00.000Z","id":"abc","method":"GET","path":"/api/health","status":200,"ms":1}';
  const out = await capturedFrom(
    `process.stdout.write('[Gemini] network on attempt 1/2 (ECONNREFUSED); retr');
     setTimeout(()=>{process.stdout.write('ying in 5s\\n'+${JSON.stringify(access)}+'\\n'+${JSON.stringify(access)}+'\\nlast words without newline');},20);
     setTimeout(()=>{process.stderr.write('\\nstderr line\\n');},60);`
  );
  const text = out.text();
  assert('a line split across two chunks is kept whole', text.includes('[Gemini] network on attempt 1/2 (ECONNREFUSED); retrying in 5s'), JSON.stringify(text));
  assert('the per-request access log is left out and counted', !text.includes('"method":"GET"') && text.includes('(2 request-log line(s) left out)'), JSON.stringify(text));
  assert('a final line with no newline is kept', text.includes('last words without newline'));
  assert('stderr is kept too', text.includes('stderr line'));
  assert('it knows the process ended, and how', out.exited() === 'code 0', String(out.exited()));
  // a multibyte character split across two chunks, and a fragment on stdout that must not be glued to a stderr line
  const split = await capturedFrom(
    `const b = Buffer.from('h\u00e9llo w\u00f6rld\\n'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30);
     setTimeout(() => { process.stdout.write('AAA'); }, 80); setTimeout(() => { process.stderr.write('BBB\\n'); }, 120); setTimeout(() => { process.stdout.write('CCC\\n'); }, 160);`
  );
  assert('a multibyte character split across chunks is decoded whole', split.text().includes('h\u00e9llo w\u00f6rld') && !split.text().includes('\ufffd'), JSON.stringify(split.text()));
  assert('an unfinished stdout line is not glued to a stderr line', split.text().includes('BBB') && !split.text().includes('AAABBB') && split.text().includes('AAACCC'), JSON.stringify(split.text()));
  const longLine = await capturedFrom(`process.stdout.write('z'.repeat(3000000)); process.stdout.write('\\nafter\\n');`);
  assert('one enormous line cannot make the capture unbounded', longLine.text().length < 45000 && longLine.text().includes('after'), `${longLine.text().length}`);
  const big = await capturedFrom(`for (let i=0;i<4000;i++) console.log('line '+i+' '+'x'.repeat(40));`);
  assert('output is bounded to the last part, not the first', big.text().length < 25000 && big.text().includes('line 3999') && !big.text().includes('line 0 '), `${big.text().length}`);

  // ---- 3. the real server, Gemini pointed at a closed port
  const closed: number = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const appPort = randomPort(9900, 90);
  const app = spawn('node', ['dist/server.cjs'], {
    env: {
      ...process.env, PORT: String(appPort), NODE_ENV: 'production', GEMINI_API_KEY: 'fake-key', GEMINI_BASE_URL: `http://127.0.0.1:${closed}`,
      GEMINI_MIN_INTERVAL_MS: '0', RATE_LIMIT_PER_MIN: '0', HTTP_PROXY: '', HTTPS_PROXY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '', ANTHROPIC_API_KEY: '', ...TEST_AUTH_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appOut = captureOutput(app);
  const base = `http://127.0.0.1:${appPort}`;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try {
        up = (await fetch(`${base}/api/health`)).ok;
      } catch {
        /* not up yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert('the server starts', up);
    if (!up) {
      process.exitCode = 1; // a failed start is a failed run: returning here skips the exit status below
      return;
    }
    // A lookup never retries, so this is quick: one refused connection, then it gives up.
    const res = await fetch(`${base}/api/audit/parse-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'diag-1' },
      body: JSON.stringify({ input: 'Acme Widgets' }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 200));
    const log = appOut.text();
    assert('the lookup comes back as not detected', res.status === 200 && body.detected === false, JSON.stringify(body).slice(0, 200));
    assert('the server log names the real cause: ECONNREFUSED', /\[Gemini\] network on attempt 1\/0 \(ECONNREFUSED/.test(log), log.slice(-600));
    assert('and says it gave up', /giving up/.test(log), log.slice(-600));
    assert('the sentence the person sees does not carry the technical cause', typeof body.reason === 'string' && !/ECONNREFUSED|127\.0\.0\.1/.test(body.reason) && body.reason.length > 10, String(body.reason));
  } finally {
    app.kill();
  }
  console.log(failures === 0 ? '\nDiagnostics checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
