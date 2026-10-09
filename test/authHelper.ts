/**
 * Lets the end-to-end suites behave like a real, signed-in client.
 *
 * The product now requires a session on every route that spends quota or reads
 * saved work (src/auth.ts), so a test that POSTs to /api/audit/run with no
 * token would - correctly - get a 401. Importing this file:
 *   1. gives each test the environment a configured server needs
 *      (spread TEST_AUTH_ENV into the spawned server's env), and
 *   2. wraps global fetch so requests to protected routes log in once per
 *      server and carry the token, exactly as the browser client does.
 *
 * `rawFetch` is the unwrapped fetch, for tests that assert what an
 * UNauthenticated caller sees - those must never be silently signed in.
 */

export const TEST_ACCESS_CODE = 'test-access-code-1';
export const TEST_EMAIL = 'tester@example.com';

export const TEST_AUTH_ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
  ACCESS_CODES: TEST_ACCESS_CODE,
  // Tests sign in many times from one address; the limiter has its own test.
  AUTH_RATE_LIMIT_PER_MIN: '0',
  // Daily budgets have their own test (foundationE2E); the general suites run
  // far more audits against one server than a real person would.
  USER_AUDITS_PER_DAY: '0',
  GLOBAL_AUDITS_PER_DAY: '0',
};

export const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const tokens = new Map<string, Promise<string>>();

function needsAuth(pathname: string): boolean {
  if (pathname === '/api/audit/status') return false;
  return pathname.startsWith('/api/audit/') || pathname.startsWith('/api/audits') || pathname === '/api/auth/me';
}

async function tokenFor(origin: string, email: string): Promise<string> {
  const key = `${origin}|${email}`;
  if (!tokens.has(key)) {
    tokens.set(
      key,
      (async () => {
        const res = await rawFetch(`${origin}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, accessCode: TEST_ACCESS_CODE }),
        });
        const body = await res.json();
        if (!body.token) throw new Error(`test sign-in failed: ${JSON.stringify(body)}`);
        return body.token as string;
      })()
    );
  }
  return tokens.get(key)!;
}

/** Sign in as another user against one server (for ownership checks). */
export async function loginAs(origin: string, email: string): Promise<string> {
  return tokenFor(origin, email);
}

export function installAuthFetch(defaultEmail = TEST_EMAIL) {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const headers = new Headers(init.headers);
    if (needsAuth(url.pathname) && !headers.has('Authorization') && !headers.has('X-Test-No-Auth')) {
      headers.set('Authorization', `Bearer ${await tokenFor(url.origin, defaultEmail)}`);
    }
    headers.delete('X-Test-No-Auth');
    return rawFetch(input, { ...init, headers });
  }) as typeof fetch;
}
