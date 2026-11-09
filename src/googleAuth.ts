/**
 * Sign in with Google: checking the ID token the browser gets from Google's button.
 *
 * What the browser sends is a signed token (a JWT) that says "Google vouches that this person controls this email
 * address, and that it was issued to THIS app". Nothing here talks to Google on the person's behalf and no secret is
 * needed: the token is checked against Google's published public keys. The checks, each tested in test/googleAuth.test.ts:
 *  - the algorithm must be RS256 (never `none`, never an HMAC keyed with a public key), the key must be one of Google's
 *    (found by the token's `kid`) and at least 2048 bits, and the signature must verify;
 *  - `iss` is Google, `aud` is exactly this app's client id (a token issued to another app is refused), it has not
 *    expired, was not issued in the future, and lives no longer than a day;
 *  - the email is present and `email_verified` is true.
 * Proving WHO someone is does not make them INVITED: any Google account can produce a valid token. Who may use the
 * service is GOOGLE_ALLOWED_EMAILS, checked by the caller, and an empty list lets nobody in.
 *
 * Deliberately dependency-free (node:crypto and fetch) and clock- and fetch-injectable so it is tested without Google.
 */
import crypto from 'crypto';
import { normaliseEmail } from './email.js';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const MAX_TOKEN_CHARS = 4096;
/** Tolerance for a clock that is a little off, in seconds. */
const CLOCK_SKEW_S = 60;
const MAX_LIFETIME_S = 24 * 3600;
const MIN_RSA_BITS = 2048;

export interface GoogleConfig {
  clientId: string;
  /** Lower-case addresses that may sign in. Never empty (an empty list is "Google sign-in is off"). */
  allowedEmails: Set<string>;
  jwksUrl: string;
}

export interface GoogleConfigResult {
  /** Set only when Google sign-in is fully configured. */
  config: GoogleConfig | null;
  /** Set when something was configured but not enough to work: a sentence for the operator, never an address or id. */
  problem?: string;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}\.apps\.googleusercontent\.com$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * GOOGLE_CLIENT_ID (public: it is in the page too) and GOOGLE_ALLOWED_EMAILS (who is invited). Both or neither:
 * a client id with nobody invited, or invited people with no client id, cannot sign anyone in and is reported as such.
 */
export function loadGoogleConfig(env: Record<string, string | undefined>): GoogleConfigResult {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const listRaw = (env.GOOGLE_ALLOWED_EMAILS || '').trim();
  if (!clientId && !listRaw) return { config: null };

  const allowedEmails = new Set<string>();
  let badEntries = 0;
  for (const entry of listRaw.split(/[\s,;]+/).filter(Boolean)) {
    // A wildcard would look like an invitation to a whole domain and match nobody: say so instead.
    const email = /[*?]/.test(entry) ? null : normaliseEmail(entry);
    if (email) allowedEmails.add(email);
    else badEntries++;
  }

  if (!clientId) return { config: null, problem: 'GOOGLE_ALLOWED_EMAILS is set but GOOGLE_CLIENT_ID is not, so nobody can sign in with Google.' };
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return { config: null, problem: 'GOOGLE_CLIENT_ID does not look like a Google client id (it ends in .apps.googleusercontent.com).' };
  }
  if (badEntries > 0) {
    return { config: null, problem: `GOOGLE_ALLOWED_EMAILS has ${badEntries} entr${badEntries === 1 ? 'y' : 'ies'} that ${badEntries === 1 ? 'is' : 'are'} not an email address (separate addresses with commas).` };
  }
  if (allowedEmails.size === 0) {
    return { config: null, problem: 'GOOGLE_CLIENT_ID is set but GOOGLE_ALLOWED_EMAILS lists nobody, so no Google account could sign in.' };
  }

  // Tests point this at a local fake. It must be https, or http to this machine: never plain http to somewhere else.
  let jwksUrl = GOOGLE_JWKS_URL;
  const override = (env.GOOGLE_JWKS_URL || '').trim();
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error('scheme');
      jwksUrl = u.toString();
    } catch {
      return { config: null, problem: 'GOOGLE_JWKS_URL must be an https address (or http to this machine).' };
    }
  }
  return { config: { clientId, allowedEmails, jwksUrl } };
}

// ---------------------------------------------------------------------------
// Google's signing keys
// ---------------------------------------------------------------------------

export type KeyLookup = JsonWebKey | null | 'unavailable';

export interface GoogleKeySource {
  /** The public key with this id; null when Google has no such key; 'unavailable' when the keys cannot be had at all. */
  getKey(kid: string): Promise<KeyLookup>;
}

/** Google's keys, fetched once and kept for as long as Google says (a refetch for an unknown key id is limited to one a minute). */
export class GoogleKeyCache implements GoogleKeySource {
  private keys = new Map<string, JsonWebKey>();
  private expiresAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number = () => Date.now(),
    private readonly timeoutMs = 5000,
    private readonly minRetryMs = 60_000
  ) {}

  async getKey(kid: string): Promise<KeyLookup> {
    const now = this.clock();
    const have = this.keys.has(kid);
    const stale = now >= this.expiresAt;
    // Refresh when the keys are out of date, or when asked for a key that is not here (Google rotates keys), but never
    // more than once per minute so a stream of bad tokens cannot make this server hammer Google.
    if ((stale || !have) && now - this.lastAttemptAt >= this.minRetryMs) await this.refresh();
    const found = this.keys.get(kid);
    if (found) return found;
    return this.keys.size === 0 ? 'unavailable' : null;
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.lastAttemptAt = this.clock();
      this.inflight = this.load()
        .catch(() => undefined) // keep whatever keys are held: a stale key is better than refusing everyone
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`keys answered ${res.status}`);
    const text = await res.text();
    if (text.length > 64 * 1024) throw new Error('keys answer too large');
    const body = JSON.parse(text);
    const fresh = new Map<string, JsonWebKey>();
    for (const k of Array.isArray(body?.keys) ? body.keys : []) {
      if (k && typeof k.kid === 'string' && k.kty === 'RSA' && typeof k.n === 'string' && typeof k.e === 'string') fresh.set(k.kid, k as JsonWebKey);
    }
    if (fresh.size === 0) throw new Error('keys answer had no usable keys');
    const maxAge = /max-age=(\d+)/i.exec(res.headers.get('cache-control') || '');
    const ttlS = Math.min(Math.max(maxAge ? Number(maxAge[1]) : 3600, 300), 24 * 3600);
    this.keys = fresh;
    this.expiresAt = this.clock() + ttlS * 1000;
  }
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export type GoogleVerifyFailure =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_key'
  | 'keys_unavailable'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_lifetime'
  | 'no_email'
  | 'email_unverified';

export type GoogleVerifyResult = { ok: true; email: string; sub: string } | { ok: false; reason: GoogleVerifyFailure };

function parseSegment(segment: string): any {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function verifyGoogleIdToken(credential: unknown, config: Pick<GoogleConfig, 'clientId'>, keys: GoogleKeySource, now = Date.now()): Promise<GoogleVerifyResult> {
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'malformed' };
  const parts = credential.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;

  const header = parseSegment(h);
  const payload = parseSegment(p);
  if (!header || !payload) return { ok: false, reason: 'malformed' };
  // Exactly RS256: `none` would need no signature at all and an HMAC variant could be keyed with the (public) key.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 128) return { ok: false, reason: 'malformed' };

  const found = await keys.getKey(header.kid);
  if (found === 'unavailable') return { ok: false, reason: 'keys_unavailable' };
  if (found === null) return { ok: false, reason: 'unknown_key' };

  let signatureOk = false;
  try {
    const publicKey = crypto.createPublicKey({ key: found as any, format: 'jwk' });
    if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) return { ok: false, reason: 'bad_signature' };
    signatureOk = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  // Only now is anything in the payload believed.
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.includes(payload.iss)) return { ok: false, reason: 'wrong_issuer' };
  if (typeof payload.aud !== 'string' || payload.aud !== config.clientId) return { ok: false, reason: 'wrong_audience' };
  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return { ok: false, reason: 'malformed' };
  if (nowS > payload.exp + CLOCK_SKEW_S) return { ok: false, reason: 'expired' };
  if (payload.iat > nowS + CLOCK_SKEW_S || (typeof payload.nbf === 'number' && payload.nbf > nowS + CLOCK_SKEW_S)) return { ok: false, reason: 'not_yet_valid' };
  if (payload.exp - payload.iat > MAX_LIFETIME_S) return { ok: false, reason: 'bad_lifetime' };
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return { ok: false, reason: 'malformed' };

  const email = normaliseEmail(payload.email);
  if (!email) return { ok: false, reason: 'no_email' };
  if (payload.email_verified !== true && payload.email_verified !== 'true') return { ok: false, reason: 'email_unverified' };
  return { ok: true, email, sub: payload.sub };
}

/** A sentence for a refused token, safe to show a person (never says which check failed beyond what helps them). */
export function describeGoogleFailure(reason: GoogleVerifyFailure): { status: number; message: string } {
  if (reason === 'keys_unavailable') return { status: 503, message: 'Could not reach Google to check your sign-in. Please try again in a moment.' };
  if (reason === 'email_unverified') return { status: 403, message: 'Google says that email address is not verified, so it cannot be used to sign in.' };
  if (reason === 'expired') return { status: 401, message: 'That Google sign-in has expired. Please try again.' };
  return { status: 401, message: 'Google sign-in could not be verified. Please try again.' };
}
