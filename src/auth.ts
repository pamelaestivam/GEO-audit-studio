/**
 * Sign-in for the early-access product: an email plus an access code the
 * operator hands out, answered with an HMAC-signed, expiring session token.
 *
 * Why this and not accounts with passwords: there are no real users yet and no
 * decision on Google sign-in (TECH_DEBT.md 1.5), so a password database would
 * be state to secure and migrate for no benefit. A signed token needs no
 * database at all, which means it works identically on an always-on host and a
 * serverless one, and there is no password anywhere to leak or hash wrongly.
 * The replaced "auth" accepted any password for any new email and issued a
 * token nothing ever checked (TECH_DEBT.md 2.2).
 *
 * Properties worth stating, because each is tested in test/auth.test.ts:
 *  - Production refuses to run unconfigured instead of falling open. An
 *    operator who forgets SESSION_SECRET gets a clear sentence, not a public app.
 *  - Revoking a code (removing it from ACCESS_CODES) also ends every session
 *    that code created, because the token carries a keyed id of its code.
 *  - Rotating SESSION_SECRET ends all sessions.
 *  - Comparisons are constant-time and do not short-circuit over the code list.
 *
 * Out of scope on purpose: per-user passwords, password reset, OAuth. Those
 * arrive with the real user table (docs/MVP_AUDIT.md items 2 and 4).
 */

import crypto from 'crypto';

export interface AccessCode {
  /**
   * The stable name of whoever holds this code. Saved audits belong to
   * (label, email), so two people with different codes can never see each
   * other's work even if one types the other's email address. Rotating a code
   * keeps its label, and therefore keeps its owner's audits.
   */
  label: string;
  code: string;
}

export interface AuthConfig {
  mode: 'configured' | 'dev' | 'unconfigured';
  secret: string;
  codes: AccessCode[];
  ttlMs: number;
  /** In `unconfigured` mode: what the operator must fix, as a sentence. */
  problem?: string;
}

export const MIN_SECRET_LENGTH = 32;
export const MIN_CODE_LENGTH = 8;
const DEFAULT_TTL_HOURS = 7 * 24;

/** The only code `dev` mode accepts. Never honoured in production. */
export const DEV_ACCESS_CODE = 'dev-access';

export interface LoadAuthOptions {
  /**
   * Allow the zero-configuration development sign-in. Off unless the process
   * was started for development on purpose (`npm run dev`, or ALLOW_DEV_AUTH=1).
   * It used to switch on whenever NODE_ENV was not "production" - which is the
   * case for a plain `npm start` on a server nobody remembered to configure, so
   * a publicly known code opened the whole product.
   */
  allowDev?: boolean;
}

const LABEL_PATTERN = /^[a-z0-9._-]{1,32}$/i;

/** `anna=7Kx9mQ2v` -> label "anna"; a bare code gets a label derived from itself. */
function parseCodes(raw: string): { codes: AccessCode[]; problems: string[] } {
  const codes: AccessCode[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',').map((c) => c.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const label = eq > 0 ? entry.slice(0, eq).trim() : '';
    const code = eq > 0 ? entry.slice(eq + 1).trim() : entry;
    if (eq > 0 && !LABEL_PATTERN.test(label)) {
      problems.push(`the label "${label}" is not valid (letters, digits, . _ - up to 32 characters)`);
      continue;
    }
    if (code.length < MIN_CODE_LENGTH) {
      problems.push(`every access code must be at least ${MIN_CODE_LENGTH} characters`);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({
      label: label || `c-${crypto.createHash('sha256').update(code).digest('hex').slice(0, 8)}`,
      code,
    });
  }
  return { codes, problems };
}

export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadAuthOptions = {}
): AuthConfig {
  const production = env.NODE_ENV === 'production';
  const { codes: parsedCodes, problems: codeProblems } = parseCodes(env.ACCESS_CODES || '');
  const rawCodes = parsedCodes;
  const secret = env.SESSION_SECRET || '';
  const ttlHours = Number(env.SESSION_TTL_HOURS);
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_TTL_HOURS) * 3600_000;

  if (!production && options.allowDev && !secret && rawCodes.length === 0) {
    return {
      mode: 'dev',
      // Fresh per process: dev sessions do not survive a restart, which is the
      // right default for something that is not a real deployment.
      secret: crypto.randomBytes(32).toString('hex'),
      codes: [{ label: 'dev', code: DEV_ACCESS_CODE }],
      ttlMs,
    };
  }

  const problems: string[] = [];
  if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      secret
        ? `SESSION_SECRET is too short (${secret.length} characters; use at least ${MIN_SECRET_LENGTH})`
        : 'SESSION_SECRET is not set'
    );
  }
  if (rawCodes.length === 0 && codeProblems.length === 0) {
    problems.push('ACCESS_CODES is not set (a comma-separated list of codes you hand to invited users)');
  }
  for (const p of Array.from(new Set(codeProblems))) problems.push(p);

  if (problems.length > 0) {
    return {
      mode: 'unconfigured',
      secret: '',
      codes: [],
      ttlMs,
      problem: `Sign-in is not configured on this server: ${problems.join('; ')}. The operator needs to set these environment variables (see docs/DEPLOYMENT.md).`,
    };
  }

  return { mode: 'configured', secret, codes: rawCodes, ttlMs };
}

// ---------------------------------------------------------------------------

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /**
   * What saved audits, jobs and budgets belong to: the code's label AND the
   * email. Keyed on the email alone, anyone holding any code could type
   * someone else's address and read, delete or poll their audits.
   */
  owner: string;
}

/** A stable identity derived from the email alone - there is no user table. */
export function userFromEmail(email: string, label = ''): SessionUser {
  const local = email.split('@')[0].replace(/[._+-]+/g, ' ').trim();
  const name = local
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    id: `usr-${crypto.createHash('sha256').update(`${label}|${email}`).digest('hex').slice(0, 12)}`,
    email,
    name: name || email,
    owner: label ? `${label}|${email}` : email,
  };
}

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/** A keyed, non-reversible id for a code, carried in the token so revoking the code ends its sessions. */
function codeId(secret: string, code: string): string {
  return hmac(secret, `code:${code}`).toString('hex').slice(0, 16);
}

/** True for the addresses that mean "this same machine". */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(v);
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * The id and label of the code `supplied` matches, or null. Checks every configured code
 * without stopping at the first hit so timing does not reveal which one (or how
 * many) matched.
 */
export function checkAccessCode(supplied: unknown, config: AuthConfig): { codeId: string; label: string } | null {
  if (config.mode === 'unconfigured' || typeof supplied !== 'string' || supplied.length === 0) return null;
  const given = digest(supplied.trim());
  let matched: { codeId: string; label: string } | null = null;
  for (const { code, label } of config.codes) {
    if (crypto.timingSafeEqual(given, digest(code))) matched = { codeId: codeId(config.secret, code), label };
  }
  return matched;
}

interface TokenPayload {
  v: 1;
  sub: string;
  cid: string;
  iat: number;
  exp: number;
}

export function issueToken(email: string, cid: string, config: AuthConfig, now = Date.now()): { token: string; expiresAt: number } {
  const payload: TokenPayload = { v: 1, sub: email, cid, iat: now, exp: now + config.ttlMs };
  const body = b64u(JSON.stringify(payload));
  return { token: `${body}.${b64u(hmac(config.secret, body))}`, expiresAt: payload.exp };
}

export type TokenResult =
  | { ok: true; user: SessionUser; expiresAt: number }
  | { ok: false; reason: 'unconfigured' | 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'code_revoked' };

export function verifyToken(token: unknown, config: AuthConfig, now = Date.now()): TokenResult {
  if (config.mode === 'unconfigured') return { ok: false, reason: 'unconfigured' };
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 2 || token.length > 2048) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;

  const expected = hmac(config.secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload?.v !== 1 || typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.cid !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (now >= payload.exp) return { ok: false, reason: 'expired' };

  // The label comes from the CURRENT configuration, found through the code the
  // session was issued under - never from the token - so it cannot be forged
  // and a withdrawn code ends its sessions.
  const entry = config.codes.find((c) => codeId(config.secret, c.code) === payload.cid);
  if (!entry) return { ok: false, reason: 'code_revoked' };

  return { ok: true, user: userFromEmail(payload.sub, entry.label), expiresAt: payload.exp };
}

/** Read `Authorization: Bearer <token>`. */
export function bearerToken(headers: Record<string, any> | undefined): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const m = value.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : undefined;
}

/** A sentence for a refused session, safe to show a person. */
export function describeAuthFailure(reason: Exclude<TokenResult, { ok: true }>['reason'], config: AuthConfig): string {
  if (reason === 'unconfigured') return config.problem || 'Sign-in is not configured on this server.';
  if (reason === 'missing') return 'Please sign in to continue.';
  if (reason === 'expired') return 'Your session has expired. Please sign in again.';
  if (reason === 'code_revoked') return 'Your access has been withdrawn. Contact the person who invited you.';
  return 'Your session is not valid. Please sign in again.';
}
