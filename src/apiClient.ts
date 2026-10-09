/**
 * A `fetch` wrapper that survives a sleeping server.
 *
 * Render's free tier spins the instance down after ~15 minutes idle. The
 * request that wakes it can have its connection refused or reset while the
 * container is still booting - before the server exists to answer at all.
 * That is a network-level failure: `fetch()` itself throws, with a message
 * as unhelpful as "Load failed" (Safari) or "Failed to fetch" (Chrome). It
 * never reaches the server, so none of the readable-error work on the
 * backend ever sees it, and the raw browser string reached the user
 * untranslated.
 *
 * Every request in the app goes through here so that class of failure is
 * retried automatically, and only surfaces to the user after retries are
 * genuinely exhausted, with a message that says what's actually going on.
 */

// ---- Session. Every request carries the signed session token, and a 401 on a
// request that carried one means the session ended (expired, or its access
// code was withdrawn) - the app is told once, so it can return to sign-in with
// a sentence rather than leaving each screen to show "request failed".
let authToken: string | null = null;
let unauthorizedHandler: ((message: string) => void) | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

/** Register what happens when the server rejects the current session. */
export function onSessionRejected(handler: ((message: string) => void) | null) {
  unauthorizedHandler = handler;
}

const DEFAULT_RETRIES = 3;
const RETRY_DELAY_MS = [1500, 3000, 6000];

function isRetryableFailure(err: unknown): boolean {
  // fetch() rejects with a TypeError for DNS/connection failures, CORS, and a
  // refused/reset connection - exactly what a Render instance produces while
  // still booting from sleep. It rejects with a DOMException named AbortError
  // when our own per-attempt timeout fires, below; that is a hung connection,
  // not a real answer, so it is just as retryable.
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof TypeError || (err instanceof Error && /load failed|failed to fetch|network/i.test(err.message));
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiFetchOptions extends RequestInit {
  /** Network-level retries before giving up. Set 0 to disable. */
  retries?: number;
  /** Per-attempt timeout; a hung connection is treated the same as a refused one. */
  timeoutMs?: number;
}

/**
 * Fetch with automatic retry on network-level failure (not on a real HTTP
 * error response, which the caller should handle from the parsed body).
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { retries = DEFAULT_RETRIES, timeoutMs = 20000, ...init } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      const sentToken = !!authToken && !headers.has('Authorization');
      if (sentToken) headers.set('Authorization', `Bearer ${authToken}`);
      const res = await fetch(path, { ...init, headers, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 401 && sentToken && unauthorizedHandler) {
        // Read a copy: the caller still owns the original body.
        const body = await res.clone().json().catch(() => ({}));
        unauthorizedHandler(body?.error || 'Your session has ended. Please sign in again.');
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (!isRetryableFailure(err) || attempt === retries) break;
      await delay(RETRY_DELAY_MS[Math.min(attempt, RETRY_DELAY_MS.length - 1)]);
    }
  }

  throw new Error(
    retries === 0
      ? 'Could not reach the server. Check your connection and try again.'
      : 'Could not reach the server after several attempts. If it has been idle for a while it may still be waking up - please wait a moment and try again.'
  );
}
