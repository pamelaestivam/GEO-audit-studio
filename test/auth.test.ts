/**
 * Pure checks for sign-in and sessions. Run: npx tsx test/auth.test.ts
 * Each maps to a failure of the placeholder auth it replaced: any password for
 * a new email was accepted, and the token it returned was never checked.
 */
import {
  DEV_ACCESS_CODE,
  bearerToken,
  checkAccessCode,
  isLoopbackAddress,
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
check('codes are split and trimmed', cfg.codes.map((c) => c.code), ['alpha-code-1', 'beta-code-22']);
check('a bare code gets a stable derived label', [cfg.codes[0].label.startsWith('c-'), cfg.codes[0].label === loadAuthConfig(prod).codes[0].label, cfg.codes[0].label === cfg.codes[1].label], [true, true, false]);
check('production with nothing set is unconfigured, not open', loadAuthConfig({ NODE_ENV: 'production' }).mode, 'unconfigured');
check('...and says which variables are missing', /SESSION_SECRET is not set/.test(loadAuthConfig({ NODE_ENV: 'production' }).problem || '') && /ACCESS_CODES is not set/.test(loadAuthConfig({ NODE_ENV: 'production' }).problem || ''), true);
check('a short secret is refused', loadAuthConfig({ ...prod, SESSION_SECRET: 'short' }).mode, 'unconfigured');
check('...with the length in the sentence', /too short \(5 characters/.test(loadAuthConfig({ ...prod, SESSION_SECRET: 'short' }).problem || ''), true);
check('a weak access code is refused', loadAuthConfig({ ...prod, ACCESS_CODES: 'abc' }).mode, 'unconfigured');
check('a secret without codes is refused', loadAuthConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET }).mode, 'unconfigured');
check('codes without a secret are refused', loadAuthConfig({ NODE_ENV: 'production', ACCESS_CODES: 'alpha-code-1' }).mode, 'unconfigured');
// Dev mode used to switch on whenever NODE_ENV was not "production" - i.e. on a
// plain `npm start` of an unconfigured server, opening it with a publicly known
// code. It must now be asked for.
check('with nothing set and no opt-in, a non-production server is UNCONFIGURED, not open', loadAuthConfig({}).mode, 'unconfigured');
check('NODE_ENV unset does not open the door either', loadAuthConfig({ NODE_ENV: undefined }).mode, 'unconfigured');
check('dev mode needs an explicit opt-in', loadAuthConfig({}, { allowDev: true }).mode, 'dev');
check('dev mode accepts only the documented dev code', loadAuthConfig({}, { allowDev: true }).codes.map((c) => c.code), [DEV_ACCESS_CODE]);
check('the opt-in is ignored in production', loadAuthConfig({ NODE_ENV: 'production' }, { allowDev: true }).mode, 'unconfigured');
check('the opt-in is ignored once real config exists', loadAuthConfig(prod, { allowDev: true }).mode, 'configured');
check('dev mode is never entered in production, even with partial config', loadAuthConfig({ NODE_ENV: 'production', ACCESS_CODES: 'alpha-code-1' }).mode, 'unconfigured');
check('a dev secret is random per process', loadAuthConfig({}, { allowDev: true }).secret === loadAuthConfig({}, { allowDev: true }).secret, false);
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
check('identity is derived from the label and email', userFromEmail('sarah.j@example.com', 'anna'), { id: userFromEmail('sarah.j@example.com', 'anna').id, email: 'sarah.j@example.com', name: 'Sarah J', owner: 'anna|sarah.j@example.com' });
check('the same email under another label is a different owner and id', [userFromEmail('x@y.com', 'anna').owner === userFromEmail('x@y.com', 'ben').owner, userFromEmail('x@y.com', 'anna').id === userFromEmail('x@y.com', 'ben').id], [false, false]);
check('the same email is the same id', userFromEmail('x@y.com').id === userFromEmail('x@y.com').id, true);
check('different emails are different ids', userFromEmail('x@y.com').id === userFromEmail('z@y.com').id, false);

// --- access codes
const matchedAlpha = checkAccessCode('alpha-code-1', cfg);
const cidAlpha = matchedAlpha?.codeId ?? null;
check('a valid code is accepted', typeof cidAlpha, 'string');
check('...and reports its label', matchedAlpha?.label, cfg.codes[0].label);
check('surrounding whitespace is tolerated', checkAccessCode('  alpha-code-1  ', cfg)?.codeId, cidAlpha);
check('a different valid code has a different id', checkAccessCode('beta-code-22', cfg)?.codeId === cidAlpha, false);
check('a wrong code is refused', checkAccessCode('alpha-code-2', cfg), null);
check('an empty code is refused', checkAccessCode('', cfg), null);
check('a non-string code is refused', checkAccessCode(12345678, cfg), null);
check('a prefix of a valid code is refused', checkAccessCode('alpha-code', cfg), null);
check('the label is not accepted as a code', checkAccessCode(cfg.codes[0].label, cfg), null);
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

// labelled codes: stable owners, rotatable codes
const labelled = loadAuthConfig({ ...prod, ACCESS_CODES: 'anna=alpha-code-1, ben=beta-code-22' });
check('labelled codes are parsed', labelled.codes.map((c) => `${c.label}=${c.code}`), ['anna=alpha-code-1', 'ben=beta-code-22']);
const annaMatch = checkAccessCode('alpha-code-1', labelled)!;
const annaTok = issueToken('sam@example.com', annaMatch.codeId, labelled, NOW).token;
const annaUser = verifyToken(annaTok, labelled, NOW);
check('a session is owned by (label, email)', annaUser.ok && annaUser.user.owner, 'anna|sam@example.com');
const benMatch = checkAccessCode('beta-code-22', labelled)!;
const benAsSam = verifyToken(issueToken('sam@example.com', benMatch.codeId, labelled, NOW).token, labelled, NOW);
check("another code holder typing the same email gets a DIFFERENT owner (cannot read Sam's audits)", benAsSam.ok && benAsSam.user.owner, 'ben|sam@example.com');
const rotated = loadAuthConfig({ ...prod, ACCESS_CODES: 'anna=brand-new-code-9, ben=beta-code-22' });
check('rotating a code ends its old sessions', verifyToken(annaTok, rotated, NOW), { ok: false, reason: 'code_revoked' });
const newAnna = checkAccessCode('brand-new-code-9', rotated)!;
const afterRotate = verifyToken(issueToken('sam@example.com', newAnna.codeId, rotated, NOW).token, rotated, NOW);
check('...but the label keeps the same owner, so Sam keeps their audits', afterRotate.ok && afterRotate.user.owner, 'anna|sam@example.com');
check('a token cannot claim another label (the label comes from configuration)', (() => {
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: 'sam@example.com', cid: annaMatch.codeId, lab: 'ben', iat: NOW, exp: NOW + 1e9 })).toString('base64url');
  return verifyToken(`${forged}.${annaTok.split('.')[1]}`, labelled, NOW).ok;
})(), false);
check('an invalid label is a configuration problem', loadAuthConfig({ ...prod, ACCESS_CODES: 'bad label=alpha-code-1' }).mode, 'unconfigured');
check('a duplicate code is collapsed', loadAuthConfig({ ...prod, ACCESS_CODES: 'alpha-code-1,anna=alpha-code-1' }).codes.length, 1);

// loopback (dev sign-in is for this machine only)
check('127.0.0.1 is loopback', isLoopbackAddress('127.0.0.1'), true);
check('::1 is loopback', isLoopbackAddress('::1'), true);
check('an IPv4-mapped loopback is loopback', isLoopbackAddress('::ffff:127.0.0.1'), true);
check('a LAN address is not', isLoopbackAddress('192.168.1.5'), false);
check('a public address is not', isLoopbackAddress('8.8.8.8'), false);
check('no address is not', isLoopbackAddress(undefined), false);
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
