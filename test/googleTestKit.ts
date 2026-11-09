/**
 * A stand-in for Google, for tests only: a local keys server (what GOOGLE_JWKS_URL points at) and a minter of ID tokens
 * signed with its key, so the real built server can be signed in to without Google, a browser extension or a network.
 */
import crypto from 'crypto';
import http from 'http';

export const TEST_GOOGLE_CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const strangerKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(signingKey.publicKey.export({ format: 'jwk' }) as any), kid: 'test-key-1', use: 'sig', alg: 'RS256' };

export interface MintOptions {
  kid?: string;
  alg?: string;
  key?: crypto.KeyObject;
  /** Seconds to add to "now" for iat and exp (a negative lifetime makes an expired token). */
  expiresInS?: number;
}

/** An ID token of the shape Google's button returns, with any claim overridden or removed (undefined). */
export function mintGoogleToken(claims: Record<string, any> = {}, opts: MintOptions = {}): string {
  const nowS = Math.floor(Date.now() / 1000);
  const lifetime = opts.expiresInS ?? 3000;
  const payload: Record<string, any> = {
    iss: 'https://accounts.google.com',
    aud: TEST_GOOGLE_CLIENT_ID,
    sub: `sub-${claims.email ?? 'pamela@example.com'}`,
    email: 'pamela@example.com',
    email_verified: true,
    iat: lifetime >= 0 ? nowS - 5 : nowS + lifetime - 3600,
    exp: nowS + lifetime,
    ...claims,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-key-1' };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), opts.key ?? signingKey.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface FakeKeysServer {
  url: string;
  port: number;
  hits: () => number;
  close: () => Promise<void>;
}

/** Serves Google's key set on a loopback port, counting how many times it is asked. */
export function startFakeKeys(port: number): Promise<FakeKeysServer> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}/certs`,
        port,
        hits: () => hits,
        close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
      })
    );
  });
}
