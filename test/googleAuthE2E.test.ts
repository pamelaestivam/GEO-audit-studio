/**
 * End to end: Sign in with Google against the real built server, with a fake Google (a local keys server and tokens
 * signed with its key). Proves what the pure checks cannot: that a token Google would sign becomes a working session
 * on the real routes, that every wrong token is refused with a plain sentence, that only invited addresses get in, that
 * removing an address ends its session, and that the server stays up when Google cannot be reached.
 *
 * Needs a current dist/. Run: npx tsx test/googleAuthE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import { PortRange, randomPort } from './ports';
import { TEST_ACCESS_CODE, TEST_AUTH_ENV, rawFetch } from './authHelper';
import { TEST_GOOGLE_CLIENT_ID, mintGoogleToken, startFakeKeys, strangerKey } from './googleTestKit';
import { captureOutput, printCaptured, type CapturedOutput } from './serverOutput';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextPort = new PortRange(10300, 300);
const KEYS_PORT = randomPort(10700, 100);
const INVITED = 'pamela@example.com,ricardo@example.com';

async function main() {
  const keys = await startFakeKeys(KEYS_PORT);
  const procs: ChildProcess[] = [];

  const start = (env: Record<string, string> = {}, capture = false) => {
    const port = nextPort.take();
    const proc = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
        DATA_DIR: '',
        GEMINI_API_KEY: '',
        RATE_LIMIT_PER_MIN: '0',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        OPENAI_API_KEY: '',
        PERPLEXITY_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        ...TEST_AUTH_ENV,
        GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
        GOOGLE_ALLOWED_EMAILS: INVITED,
        GOOGLE_JWKS_URL: keys.url,
        ...env,
      },
      // The suite that reads what the server printed (to prove it never prints a token or an address) pipes it.
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    procs.push(proc);
    return { base: `http://127.0.0.1:${port}`, proc, out: capture ? captureOutput(proc) : (null as CapturedOutput | null) };
  };
  const up = async (s: { base: string }) => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await rawFetch(`${s.base}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    throw new Error('a server did not come up');
  };
  const kill = (s: { proc: ChildProcess }) =>
    new Promise<void>((resolve) => {
      s.proc.once('close', () => resolve());
      s.proc.kill('SIGKILL');
    });
  const google = async (base: string, credential: unknown, extra: Record<string, unknown> = {}) => {
    const res = await rawFetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, ...extra }),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

  try {
    const A = start({}, true);
    const COLD = start(); // never signed in to before the burst below: its keys are fetched during it
    const NOSECRET = start({ SESSION_SECRET: '' }); // sign-in is not configured at all
    const OPEN = start({ ACCESS_CODES: '' }); // Google only
    const PARTIAL = start({ GOOGLE_ALLOWED_EMAILS: '' }); // a client id with nobody invited, next to access codes
    const NONE = start({ GOOGLE_CLIENT_ID: '', GOOGLE_ALLOWED_EMAILS: '', GOOGLE_JWKS_URL: '' });
    const LIMITED = start({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    const NOKEYS = start({ GOOGLE_JWKS_URL: 'http://127.0.0.1:1/certs' });
    await Promise.all([A, COLD, NOSECRET, OPEN, PARTIAL, NONE, LIMITED, NOKEYS].map(up));

    // ---- what the login page is told
    const status = (await (await rawFetch(`${A.base}/api/audit/status`)).json()) as any;
    check('the status tells the page Google sign-in is on and gives the PUBLIC client id', [status.auth.google.enabled, status.auth.google.clientId, status.auth.accessCodes], [true, TEST_GOOGLE_CLIENT_ID, true]);
    check('...and never the invited list', /pamela|ricardo|example\.com/.test(JSON.stringify(status)), false);
    const noneStatus = (await (await rawFetch(`${NONE.base}/api/audit/status`)).json()) as any;
    check('a server with no Google settings says Google is off, with nothing to complain about', noneStatus.auth.google, { enabled: false });
    const partialStatus = (await (await rawFetch(`${PARTIAL.base}/api/audit/status`)).json()) as any;
    check('a client id with nobody invited is off and says why, while access codes keep working', [partialStatus.auth.mode, partialStatus.auth.google.enabled, /lists nobody/.test(partialStatus.auth.google.problem || '')], ['configured', false, true]);
    const openStatus = (await (await rawFetch(`${OPEN.base}/api/audit/status`)).json()) as any;
    check('a Google-only server says no access code works', [openStatus.auth.mode, openStatus.auth.accessCodes, openStatus.auth.google.enabled], ['configured', false, true]);

    // ---- a burst of sign-ins on a server that has not fetched Google's keys yet
    const burstBefore = keys.hits();
    const burst = await Promise.all(Array.from({ length: 10 }, () => google(COLD.base, mintGoogleToken())));
    check('ten sign-ins at once on a cold server are all accepted (none is told Google is unreachable)', burst.map((r) => r.status), Array(10).fill(200));
    check('...from a single fetch of Google\'s keys', keys.hits() - burstBefore, 1);

    // ---- an invited person signs in
    const before = keys.hits();
    const ok = await google(A.base, mintGoogleToken());
    check('an invited address with a valid Google token signs in', [ok.status, ok.body.user?.email, typeof ok.body.token, typeof ok.body.expiresAt], [200, 'pamela@example.com', 'string', 'number']);
    check('...the person is told nothing about owners or budgets', Object.keys(ok.body.user || {}).sort(), ['email', 'id', 'name']);
    const me = await rawFetch(`${A.base}/api/auth/me`, authed(ok.body.token));
    check('...and the session works on a protected route', [me.status, ((await me.json()) as any).user?.email], [200, 'pamela@example.com']);
    const audits = await rawFetch(`${A.base}/api/audits`, authed(ok.body.token));
    check('...and on the saved-audits route', [audits.status, ((await audits.json()) as any).audits], [200, []]);
    check('...a session whose last character is changed is refused', (await rawFetch(`${A.base}/api/auth/me`, authed(ok.body.token.slice(0, -2) + 'AA'))).status, 401);
    const spoof = await google(A.base, mintGoogleToken(), { email: 'ricardo@example.com', accessCode: TEST_ACCESS_CODE });
    const spoofMe = await rawFetch(`${A.base}/api/auth/me`, authed(spoof.body.token));
    check('the session is for the address Google vouched for, whatever else the request says (checked on the session itself, not the reply)', [spoof.status, spoof.body.user?.email, ((await spoofMe.json()) as any).user?.email], [200, 'pamela@example.com', 'pamela@example.com']);
    check('the address is matched in lower case', (await google(A.base, mintGoogleToken({ email: 'Ricardo@Example.COM' }))).body.user?.email, 'ricardo@example.com');
    check('Google\'s keys were fetched once for all of that, not once per sign-in', keys.hits() - before, 1);

    // ---- a valid Google account that was not invited
    const stranger = await google(A.base, mintGoogleToken({ email: 'stranger@example.com' }));
    check('a valid Google token for an address that is not invited is refused, with a sentence', [stranger.status, stranger.body.code, /stranger@example\.com has not been invited/.test(stranger.body.error), /access code/.test(stranger.body.error), stranger.body.token], [403, 'google_not_invited', true, true, undefined]);
    check('...and the sentence names that person\'s own address only, never anyone on the invited list', /pamela@example\.com|ricardo@example\.com/.test(stranger.body.error), false);
    check('...and its token does nothing on a protected route', (await rawFetch(`${A.base}/api/auth/me`, authed('not-a-session'))).status, 401);

    // ---- every way a token can be wrong, refused with a plain sentence that explains nothing about the check
    const bad: [string, unknown, number][] = [
      ['a token for another app', mintGoogleToken({ aud: 'other-app-12345.apps.googleusercontent.com' }), 401],
      ['an expired token', mintGoogleToken({}, { expiresInS: -7200 }), 401],
      ['a token with an unverified email', mintGoogleToken({ email_verified: false }), 403],
      ['a token from another issuer', mintGoogleToken({ iss: 'https://evil.example.com' }), 401],
      ['a token signed with a key that is not Google\'s', mintGoogleToken({}, { key: strangerKey.privateKey }), 401],
      ['a token with algorithm none', mintGoogleToken({}, { alg: 'none' }), 401],
      ['a token under a key id Google does not have', mintGoogleToken({}, { kid: 'rotated-away' }), 401],
      ['a token with no email', mintGoogleToken({ email: undefined }), 401],
      ['text that is not a token', 'not.a.token', 401],
    ];
    for (const [name, credential, expected] of bad) {
      const r = await google(A.base, credential);
      check(`${name} is refused (${expected}) with a sentence and no session`, [r.status, typeof r.body.error, r.body.token, /signature|audience|issuer|kid|jwt|alg|key/i.test(r.body.error || '')], [expected, 'string', undefined, false]);
    }
    check('nothing sent is a 400 with a sentence', (await google(A.base, undefined)).status, 400);
    check('a number is a 400', (await google(A.base, 12345)).status, 400);
    check('a token far longer than any real one is a 400, not parsed', (await google(A.base, 'a'.repeat(5000))).status, 400);

    // ---- removing an address ends its session
    const gone = start({ GOOGLE_ALLOWED_EMAILS: 'ricardo@example.com' }); // the same secret, pamela no longer invited
    await up(gone);
    const revoked = await rawFetch(`${gone.base}/api/auth/me`, authed(ok.body.token));
    check('a session made for an address that was then removed from the list is refused', [revoked.status, /access has been withdrawn/.test(((await revoked.json()) as any).error)], [401, true]);
    check('...and signing in again as that address is refused', (await google(gone.base, mintGoogleToken())).status, 403);

    // ---- Google only: an access code opens nothing
    const codeOnOpen = await rawFetch(`${OPEN.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pamela@example.com', accessCode: TEST_ACCESS_CODE }),
    });
    check('on a Google-only server the test access code is not valid', codeOnOpen.status, 401);
    const strangerOnOpen = await google(OPEN.base, mintGoogleToken({ email: 'stranger@example.com' }));
    check('...and an uninvited account there is not told to use an access code that does not exist', [strangerOnOpen.status, /has not been invited\. Ask the person who runs this service to add it\.$/.test(strangerOnOpen.body.error), /access code/.test(strangerOnOpen.body.error)], [403, true, false]);
    const googleOnOpen = await google(OPEN.base, mintGoogleToken());
    check('...and Google sign-in works there', [googleOnOpen.status, googleOnOpen.body.user?.email], [200, 'pamela@example.com']);

    // ---- Google next to access codes: both ways in work
    const codeOnA = await rawFetch(`${A.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pamela@example.com', accessCode: TEST_ACCESS_CODE }),
    });
    check('with both configured an access code still signs in', codeOnA.status, 200);

    // ---- sign-in not configured at all
    const noSecret = await google(NOSECRET.base, mintGoogleToken());
    check('a server with no session secret refuses Google sign-in with the configuration sentence', [noSecret.status, noSecret.body.code], [503, 'auth_unconfigured']);

    // ---- not set up, or set up halfway
    const unset = await google(NONE.base, mintGoogleToken());
    check('a server with no Google settings answers a Google sign-in with a 503 and a sentence', [unset.status, unset.body.code, /not set up on this server/.test(unset.body.error)], [503, 'google_unconfigured', true]);
    const half = await google(PARTIAL.base, mintGoogleToken());
    check('a client id with nobody invited refuses everyone, and says why', [half.status, /lists nobody/.test(half.body.error)], [503, true]);

    // ---- Google cannot be reached
    const down = await google(NOKEYS.base, mintGoogleToken());
    check('when Google\'s keys cannot be fetched the answer is a 503 that says to try again, not "bad token"', [down.status, /Could not reach Google/.test(down.body.error)], [503, true]);
    check('...and the server is still up and answers other sign-ins', [(await rawFetch(`${NOKEYS.base}/api/health`)).status, (await rawFetch(`${NOKEYS.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', accessCode: TEST_ACCESS_CODE }) })).status], [200, 200]);

    // ---- keys already held keep working when Google goes away
    await keys.close();
    const cached = await google(A.base, mintGoogleToken({ email: 'ricardo@example.com' }));
    check('with Google\'s keys already held, sign-in keeps working while Google is unreachable', [cached.status, cached.body.user?.email], [200, 'ricardo@example.com']);

    // ---- attempts are limited like access-code attempts
    const limited: number[] = [];
    for (let i = 0; i < 5; i++) limited.push((await google(LIMITED.base, 'not.a.token')).status);
    const retry = await google(LIMITED.base, 'not.a.token');
    check('past the per-minute limit Google sign-in attempts are answered 429 with a wait time', [limited.slice(0, 3), limited.slice(3).every((s) => s === 429), retry.headers.get('retry-after') !== null], [[401, 401, 401], true, true]);
    // ---- what the server printed: never a token, never an address
    const printed = (A as any).out?.text() ?? '';
    check('the server log has the reasons for refusals but never a token or anyone\'s address', [/eyJ/.test(printed), /@example\.com/.test(printed), /Google sign-in refused: not_invited/.test(printed)], [false, false, true]);
    if (failures > 0) printCaptured('first server', (A as any).out);
  } finally {
    for (const p of procs) p.kill();
    await keys.close().catch(() => undefined);
  }
  console.log(failures === 0 ? '\nGoogle sign-in end-to-end checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('Google sign-in end-to-end harness error:', err);
  process.exit(1);
});
