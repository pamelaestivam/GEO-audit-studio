/**
 * Pure checks for Sign in with Google (src/googleAuth.ts): the ID token is checked against keys we control, so every way
 * a token can be wrong is made here and must be refused. No network: Google's keys are a local fake. Run:
 * npx tsx test/googleAuth.test.ts
 */
import crypto from 'crypto';
import { GOOGLE_JWKS_URL, GoogleKeyCache, loadGoogleConfig, verifyGoogleIdToken, describeGoogleFailure, type GoogleKeySource } from '../src/googleAuth';

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

const CLIENT = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const pair = (bits = 2048) => crypto.generateKeyPairSync('rsa', { modulusLength: bits });
const main = pair();
const other = pair();
const weak = pair(1024);
const jwkOf = (kp: ReturnType<typeof pair>, kid: string) => ({ ...(kp.publicKey.export({ format: 'jwk' }) as any), kid, use: 'sig', alg: 'RS256' });

const keys: Record<string, any> = { main: jwkOf(main, 'main'), weak: jwkOf(weak, 'weak'), ec: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'ec' } };
const source: GoogleKeySource = { getKey: async (kid) => keys[kid] ?? null };

function mint(claims: Record<string, any> = {}, opts: { kid?: string | null; alg?: string; key?: crypto.KeyObject; header?: Record<string, any>; signature?: string } = {}): string {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '1001', email: 'pamela@example.com', email_verified: true, iat: nowS - 10, exp: nowS + 3000, ...claims };
  for (const k of Object.keys(payload)) if ((payload as any)[k] === undefined) delete (payload as any)[k];
  const header: any = { alg: opts.alg ?? 'RS256', typ: 'JWT', ...(opts.kid === null ? {} : { kid: opts.kid ?? 'main' }), ...(opts.header ?? {}) };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = opts.signature ?? crypto.sign('RSA-SHA256', Buffer.from(signingInput), opts.key ?? main.privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}
const verify = (token: unknown, now = NOW) => verifyGoogleIdToken(token, { clientId: CLIENT }, source, now);
const reason = async (token: unknown, now = NOW) => {
  const r = await verify(token, now);
  return r.ok ? 'ok' : (r as { ok: false; reason: string }).reason;
};

// A request that never answers leaves nothing alive in the event loop (AbortSignal timers do not keep a process up), and
// Node then exits 0 in silence in the middle of the run. Keep the loop alive, and make an early end a failure.
const keepAlive = setInterval(() => undefined, 1000);
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL  the test ended before it finished (an awaited promise never settled)');
    process.exitCode = 1;
  }
});

async function main_() {
  // --- a good token
  const good = await verify(mint());
  check('a token signed by a Google key, for this app, unexpired, with a verified email is accepted', good.ok && good.email, 'pamela@example.com');
  check('...the email is normalised to lower case', (await verify(mint({ email: 'Pamela@Example.COM' }))).ok && ((await verify(mint({ email: 'Pamela@Example.COM' }))) as any).email, 'pamela@example.com');
  check('...and so is the string form of email_verified Google has sent', await reason(mint({ email_verified: 'true' })), 'ok');
  check('the other Google issuer spelling is accepted', await reason(mint({ iss: 'accounts.google.com' })), 'ok');

  // --- the signature and the algorithm
  check('a token signed by a different key under a known key id is refused', await reason(mint({}, { key: other.privateKey })), 'bad_signature');
  check('a tampered payload (a different email) is refused', await reason((() => { const t = mint(); const [h, , s] = t.split('.'); return `${h}.${b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1', email: 'attacker@example.com', email_verified: true, iat: nowS - 10, exp: nowS + 3000 }))}.${s}`; })()), 'bad_signature');
  check('alg "none" with no signature is refused', await reason(mint({}, { alg: 'none', signature: '' })), 'malformed');
  check('alg "none" with a made-up signature is refused', await reason(mint({}, { alg: 'none', signature: 'AAAA' })), 'unsupported_alg');
  // The classic confusion: an HMAC "signature" keyed with the public key's bytes.
  const hmacToken = (() => {
    const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'main' }));
    const payload = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1', email: 'attacker@example.com', email_verified: true, iat: nowS, exp: nowS + 3000 }));
    const pem = main.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    return `${header}.${payload}.${crypto.createHmac('sha256', pem).update(`${header}.${payload}`).digest('base64url')}`;
  })();
  check('an HS256 token keyed with the public key is refused', await reason(hmacToken), 'unsupported_alg');
  check('alg RS512 is not accepted either (exactly RS256)', await reason(mint({}, { alg: 'RS512' })), 'unsupported_alg');
  check('a token with no key id is refused', await reason(mint({}, { kid: null })), 'malformed');
  check('a key id Google does not have is refused', await reason(mint({}, { kid: 'nope' })), 'unknown_key');
  check('a key that is not an RSA key is refused', await reason(mint({}, { kid: 'ec' })), 'bad_signature');
  check('a key under 2048 bits is refused even with a valid signature', await reason(mint({}, { kid: 'weak', key: weak.privateKey })), 'bad_signature');
  check('a damaged signature is refused', await reason(mint().slice(0, -6) + 'AAAAAA'), 'bad_signature');

  // --- what is claimed
  check('a token for another app (another client id) is refused', await reason(mint({ aud: 'other-123456.apps.googleusercontent.com' })), 'wrong_audience');
  check('an audience given as a list is refused', await reason(mint({ aud: [CLIENT] })), 'wrong_audience');
  check('a missing audience is refused', await reason(mint({ aud: undefined })), 'wrong_audience');
  check('an issuer that is not Google is refused', await reason(mint({ iss: 'https://evil.example.com' })), 'wrong_issuer');
  check('a lookalike issuer is refused', await reason(mint({ iss: 'https://accounts.google.com.evil.example' })), 'wrong_issuer');
  check('an expired token is refused', await reason(mint({ exp: nowS - 600, iat: nowS - 4200 })), 'expired');
  check('...but a clock a few seconds off is tolerated', await reason(mint({ exp: nowS - 20, iat: nowS - 3600 })), 'ok');
  check('a token issued in the future is refused', await reason(mint({ iat: nowS + 3600, exp: nowS + 7200 })), 'not_yet_valid');
  check('a token that is not valid yet (nbf) is refused', await reason(mint({ nbf: nowS + 3600 })), 'not_yet_valid');
  check('a token that lives more than a day is refused', await reason(mint({ iat: nowS - 10, exp: nowS + 3 * 24 * 3600 })), 'bad_lifetime');
  check('a token with no expiry is refused', await reason(mint({ exp: undefined })), 'malformed');
  check('a token with no subject is refused', await reason(mint({ sub: undefined })), 'malformed');
  check('a token with no email is refused', await reason(mint({ email: undefined })), 'no_email');
  check('an email that is not an address is refused', await reason(mint({ email: 'not an email' })), 'no_email');
  check('an unverified email is refused', await reason(mint({ email_verified: false })), 'email_unverified');
  check('a missing email_verified is refused too', await reason(mint({ email_verified: undefined })), 'email_unverified');
  check('email_verified as a number is not "true"', await reason(mint({ email_verified: 1 })), 'email_unverified');

  // --- the shape of what arrives
  for (const [name, value] of [['nothing', undefined], ['an empty string', ''], ['a number', 42], ['an object', { a: 1 }], ['two segments', 'a.b'], ['four segments', 'a.b.c.d'], ['text that is not base64url', 'a b.c.d'], ['more than 4096 characters', 'a'.repeat(5000)]] as const) {
    check(`${name} is malformed, not a crash`, await reason(value), 'malformed');
  }
  check('three segments that are not JSON are malformed', await reason('AAAA.BBBB.CCCC'), 'malformed');
  check('a header that is a JSON array is malformed', await reason(`${b64u('[1]')}.${b64u('{}')}.AAAA`), 'malformed');

  // --- keys that cannot be had
  const down: GoogleKeySource = { getKey: async () => 'unavailable' };
  check('when Google\'s keys cannot be had at all the answer is "keys_unavailable", not "bad token"', (await verifyGoogleIdToken(mint(), { clientId: CLIENT }, down, NOW) as any).reason, 'keys_unavailable');
  check('...which is a 503 with a sentence that says to try again', describeGoogleFailure('keys_unavailable'), { status: 503, message: 'Could not reach Google to check your sign-in. Please try again in a moment.' });
  check('an unverified email says so, as a 403', describeGoogleFailure('email_unverified').status, 403);
  check('every other refusal is the same plain sentence (no hint which check failed)', new Set(['bad_signature', 'wrong_audience', 'wrong_issuer', 'unsupported_alg', 'malformed', 'unknown_key', 'no_email', 'not_yet_valid', 'bad_lifetime'].map((r) => describeGoogleFailure(r as any).message)).size, 1);

  // --- configuration
  const ok = { GOOGLE_CLIENT_ID: CLIENT, GOOGLE_ALLOWED_EMAILS: 'Pamela@Example.com, ricardo@example.com;extra@example.com\nnew@example.com' };
  const cfg = loadGoogleConfig(ok);
  check('nothing set means Google sign-in is simply off, with no complaint', loadGoogleConfig({}), { config: null });
  check('a client id and a list turn it on', [cfg.config?.clientId, cfg.config?.jwksUrl, cfg.problem], [CLIENT, GOOGLE_JWKS_URL, undefined]);
  check('the list accepts commas, semicolons, spaces and new lines, and lower-cases', [...(cfg.config?.allowedEmails ?? [])].sort(), ['extra@example.com', 'new@example.com', 'pamela@example.com', 'ricardo@example.com']);
  check('a client id with nobody invited is reported, and is off', [loadGoogleConfig({ GOOGLE_CLIENT_ID: CLIENT }).config, /lists nobody/.test(loadGoogleConfig({ GOOGLE_CLIENT_ID: CLIENT }).problem || '')], [null, true]);
  check('invited people with no client id is reported, and is off', [loadGoogleConfig({ GOOGLE_ALLOWED_EMAILS: 'a@example.com' }).config, /GOOGLE_CLIENT_ID is not/.test(loadGoogleConfig({ GOOGLE_ALLOWED_EMAILS: 'a@example.com' }).problem || '')], [null, true]);
  check('a client id that is not Google\'s shape is reported without repeating it', [loadGoogleConfig({ ...ok, GOOGLE_CLIENT_ID: 'my-secret-looking-thing' }).config, /my-secret/.test(loadGoogleConfig({ ...ok, GOOGLE_CLIENT_ID: 'my-secret-looking-thing' }).problem || '')], [null, false]);
  check('an entry that is not an email makes it off, and says how many', [loadGoogleConfig({ ...ok, GOOGLE_ALLOWED_EMAILS: 'a@example.com, nonsense' }).config, /1 entry that is not an email/.test(loadGoogleConfig({ ...ok, GOOGLE_ALLOWED_EMAILS: 'a@example.com, nonsense' }).problem || '')], [null, true]);
  check('a wildcard is not an address, so it is not a way to invite everyone', loadGoogleConfig({ ...ok, GOOGLE_ALLOWED_EMAILS: '*@example.com' }).config, null);
  check('a bare domain is not an address either', loadGoogleConfig({ ...ok, GOOGLE_ALLOWED_EMAILS: '@example.com' }).config, null);
  check('a keys address on this machine is allowed (the tests use one)', loadGoogleConfig({ ...ok, GOOGLE_JWKS_URL: 'http://127.0.0.1:9999/certs' }).config?.jwksUrl, 'http://127.0.0.1:9999/certs');
  check('an https keys address is allowed', loadGoogleConfig({ ...ok, GOOGLE_JWKS_URL: 'https://keys.example.com/certs' }).config?.jwksUrl, 'https://keys.example.com/certs');
  check('plain http to somewhere else is refused', loadGoogleConfig({ ...ok, GOOGLE_JWKS_URL: 'http://keys.example.com/certs' }).config, null);
  check('a keys address that is not an address is refused', loadGoogleConfig({ ...ok, GOOGLE_JWKS_URL: 'file:///etc/passwd' }).config, null);

  // --- Google's keys: fetched once, kept, refreshed, and never hammered
  let clock = NOW;
  let calls = 0;
  let mode: 'ok' | 'fail' | 'empty' | 'big' | 'slow' = 'ok';
  let maxAge: string | null = 'public, max-age=600';
  let delayMs = 0;
  let lastInit: any = null;
  const fetchFake = (async (_url: any, init?: any) => {
    calls++;
    lastInit = init;
    if (mode === 'fail') throw new Error('network down');
    if (mode === 'slow') return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    // 'big' holds a USABLE key plus padding, so only the size limit can be what refuses it.
    const body = mode === 'empty' ? { keys: [] } : mode === 'big' ? { keys: [keys.main], pad: 'x'.repeat(70_000) } : { keys: [keys.main, { ...jwkOf(other, 'second') }] };
    return new Response(JSON.stringify(body), { status: 200, headers: maxAge === null ? {} : { 'cache-control': maxAge } });
  }) as typeof fetch;
  const cache = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 200, 60_000);
  check('the first lookup fetches the keys', [(await cache.getKey('main') as any)?.kid, calls], ['main', 1]);
  check('the next lookups are served from memory', [(await cache.getKey('second') as any)?.kid, (await cache.getKey('main') as any)?.kid, calls], ['second', 'main', 1]);
  check('an unknown key id inside the first minute does not refetch', [await cache.getKey('rotated'), calls], [null, 1]);
  clock += 61_000;
  check('an unknown key id after a minute refetches once (Google rotates keys)', [await cache.getKey('rotated'), calls], [null, 2]);
  check('...and many bad lookups at once make only the one fetch', await (async () => { clock += 61_000; const before = calls; await Promise.all(Array.from({ length: 20 }, () => cache.getKey('rotated2'))); return calls - before; })(), 1);
  clock += 601_000;
  check('keys older than Google\'s max-age are refetched', [(await cache.getKey('main') as any)?.kid, calls], ['main', 4]);
  mode = 'fail';
  clock += 601_000;
  check('when a refresh fails the keys already held are still used', [(await cache.getKey('main') as any)?.kid, calls], ['main', 5]);
  check('...and a failed refresh is not retried on every request', [(await cache.getKey('main') as any)?.kid, calls], ['main', 5]);
  const fresh = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 200, 60_000);
  check('with no keys held and Google unreachable, the answer is "unavailable"', [await fresh.getKey('main'), calls], ['unavailable', 6]);
  mode = 'empty';
  clock += 61_000;
  check('an answer with no usable keys is a failure, not an empty key set', await fresh.getKey('main'), 'unavailable');
  mode = 'big';
  clock += 61_000;
  check('an answer that is far too large is refused', await fresh.getKey('main'), 'unavailable');
  mode = 'slow';
  clock += 61_000;
  const t0 = Date.now();
  check('a keys server that never answers is given up on after the time limit', [await fresh.getKey('main'), Date.now() - t0 < 2000], ['unavailable', true]);
  mode = 'ok';
  clock += 61_000;
  check('...and recovers when Google answers again', (await fresh.getKey('main') as any)?.kid, 'main');

  finished = true;
  clearInterval(keepAlive);
  // --- what the review of this change found
  // (a) a burst of sign-ins on a cold server must all be answered from the one fetch, not told Google is unreachable
  {
    clock = NOW;
    calls = 0;
    mode = 'ok';
    maxAge = 'public, max-age=600';
    delayMs = 60;
    const cold = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 60_000);
    const burst = await Promise.all(Array.from({ length: 10 }, () => cold.getKey('main')));
    check('ten sign-ins at once on a cold cache are all answered with the key, from one fetch', [burst.every((k: any) => k?.kid === 'main'), calls], [true, 1]);
    const rotated = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 60_000);
    await rotated.getKey('main');
    clock += 61_000;
    calls = 0;
    const during = await Promise.all([rotated.getKey('second'), rotated.getKey('second'), rotated.getKey('rotated-away')]);
    check('a burst that arrives while a refresh is under way waits for it (and the key that exists is found)', [(during[0] as any)?.kid, (during[1] as any)?.kid, during[2], calls], ['second', 'second', null, 1]);
    delayMs = 0;
    // (b) a failed first fetch is retried in a few seconds, not a minute
    mode = 'fail';
    calls = 0;
    const flaky = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 60_000);
    check('with no keys held, a failed first fetch answers "unavailable"', [await flaky.getKey('main'), calls], ['unavailable', 1]);
    clock += 2000;
    check('...and is not retried for a moment (nothing hammers Google)', [await flaky.getKey('main'), calls], ['unavailable', 1]);
    mode = 'ok';
    clock += 4000;
    check('...but after a few seconds, when Google is back, the next sign-in works', [(await flaky.getKey('main') as any)?.kid, calls], ['main', 2]);
  }
  // (c) the fetch refuses redirects and an over-size answer even if it holds a usable key
  {
    mode = 'ok';
    clock = NOW;
    const c1 = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 60_000);
    await c1.getKey('main');
    check('the keys are fetched with redirects refused', lastInit?.redirect, 'error');
    mode = 'big';
    const c2 = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 60_000);
    check('an answer over 64KB is refused even though it holds a usable key', await c2.getKey('main'), 'unavailable');
    const declaredBig = (async () => new Response('{"keys":[]}', { status: 200, headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
    check('an answer that declares itself over 64KB is refused', await new GoogleKeyCache('http://x/certs', declaredBig, () => clock, 2000, 60_000).getKey('main'), 'unavailable');
    const chunked = (async () => new Response(new ReadableStream({ start(ctrl) { const chunk = new TextEncoder().encode('x'.repeat(30_000)); ctrl.enqueue(chunk); ctrl.enqueue(chunk); ctrl.enqueue(chunk); ctrl.close(); } }), { status: 200 })) as unknown as typeof fetch;
    check('a streamed answer with no declared size is cut off at 64KB', await new GoogleKeyCache('http://x/certs', chunked, () => clock, 2000, 60_000).getKey('main'), 'unavailable');
    mode = 'ok';
  }
  // (d) Cache-Control: honoured, clamped to between five minutes and a day, an hour when absent
  {
    const ttlCase = async (header: string | null, expectedSeconds: number) => {
      maxAge = header;
      mode = 'ok';
      clock = NOW;
      calls = 0;
      const c = new GoogleKeyCache('http://x/certs', fetchFake, () => clock, 2000, 1000);
      await c.getKey('main');
      clock = NOW + (expectedSeconds - 5) * 1000;
      await c.getKey('main');
      const before = calls;
      clock = NOW + (expectedSeconds + 5) * 1000;
      await c.getKey('main');
      return [before, calls];
    };
    check('max-age=1 is raised to five minutes (no refetch before, one after)', await ttlCase('public, max-age=1', 300), [1, 2]);
    check('max-age=99999999 is lowered to a day', await ttlCase('public, max-age=99999999', 24 * 3600), [1, 2]);
    check('max-age=900 is honoured', await ttlCase('max-age=900', 900), [1, 2]);
    check('no Cache-Control is an hour', await ttlCase(null, 3600), [1, 2]);
    maxAge = 'public, max-age=600';
  }
  // (e) limits on what arrives
  const sizeTok = (() => { const t = mint({ pad: 'x'.repeat(4500) }); return t; })();
  check('a correctly signed token longer than 4096 characters is refused', await reason(sizeTok), 'malformed');
  check('a key id longer than 128 characters is refused', await reason(mint({}, { kid: 'k'.repeat(129) })), 'malformed');
  check('a key id of exactly 128 characters gets as far as the key lookup', await reason(mint({}, { kid: 'k'.repeat(128) })), 'unknown_key');
  // (f) addresses: plain ASCII only, in the token and in the list
  check('an address with the Kelvin sign (which lower-cases to an ASCII k) is not accepted from Google', await reason(mint({ email: '\u212Aim@corp.com' })), 'no_email');
  check('...nor with it in the domain', await reason(mint({ email: 'kim@cor\u212A.com' })), 'no_email');
  check('...nor an address with other non-ASCII letters', await reason(mint({ email: 'jos\u00e9@example.com' })), 'no_email');
  check('ordinary addresses with a dot, a plus, an apostrophe and subdomains are accepted', await Promise.all(["o'brien@example.co.uk", 'a.b+c@sub.example.com', 'x_y-z@e-x.com'].map((e) => reason(mint({ email: e })))), ['ok', 'ok', 'ok']);
  for (const bad of ['<a@b.com>', 'a@b.com.', '"a@b.com"', 'Name <a@b.com>', 'a@b', 'a b@c.com', 'K\u212Aim@corp.com', 'jos\u00e9@example.com']) {
    const r = loadGoogleConfig({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_ALLOWED_EMAILS: bad });
    check(`the invited-list entry ${JSON.stringify(bad)} is refused with a sentence, never kept as a list that matches nobody`, [r.config, typeof r.problem], [null, 'string']);
  }
  check('a client id with something after the Google domain is refused', loadGoogleConfig({ GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com.evil.com', GOOGLE_ALLOWED_EMAILS: 'a@b.com' }).config, null);
  check('a client id with a line break in it is refused', loadGoogleConfig({ GOOGLE_CLIENT_ID: 'abcdef\n1234.apps.googleusercontent.com', GOOGLE_ALLOWED_EMAILS: 'a@b.com' }).config, null);

  console.log(failures === 0 ? '\nAll Google sign-in checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main_().catch((err) => {
  console.error('Google sign-in test harness error:', err);
  process.exit(1);
});
