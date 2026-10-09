/**
 * Pure checks for sign-in and sessions. Run: npx tsx test/auth.test.ts
 * Each maps to a failure of the placeholder auth it replaced: any password for
 * a new email was accepted, and the token it returned was never checked.
 */
import {
  DEV_ACCESS_CODE,
  bearerToken,
  checkAccessCode,
  describeAuthFailure,
  issueToken,
  loadAuthConfig,
  normaliseEmail,
  userFromEmail,
  verifyToken,
} from '../src/auth';

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

const SECRET = 'a'.repeat(40);
const prod = { NODE_ENV: 'production', SESSION_SECRET: SECRET, ACCESS_CODES: 'alpha-code-1, beta-code-22' };
const cfg = loadAuthConfig(prod);
const NOW = 1_800_000_000_000;

// --- configuration: production must never fall open
check('a complete production config is "configured"', cfg.mode, 'configured');
check('codes are split and trimmed', cfg.codes, ['alpha-code-1', 'beta-code-22']);
check('production with nothing set is unconfigured, not open', loadAuthConfig({ NODE_ENV: 'production' }).mode, 'unconfigured');
check('...and says which variables are missing', /SESSION_SECRET is not set/.test(loadAuthConfig({ NODE_ENV: 'production' }).problem || '') && /ACCESS_CODES is not set/.test(loadAuthConfig({ NODE_ENV: 'production' }).problem || ''), true);
check('a short secret is refused', loadAuthConfig({ ...prod, SESSION_SECRET: 'short' }).mode, 'unconfigured');
check('...with the length in the sentence', /too short \(5 characters/.test(loadAuthConfig({ ...prod, SESSION_SECRET: 'short' }).problem || ''), true);
check('a weak access code is refused', loadAuthConfig({ ...prod, ACCESS_CODES: 'abc' }).mode, 'unconfigured');
check('a secret without codes is refused', loadAuthConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET }).mode, 'unconfigured');
check('codes without a secret are refused', loadAuthConfig({ NODE_ENV: 'production', ACCESS_CODES: 'alpha-code-1' }).mode, 'unconfigured');
check('outside production with nothing set is dev mode', loadAuthConfig({}).mode, 'dev');
check('dev mode accepts only the documented dev code', loadAuthConfig({}).codes, [DEV_ACCESS_CODE]);
check('dev mode is never entered in production, even with partial config', loadAuthConfig({ NODE_ENV: 'production', ACCESS_CODES: 'alpha-code-1' }).mode, 'unconfigured');
check('a dev secret is random per process', loadAuthConfig({}).secret === loadAuthConfig({}).secret, false);
check('default session length is 7 days', cfg.ttlMs, 7 * 24 * 3600_000);
check('SESSION_TTL_HOURS is honoured', loadAuthConfig({ ...prod, SESSION_TTL_HOURS: '2' }).ttlMs, 2 * 3600_000);
check('a nonsense TTL falls back to the default', loadAuthConfig({ ...prod, SESSION_TTL_HOURS: 'x' }).ttlMs, 7 * 24 * 3600_000);

// --- email
check('a normal email is accepted and lowercased', normaliseEmail('  Sarah.J@Example.COM '), 'sarah.j@example.com');
check('no @ is refused', normaliseEmail('sarah'), null);
check('whitespace inside is refused', normaliseEmail('a b@example.com'), null);
check('no TLD is refused', normaliseEmail('a@b'), null);
check('non-strings are refused', normaliseEmail({ toString: () => 'a@b.com' }), null);
check('absurd length is refused', normaliseEmail('a'.repeat(300) + '@example.com'), null);
check('identity is derived from the email alone', userFromEmail('sarah.j@example.com'), { id: userFromEmail('sarah.j@example.com').id, email: 'sarah.j@example.com', name: 'Sarah J' });
check('the same email is the same id', userFromEmail('x@y.com').id === userFromEmail('x@y.com').id, true);
check('different emails are different ids', userFromEmail('x@y.com').id === userFromEmail('z@y.com').id, false);

// --- access codes
const cidAlpha = checkAccessCode('alpha-code-1', cfg);
check('a valid code is accepted', typeof cidAlpha, 'string');
check('surrounding whitespace is tolerated', checkAccessCode('  alpha-code-1  ', cfg), cidAlpha);
check('a different valid code has a different id', checkAccessCode('beta-code-22', cfg) === cidAlpha, false);
check('a wrong code is refused', checkAccessCode('alpha-code-2', cfg), null);
check('an empty code is refused', checkAccessCode('', cfg), null);
check('a non-string code is refused', checkAccessCode(12345678, cfg), null);
check('a prefix of a valid code is refused', checkAccessCode('alpha-code', cfg), null);
check('nothing is accepted when unconfigured', checkAccessCode('alpha-code-1', loadAuthConfig({ NODE_ENV: 'production' })), null);
check('the code id does not contain the code', String(cidAlpha).includes('alpha'), false);

// --- tokens
const { token, expiresAt } = issueToken('sarah@example.com', cidAlpha!, cfg, NOW);
const ok = verifyToken(token, cfg, NOW + 1000);
check('a fresh token verifies', ok.ok, true);
check('...to the right person', ok.ok && ok.user.email, 'sarah@example.com');
check('...with its expiry', ok.ok && ok.expiresAt, expiresAt);
check('a token expires', verifyToken(token, cfg, expiresAt), { ok: false, reason: 'expired' });
check('a token is valid until the last millisecond', verifyToken(token, cfg, expiresAt - 1).ok, true);
check('nothing is rejected as missing', verifyToken(undefined, cfg, NOW), { ok: false, reason: 'missing' });
check('an empty string is missing', verifyToken('', cfg, NOW), { ok: false, reason: 'missing' });
check('garbage is malformed', verifyToken('not-a-token', cfg, NOW), { ok: false, reason: 'malformed' });
check('three parts is malformed', verifyToken('a.b.c', cfg, NOW), { ok: false, reason: 'malformed' });
check('the old placeholder token format is rejected', verifyToken(`token-${NOW}`, cfg, NOW).ok, false);

// tampering
const [body, sig] = token.split('.');
const forgedPayload = Buffer.from(JSON.stringify({ v: 1, sub: 'admin@example.com', cid: cidAlpha, iat: NOW, exp: NOW + 1e12 })).toString('base64url');
check('a token with an altered payload is rejected', verifyToken(`${forgedPayload}.${sig}`, cfg, NOW), { ok: false, reason: 'bad_signature' });
check('a token with an altered signature is rejected', verifyToken(`${body}.${sig.slice(0, -2)}AA`, cfg, NOW).ok, false);
check('a truncated signature is rejected', verifyToken(`${body}.${sig.slice(0, 10)}`, cfg, NOW), { ok: false, reason: 'bad_signature' });
const other = loadAuthConfig({ ...prod, SESSION_SECRET: 'b'.repeat(40) });
check('a token signed with another secret is rejected (rotating the secret ends sessions)', verifyToken(token, other, NOW), { ok: false, reason: 'bad_signature' });
check('a very long token is rejected before any work', verifyToken('x'.repeat(5000) + '.y', cfg, NOW), { ok: false, reason: 'malformed' });

// revocation
const revoked = loadAuthConfig({ ...prod, ACCESS_CODES: 'beta-code-22' });
check('removing a code ends the sessions it created', verifyToken(token, revoked, NOW), { ok: false, reason: 'code_revoked' });
const addedLater = loadAuthConfig({ ...prod, ACCESS_CODES: 'alpha-code-1, beta-code-22, gamma-code-3' });
check('adding other codes does not disturb existing sessions', verifyToken(token, addedLater, NOW).ok, true);
const reordered = loadAuthConfig({ ...prod, ACCESS_CODES: 'beta-code-22,alpha-code-1' });
check('reordering codes does not disturb existing sessions', verifyToken(token, reordered, NOW).ok, true);
check('nothing verifies when unconfigured', verifyToken(token, loadAuthConfig({ NODE_ENV: 'production' }), NOW), { ok: false, reason: 'unconfigured' });

// header parsing
check('a bearer token is read', bearerToken({ authorization: 'Bearer abc.def' }), 'abc.def');
check('the scheme is case-insensitive', bearerToken({ authorization: 'bearer abc.def' }), 'abc.def');
check('other schemes are ignored', bearerToken({ authorization: 'Basic abc' }), undefined);
check('no header is undefined', bearerToken({}), undefined);
check('extra words are refused', bearerToken({ authorization: 'Bearer a b' }), undefined);

// messages are sentences that say what to do
for (const reason of ['missing', 'expired', 'code_revoked', 'bad_signature', 'malformed', 'unconfigured'] as const) {
  const msg = describeAuthFailure(reason, loadAuthConfig({ NODE_ENV: 'production' }));
  check(`the "${reason}" message is a sentence with no internals`, /[.!]$/.test(msg) && !/hmac|signature|payload/i.test(msg), true);
}

console.log(failures === 0 ? '\nAll auth checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
