import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  analyseAnswer,
  buildBrandMatcher,
  buildCitationSourceMap,
  attributeInaccuracies,
  buildScorecards,
  computeAccuracyRate,
  dedupeMatchers,
  extractCandidateVendors,
  findFirstMention,
  normaliseDomain,
  queryNamesBrand,
  sourcesForBrand,
  type QueryEvidence,
} from './src/analysis.js';
import {
  computeQuotaCooldownMs,
  describeProviderError,
  formatDuration,
  summariseFailures,
  type ReadableError,
} from './src/errors.js';
import { QuotaBreaker } from './src/quotaBreaker.js';
import crypto from 'crypto';
import { IdempotencyStore, readIdempotencyKey } from './src/idempotency.js';
import {
  bearerToken,
  checkAccessCode,
  describeAuthFailure,
  devLoginAllowed,
  issueToken,
  loadAuthConfig,
  normaliseEmail,
  publicUser,
  userFromEmail,
  verifyToken,
} from './src/auth.js';
import { openStore, type StoredJob } from './src/store.js';
import { FixedWindowLimiter, limiterKey } from './src/rateLimit.js';
import { buildStandardQueries, DEFAULT_QUERY_COUNT } from './src/queries.js';
import { guardSummary, containsFigure, assertReportInvariants } from './src/reportGuard.js';
import { CallCounter, dailyCallCap, capReachedMessage, paidEnginesBlocked, type SpendStatus } from './src/spendGuard.js';
import {
  askEngine,
  configuredEngines,
  dedupeCitations,
  engineModelId,
  type EngineName,
} from './src/providers.js';

import dotenv from 'dotenv';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

// The compiled bundle IS the production build. Run as plain `node dist/server.cjs`
// (which is what `npm start` does) with NODE_ENV unset, it used to behave as a
// development server: loading the Vite dev toolchain and, with the old auth,
// accepting a publicly known sign-in code. A built server defaults to production;
// set NODE_ENV explicitly to override.
if (typeof __filename !== 'undefined' && /server\.cjs$/.test(__filename) && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// Local development reads .env.local, then .env (values already in the
// environment win). README has always told people to put their key in
// .env.local, but nothing loaded it - so a developer's key was silently never
// read. Never in production: a deployment's environment comes from its host.
if (process.env.NODE_ENV !== 'production') {
  for (const file of ['.env.local', '.env']) dotenv.config({ path: file, quiet: true });
}

/**
 * One breaker per process, shared by every request. A quota error discovered
 * by one user's audit protects every other request on the server for the
 * rest of the cooldown - nobody else has to independently rediscover the
 * same exhausted quota.
 */
const geminiBreaker = new QuotaBreaker();

/** Single source of truth for the audit model, so it can be swapped in one place. */
const AUDIT_MODEL = engineModelId('Gemini');

/** Bounds audit cost and runtime; each query fans out across every engine. */
const MAX_AUDIT_QUERIES = Number(process.env.MAX_AUDIT_QUERIES || 8);

/** Answers shown to the narrative model: every (query, engine) answer of a full audit. */
const NARRATIVE_MAX_ANSWERS = Math.max(40, MAX_AUDIT_QUERIES * 4);

/**
 * Builds the Express app with every route registered, but never binds a
 * port. Shared by two callers: `startServer` below (a long-running process
 * on Render or `npm run dev`), and `api/[...path].ts` (a Vercel serverless
 * function, which owns the request/response lifecycle itself and must
 * never call `app.listen`).
 */
async function buildApp() {
  if (process.env.AUDIT_FORCE_INVARIANT_VIOLATION === '1') {
    // A test-only switch: set on a real deployment it makes EVERY audit fail its consistency check. Say so loudly.
    console.warn('[config] AUDIT_FORCE_INVARIANT_VIOLATION=1 is set: every audit will fail its consistency check. This is a test-only switch; unset it.');
  }
  const app = express();

  app.disable('x-powered-by');
  // How many reverse proxies sit in front of this process (TRUST_PROXY=1 on
  // Render, Fly, or behind nginx/Caddy). The default is NONE: with a proxy
  // trusted that does not exist, a client can send its own X-Forwarded-For and
  // pick any identity it likes, which made every per-IP limit - including the
  // access-code brute-force limit - bypassable by rotating that header.
  // Behind a real proxy and left at 0, all users share the proxy's address and
  // are throttled together, which fails safe; /api/health says which is in effect.
  const trustProxyHops = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY ?? 0)) || 0);
  app.set('trust proxy', trustProxyHops);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // One structured line per API request, with an id the client also receives
  // (X-Request-Id). Diagnosing the Vercel crash needed the owner to copy a
  // stack trace out of a dashboard; a request id in the log and in the
  // response lets a reported failure be found. Paths only - never bodies,
  // queries or tokens.
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    const id = typeof supplied === 'string' && /^[\w-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    const started = Date.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/') || req.path === '/api/health') return;
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - started,
          user: res.locals.user?.id,
        })
      );
    });
    next();
  });

  // ---- Durable state and sign-in. Both are decided once, at start-up, and
  // both say plainly what they are: nothing here silently degrades.
  const auth = loadAuthConfig(process.env, {
    allowDev: process.env.ALLOW_DEV_AUTH === '1' || process.argv.includes('--dev'),
  });
  if (auth.mode === 'dev') {
    console.warn(
      '[auth] DEV MODE: no access codes are configured, so the code "dev-access" signs anyone in - from this machine only. Never honoured when NODE_ENV=production.'
    );
  } else if (auth.mode === 'unconfigured') {
    console.error(`[auth] ${auth.problem}`);
  }

  // `npm run dev` keeps data in ./data so audits survive restarts while
  // developing; production only persists when DATA_DIR is set on purpose.
  const dataDir =
    process.env.DATA_DIR ||
    (process.env.NODE_ENV !== 'production' && !process.env.VERCEL ? path.join(process.cwd(), 'data') : undefined);
  const store = await openStore({ dataDir, serverless: !!process.env.VERCEL });
  if (store.info().note) console.warn(`[store] ${store.info().note}`);
  if (store.info().durable) {
    // No audit started by a previous process can still be running, so any job
    // still marked running is orphaned. Say so instead of leaving it to hang.
    const orphaned = await store.failAllRunning(
      'The server restarted while this audit was running, so it was stopped. Please run it again.'
    );
    if (orphaned > 0) console.warn(`[store] marked ${orphaned} orphaned audit job(s) as failed after a restart.`);
  }

  /**
   * Every route that spends quota or reads saved work needs a valid session.
   * Unconfigured production answers 503 with the fix, rather than falling open.
   */
  const requireAuth: express.RequestHandler = (req, res, next) => {
    const result = verifyToken(bearerToken(req.headers as any), auth);
    if (!result.ok) {
      // (The project is not compiled with strictNullChecks, so the union does
      // not narrow on `ok` by itself.)
      const { reason } = result as Extract<typeof result, { ok: false }>;
      const unconfigured = reason === 'unconfigured';
      return res.status(unconfigured ? 503 : 401).json({
        error: describeAuthFailure(reason, auth),
        code: unconfigured ? 'auth_unconfigured' : 'auth_required',
      });
    }
    res.locals.user = result.user;
    next();
  };

  /** Express 4 does not catch a rejected promise; route it to the error handler. */
  const handle =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => {
      fn(req, res).catch(next);
    };

  /**
   * Every POST under /api/audit spends answer-engine quota and is currently
   * open to anyone with the URL (TECH_DEBT.md 2.2). A per-IP window stops one
   * client - a script, or a retry loop - from spending everyone's day.
   * 0 disables it. Per-instance on serverless; see src/rateLimit.ts.
   */
  const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 30);
  const spendLimiter = new FixedWindowLimiter(RATE_LIMIT_PER_MIN, 60_000);
  app.use('/api/audit', (req, res, next) => {
    if (req.method !== 'POST' || RATE_LIMIT_PER_MIN <= 0) return next();
    const decision = spendLimiter.check(limiterKey(req.ip));
    if (decision.allowed) return next();
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    return res.status(429).json({
      error: `You are sending audit requests faster than this service allows. Please wait ${decision.retryAfterSeconds} seconds and try again.`,
    });
  });

  // Spending routes need a session. The one public read is the status
  // endpoint: monitors and the sign-in page use it, and it reveals only which
  // engines are configured and whether the quota is known to be exhausted.
  app.use('/api/audit', (req, res, next) =>
    (req.method === 'GET' || req.method === 'HEAD') && req.path === '/status' ? next() : requireAuth(req, res, next)
  );
  app.use('/api/audits', requireAuth);

  // The quick lookups (brand detection, query suggestions, one added query) each
  // spend real engine calls but are not audits, so the audit budgets never saw
  // them: 40 parallel evaluate-query calls from one user made 40 Gemini calls.
  // A per-person hourly limit (per process - resets on restart, unlike the audit
  // budgets, which live in the store). 0 disables.
  const USER_LOOKUPS_PER_HOUR = Number(process.env.USER_LOOKUPS_PER_HOUR ?? 30);
  const lookupLimiter = new FixedWindowLimiter(USER_LOOKUPS_PER_HOUR, 3600_000);
  // A retry of one click (the browser re-sends a request that seemed to hang,
  // up to four times on a cold start) carries the same Idempotency-Key and
  // costs one real call - the routes dedupe it. It must not also cost four
  // units of the person's hourly allowance, so a key already admitted within
  // the dedupe window passes without being counted again.
  const lookupAdmitted = new IdempotencyStore<true>(60 * 1000);
  app.use(
    ['/api/audit/parse-url', '/api/audit/generate-queries', '/api/audit/evaluate-query'],
    (req, res, next) => {
      if (req.method !== 'POST' || USER_LOOKUPS_PER_HOUR <= 0) return next();
      const budgetKey: string = res.locals.user.budgetKey;
      const idem = readIdempotencyKey(req.headers as any);
      // baseUrl, not path: inside a mounted middleware `path` is just "/", which would
      // let one key admitted on one lookup route pass uncounted on the others.
      const admittedKey = idem ? `${budgetKey}:${req.baseUrl}:${idem}` : undefined;
      if (lookupAdmitted.peek(admittedKey)) return next();
      const decision = lookupLimiter.check(budgetKey);
      if (decision.allowed) {
        lookupAdmitted.run(admittedKey, () => true);
        return next();
      }
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      return res.status(429).json({
        error: `You have used your ${USER_LOOKUPS_PER_HOUR} quick lookups for this hour (brand detection, query suggestions and added queries each count). Try again in about ${formatDuration(decision.retryAfterSeconds * 1000)}.`,
      });
    }
  );

  /** Bounds on user input, so one request cannot exhaust quota or memory. */
  const MAX_NAME_LENGTH = 120;
  const MAX_COMPETITORS = 20;
  const MAX_QUERY_LENGTH = 300;

  /** Trim and cap a user-supplied string; anything that is not a string becomes ''. */
  const cleanText = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';

  /** Competitors arrive as an array or a comma-separated string; always return a bounded string[]. */
  const cleanCompetitors = (value: unknown): string[] =>
    (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
      .map((c: unknown) => cleanText(c, MAX_NAME_LENGTH))
      .filter((c: string) => c.length > 0)
      .slice(0, MAX_COMPETITORS);

  // Initialize Gemini Client server-side
  const getGeminiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is missing. AI audit generation will fall back to smart synthesized benchmarks.");
      return null;
    }
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        },
        // Test-only escape hatch: lets the contract tests point Gemini calls
        // at a local fake server that always returns 429, to prove the
        // circuit breaker actually stops repeated calls against a real audit
        // run rather than just in isolated unit tests. Unset in every real
        // deployment, so this is a no-op there.
        ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
      }
    });
  };

  // Helper to delay execution
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Serialise Gemini traffic.
   *
   * The free tier limits requests per minute, and one audit issues several
   * calls (one grounded search per query, then narrative). Firing them back to
   * back exhausts the quota and the whole audit fails. Every Gemini call
   * therefore queues behind the previous one with a minimum gap.
   *
   * The gap is 6.5s rather than the 4s it used to be because 4s permits 15
   * requests/minute, which is above every documented free-tier limit for a
   * Flash model (10 RPM - https://ai.google.dev/gemini-api/docs/rate-limits).
   * A pacer whose own ceiling is higher than the limit it exists to respect
   * is not pacing anything. 6.5s holds us to ~9 RPM, just under the line.
   */
  const MIN_GEMINI_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 6500);
  let geminiChain: Promise<unknown> = Promise.resolve();
  let lastGeminiCallAt = 0;

  function scheduleGeminiCall<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const waitFor = lastGeminiCallAt + MIN_GEMINI_INTERVAL_MS - Date.now();
      if (waitFor > 0) await delay(waitFor);
      lastGeminiCallAt = Date.now();
      return fn();
    };
    const next = geminiChain.then(run, run);
    geminiChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Gemini call with quota-aware retry. When the API tells us how long to wait
   * we honour it; per-minute limits need tens of seconds, not the two we used
   * to wait, which meant every retry failed too.
   */
  /** Thrown when the circuit breaker refuses a call - carries the reason directly. */
  /** Calls this process has made to Gemini, per UTC day (a safeguard, not the money control: see src/spendGuard.ts). */
  const geminiCalls = new CallCounter();
  class CallCapReachedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CallCapReachedError';
    }
  }
  class QuotaExhaustedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'QuotaExhaustedError';
    }
  }

  /**
   * How long an in-flight audit may pause to ride out a per-minute rate
   * limit. Past this, failing honestly beats holding the user's browser: the
   * breaker trips and the report says so. One wait, not a retry loop - the
   * breaker exists because retry loops at every call site are what turned one
   * exhausted quota into 15-20 rediscoveries of it.
   */
  const RATE_LIMIT_MAX_WAIT_MS = Number(process.env.GEMINI_RATE_LIMIT_MAX_WAIT_MS || 20000);
  const RATE_LIMIT_RETRIES = Number(process.env.GEMINI_RATE_LIMIT_RETRIES || 1);

  async function generateContentWithRetry(
    aiInstance: GoogleGenAI,
    params: any,
    maxRetries = Number(process.env.GEMINI_MAX_RETRIES || 2)
  ): Promise<any> {
    // Fail instantly against a wall we already know is there. No network
    // call, no wait - this is what stops one exhausted quota from being
    // rediscovered 15-20 times across a single audit.
    if (geminiBreaker.isTripped()) {
      const status = geminiBreaker.status();
      throw new QuotaExhaustedError(
        `${status.reason} (${formatDuration(status.msRemaining)} remaining)`
      );
    }

    let attempt = 0;
    let rateLimitWaits = 0;

    while (true) {
      try {
        return await scheduleGeminiCall(() => {
          // Re-check right before the call actually executes, not just on
          // entry to this function: scheduleGeminiCall fully serialises
          // calls, but a second concurrent audit can pass the entry check
          // before the first one's failure has been recorded. Every call
          // this queue ever executes gets one final look at the breaker
          // immediately beforehand, closing that race.
          if (geminiBreaker.isTripped()) {
            const status = geminiBreaker.status();
            throw new QuotaExhaustedError(`${status.reason} (${formatDuration(status.msRemaining)} remaining)`);
          }
          // The operator's daily safety cap on Gemini calls (src/spendGuard.ts): checked and counted
          // right where the call is made, so no code path can spend around it.
          const cap = dailyCallCap(process.env);
          if (geminiCalls.wouldExceed(cap)) throw new CallCapReachedError(capReachedMessage(cap as number));
          geminiCalls.record();
          return aiInstance.models.generateContent(params);
        });
      } catch (err: any) {
        // Our own safety cap is not a provider failure: no retry, no breaker, no wait.
        if (err instanceof CallCapReachedError) throw err;
        attempt++;
        const readable = describeProviderError(err, 'Gemini');

        if (readable.kind === 'quota') {
          // A *daily* cap is a genuine wall: nothing this process does before
          // the reset will succeed. Trip immediately - do not retry, and stop
          // every other call site (this audit and every other request) from
          // independently rediscovering the same wall.
          const cooldownMs = computeQuotaCooldownMs(String(err?.message || err));
          geminiBreaker.trip(cooldownMs, readable.message);
          console.log(`[Gemini] daily quota exhausted; breaker tripped for ${formatDuration(cooldownMs)}`);
          throw err;
        }

        if (readable.kind === 'rate_limit') {
          // A *per-minute* limit is a pacing signal, not a wall. Treating it
          // as one was throwing away whole audits: a single 429 on the first
          // grounded search tripped the breaker and returned a report of
          // zeros, having made exactly one call, while the provider's own
          // response said the wait was five seconds. Wait the time it asked
          // for and carry on with the same audit.
          const suggestedMs = (readable.retryAfterSeconds ?? 0) * 1000;
          // `maxRetries === 0` is how a call site says "fail fast, a user is
          // watching a form" - brand lookup passes it precisely because a
          // back-off there is what produced "Brand lookup could not be
          // reached". Pausing that call for 20s to save it would trade one
          // documented behaviour for the bug it was written to prevent.
          const mayWait = maxRetries > 0;
          const worthWaiting = mayWait && suggestedMs > 0 && suggestedMs <= RATE_LIMIT_MAX_WAIT_MS;

          if (worthWaiting && rateLimitWaits < RATE_LIMIT_RETRIES) {
            rateLimitWaits++;
            // A small margin on top: the provider's delay is when the window
            // opens, and landing exactly on it just earns another 429.
            const waitMs = suggestedMs + 1000;
            console.log(
              `[Gemini] rate limited; waiting ${formatDuration(waitMs)} as the provider asked, then resuming this audit`
            );
            await delay(waitMs);
            continue;
          }

          // Either the provider wants us gone for longer than an in-flight
          // audit can reasonably hold a user, or waiting already failed once.
          // Now it earns the breaker.
          const cooldownMs = computeQuotaCooldownMs(String(err?.message || err));
          geminiBreaker.trip(cooldownMs, readable.message);
          console.log(
            `[Gemini] rate limited beyond what an in-flight audit can wait out (asked for ${
              suggestedMs ? formatDuration(suggestedMs) : 'no stated delay'
            }); breaker tripped for ${formatDuration(cooldownMs)}`
          );
          throw err;
        }

        const retryable = readable.kind === 'timeout' || readable.kind === 'network';
        if (!retryable || attempt > maxRetries) throw err;

        const waitMs = Math.min(20000, 5000 * attempt);
        console.log(`[Gemini] ${readable.kind} on attempt ${attempt}/${maxRetries}; retrying in ${Math.round(waitMs / 1000)}s`);
        await delay(waitMs);
      }
    }
  }


  /**
   * Retry-safety for the endpoints that spend Gemini quota.
   *
   * Two stores because the two shapes of work differ: an audit is a job id
   * that outlives the request, while brand lookup and query generation are
   * a promise the request awaits. Both are keyed on the client's
   * `Idempotency-Key`, which is stable across `apiFetch`'s own retries.
   *
   * The in-flight store's TTL only needs to cover one client's retry budget
   * (~10s of backoff); the job store matches the audit job TTL so a replayed
   * submit finds the job still pollable.
   */
  const inFlightRequests = new IdempotencyStore<Promise<any>>(60 * 1000);

  /**
   * Namespace a client key by the route it was sent to. One store serves
   * several endpoints whose results have different shapes, so a key reused
   * across two of them would otherwise hand the second caller the first
   * one's payload. Client keys are per-click UUIDs and should never collide,
   * but "should never" is not a reason to leave it possible.
   */
  const scopedKey = (route: string, key: string | undefined, owner = '') => (key ? `${route}:${owner}:${key}` : undefined);

  // Health check API
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      environment: process.env.NODE_ENV || 'development',
      // Be explicit about what this deployment cannot promise, so a monitor or
      // a person reading /api/health is not left to assume durability exists.
      storage: { kind: store.info().kind, durable: store.info().durable },
      trustProxyHops,
      uptimeSeconds: Math.round(process.uptime()),
      commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || undefined,
    });
  });

  /**
   * Lets the frontend check quota state before a user fills out the whole
   * form and submits into a wall we already know is there - the exact loop
   * that kept repeating: submit, wait, get an exhausted-quota error, submit
   * again immediately.
   */
  app.get('/api/audit/status', (req, res) => {
    const status = geminiBreaker.status();
    res.json({
      engines: configuredEngines(),
      quota: {
        available: !status.tripped,
        reason: status.reason,
        resetAt: status.resetAt ? new Date(status.resetAt).toISOString() : null,
        msRemaining: status.msRemaining,
      },
      // What the sign-in page and the sidebar need to tell the truth about
      // this deployment: can people sign in, and will their audits be kept.
      storage: store.info(),
      auth: { mode: auth.mode, problem: auth.problem },
      // What this server will and will not spend (owner directive D-1, $0). Counts are for this process only.
      spend: {
        paidEnginesBlocked: paidEnginesBlocked(process.env),
        geminiCallsToday: geminiCalls.today(),
        geminiDailyCap: dailyCallCap(process.env),
        scope: 'this server instance only',
      } satisfies SpendStatus,
    });
  });

  /**
   * Deep readiness: does this deployment actually work, not just answer HTTP?
   *
   * A wrong model id or a rejected key is currently discovered by the first
   * person to run an audit. This asks for one tiny answer from Gemini (the one
   * engine that is mandatory) and round-trips the store, so the failure shows
   * up when the operator checks a deploy. It states exactly what it verified:
   * engines it did not call are reported as "not checked", never as healthy.
   * Cached, because every call spends a real request of a shared quota.
   */
  const READINESS_TTL_MS = 5 * 60 * 1000;
  let readinessCache: { at: number; body: any } | null = null;
  // Concurrent cold requests share ONE check. The cache used to be filled only
  // after the await, so 15 simultaneous requests made 11 real Gemini calls.
  let readinessInFlight: Promise<any> | null = null;
  async function checkReadiness() {
    /** `verified`: this check made a real call or write. A key merely being set is not verified. */
    const checks: { name: string; ok: boolean; verified: boolean; detail: string }[] = [];

    checks.push({
      name: 'sign-in',
      verified: true,
      ok: auth.mode === 'configured',
      detail:
        auth.mode === 'configured'
          ? 'SESSION_SECRET and ACCESS_CODES are set.'
          : auth.mode === 'dev'
            ? 'Development mode: any email with the dev code can sign in. Not acceptable for a real deployment.'
            : auth.problem || 'Sign-in is not configured.',
    });

    const info = store.info();
    try {
      const probe = `readiness-${crypto.randomBytes(3).toString('hex')}`;
      await store.createJob({ id: probe, owner: 'readiness@system', status: 'done', startedAt: Date.now(), billable: false });
      const back = await store.getJob(probe);
      // (The probe row is non-billable and ages out with ordinary job retention.)
      checks.push({
        name: 'storage',
        verified: true,
        ok: !!back && info.durable,
        detail: !back
          ? 'The store accepted a write but did not return it.'
          : info.durable
            ? `${info.kind} store works and survives restarts.`
            : info.note || 'Storage works but is not durable: audits are lost on restart.',
      });
    } catch (err: any) {
      checks.push({ name: 'storage', verified: true, ok: false, detail: `The store could not be written: ${err?.message || err}` });
    }

    const ai = getGeminiClient();
    if (!ai) {
      checks.push({ name: 'gemini', verified: true, ok: false, detail: 'GEMINI_API_KEY is not set. Audits cannot be analysed without it.' });
    } else if (geminiBreaker.isTripped()) {
      checks.push({ name: 'gemini', verified: false, ok: false, detail: geminiBreaker.status().reason || 'The Gemini quota is known to be exhausted.' });
    } else {
      try {
        const reply = await generateContentWithRetry(ai, { model: AUDIT_MODEL, contents: 'Reply with the single word OK.' }, 0);
        checks.push({
          name: 'gemini',
          verified: true,
          ok: typeof reply?.text === 'string' && reply.text.trim().length > 0,
          detail: `Model ${AUDIT_MODEL} answered a live request.`,
        });
      } catch (err: any) {
        checks.push({
          name: 'gemini',
          verified: true,
          ok: false,
          detail: `${describeProviderError(err, 'Gemini').message} (model: ${AUDIT_MODEL})`,
        });
      }
    }

    for (const engine of configuredEngines().filter((e) => e !== 'Gemini')) {
      checks.push({
        name: engine.toLowerCase(),
        verified: false,
        ok: true,
        detail: `${engine}'s key is set. Its answers have not been verified against a live call by this check.`,
      });
    }

    return { checkedAt: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
  }

  app.get(
    '/api/audit/readiness',
    handle(async (req, res) => {
      const age = readinessCache ? Date.now() - readinessCache.at : Infinity;
      const fresh = age < READINESS_TTL_MS;
      // A forced refresh is still limited to once a minute: it spends quota.
      const wantsRefresh = req.query.refresh === '1' && age >= 60_000;
      let served = fresh && !wantsRefresh;
      if (!served) {
        if (!readinessInFlight) {
          readinessInFlight = checkReadiness()
            .then((body) => {
              readinessCache = { at: Date.now(), body };
              return body;
            })
            .finally(() => {
              readinessInFlight = null;
            });
        }
        await readinessInFlight;
      }
      res.json({ ...readinessCache!.body, cached: served });
    })
  );

  // ---- Sign in. An email plus an access code the operator handed out; the
  // answer is an expiring, signed session token (src/auth.ts). A tighter
  // limit than the audit routes: this is the one place a code can be guessed.
  const AUTH_RATE_LIMIT_PER_MIN = Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? 10);
  const authLimiter = new FixedWindowLimiter(AUTH_RATE_LIMIT_PER_MIN, 60_000);

  app.post('/api/auth/login', (req, res) => {
    if (AUTH_RATE_LIMIT_PER_MIN > 0) {
      const decision = authLimiter.check(limiterKey(req.ip));
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        return res.status(429).json({
          error: `Too many sign-in attempts. Please wait ${decision.retryAfterSeconds} seconds and try again.`,
        });
      }
    }
    if (auth.mode === 'unconfigured') {
      return res.status(503).json({ error: auth.problem, code: 'auth_unconfigured' });
    }
    // Development sign-in is for the machine it runs on. Even if it is switched
    // on by mistake on a reachable host, strangers are not let in by it.
    if (!devLoginAllowed(auth, req.ip)) {
      return res.status(403).json({
        error: 'Development sign-in only works from the same machine as the server. Configure SESSION_SECRET and ACCESS_CODES to let other people in.',
      });
    }
    const email = normaliseEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
    const matched = checkAccessCode(req.body?.accessCode, auth);
    if (!matched) {
      return res.status(401).json({ error: 'That access code is not valid. Check it with the person who invited you.' });
    }
    const { token, expiresAt } = issueToken(email, matched.codeId, auth);
    res.json({ user: publicUser(userFromEmail(email, matched.label)), token, expiresAt });
  });

  // Lets the client confirm a stored session is still good (not expired, its
  // code not revoked) instead of trusting whatever is in localStorage.
  app.get('/api/auth/me', requireAuth, (_req, res) => {
    res.json({ user: publicUser(res.locals.user), storage: store.info() });
  });

  // POST: Live URL & Brand Name parser using Gemini Grounded Web Search
  app.post('/api/audit/parse-url', async (req, res) => {
    const idempotencyKey = scopedKey('parse-url', readIdempotencyKey(req.headers as any), res.locals.user?.owner);
    try {
      const { input } = req.body ?? {};
      if (!input || typeof input !== 'string' || !input.trim()) {
        return res.status(400).json({ error: 'Enter a brand name or website address to look up.' });
      }
      if (input.length > 300) {
        return res.status(400).json({ error: 'That is too long to look up. Enter just the brand name or website address.' });
      }

      // One click on "Auto-Detect" costs one Gemini call however many times
      // the client had to retry the connection to deliver it.
      const { value } = inFlightRequests.run(idempotencyKey, () => parseUrlWork(String(input)));
      try {
        return res.json(await value);
      } catch (workErr) {
        // A failed lookup must not be replayed as a cached failure - the
        // user's next click deserves a real attempt.
        inFlightRequests.forget(idempotencyKey);
        throw workErr;
      }
    } catch (err: any) {
      const readable = describeProviderError(err, 'Brand lookup');
      console.log(`parse-url failed: ${readable.message}`);
      res.status(500).json({ error: readable.message });
    }
  });

  /** The actual brand lookup, separated so it can be shared by retried requests. */
  async function parseUrlWork(input: string): Promise<any> {
    const cleanedInput = input.trim();
    let parsedDomain = '';
    let parsedBusinessName = '';

    // Try parsing domain out of raw URL or domain input
    try {
      if (cleanedInput.startsWith('http://') || cleanedInput.startsWith('https://')) {
        const urlObj = new URL(cleanedInput);
        parsedDomain = urlObj.hostname.replace(/^www\./, '');
      } else if (/\.[a-z]{2,}(\/.*)?$/i.test(cleanedInput)) {
        const urlObj = new URL(`https://${cleanedInput}`);
        parsedDomain = urlObj.hostname.replace(/^www\./, '');
      }
    } catch {
      // Not a direct URL, handle as brand name string
    }

    // Only a domain the person actually typed (or pasted as a URL) is a fact. For a
    // plain brand name the old code invented `<name>.com`, returned it even when the
    // lookup failed, and the form filled it in under a notice saying nothing had
    // been guessed. It stays blank unless the lookup itself finds one.
    if (parsedDomain) {
      const domainNamePart = parsedDomain.split('.')[0];
      parsedBusinessName = domainNamePart.charAt(0).toUpperCase() + domainNamePart.slice(1);
    } else {
      parsedBusinessName = cleanedInput;
    }

    const ai = getGeminiClient();
    let details = null;
    let detectionError: unknown = null;

    if (ai) {
      try {
        const prompt = `Analyze the brand/business "${parsedBusinessName}"${parsedDomain ? ` (Domain: ${parsedDomain})` : ' (the domain is unknown: find it)'}.
Use live web search to identify real current details:
1. Exact official business name
2. Official primary domain
3. Industry / Category (e.g., Financial Tech, Cloud Observability, Software Development, E-Commerce)
4. Core Offerings (concise summary of top products/services)
5. Target Audience (e.g. Enterprise CTOs, Developers, Small Business Owners)
6. Top 3-4 Direct Competitors (brand names)

Return a valid JSON object matching the requested schema.`;

        // No retries: this runs while the user waits on the form, and a
        // quota back-off here is what surfaced as "Brand lookup could not be
        // reached". Failing fast keeps their typed values and moves on.
        const response = await generateContentWithRetry(ai, {
          model: AUDIT_MODEL,
          contents: prompt,
          config: {
            systemInstruction: 'You are a strict data auditing tool. Do not generate fictional or inferred metrics. If live data or search citations are unavailable for a query, explicitly return null/empty arrays instead of generating placeholders.',
            tools: [{ googleSearch: {} }],
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                businessName: { type: Type.STRING },
                domain: { type: Type.STRING },
                industry: { type: Type.STRING },
                coreOfferings: { type: Type.STRING },
                targetAudience: { type: Type.STRING },
                competitors: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['businessName', 'domain', 'industry', 'coreOfferings', 'targetAudience', 'competitors']
            }
          }
        }, 0);

        details = parseJsonText(response.text);
      } catch (genErr) {
        detectionError = genErr;
        console.log(`Brand lookup failed: ${describeProviderError(genErr, 'Brand lookup').message}`);
      }
    }

    // Detection either worked or it did not. Inventing an industry, a set of
    // offerings or a competitor list would put made-up facts about a real
    // business in front of the user, and the client would then overwrite what
    // they typed with them. Return only what we actually derived.
    if (!details || !details.businessName) {
      return {
        details: {
          businessName: parsedBusinessName,
          domain: parsedDomain,
        },
        detected: false,
        reason: detectionError
          ? describeProviderError(detectionError, 'Brand lookup').message
          : 'Brand lookup returned nothing for this input.',
      };
    }

    // A found domain must look like one. A model that cannot find it returns "N/A",
    // "unknown" or a whole URL, and the form would fill that in as if it were a fact.
    const foundDomain = normaliseDomain(String(details.domain || ''));
    // (If the person typed a URL or domain, that is a fact and is kept when the lookup's is unusable.)
    details.domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(foundDomain) ? foundDomain : parsedDomain;
    return { details, detected: true };
  }

  // Helper to safely parse JSON from model output
  const parseJsonText = (text?: string) => {
    if (!text) return null;
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  };

  // The standard queries live in src/queries.ts (pure and tested). Kept under
  // its old local name so every call site reads the same.
  const getFallbackQueries = (businessName: string, _domain?: string, industry?: string, _coreOfferings?: string, competitors?: any) =>
    buildStandardQueries(businessName, industry, competitors);

  // POST: Generate viewer-intent query matrix for a business (the top DEFAULT_QUERY_COUNT real-world queries)
  /**
   * Build the query matrix for a business. Shared by the endpoint and by the
   * audit job, so a browser never has to hold a request open for it.
   */
  async function generateAuditQueries(
    aiInstance: any,
    opts: { businessName: string; domain?: string; industry?: string; coreOfferings?: string; competitors?: any }
  ): Promise<{ queries: any[]; source: 'generated' | 'standard' }> {
    const { businessName, domain, industry, coreOfferings, competitors } = opts;
    const competitorText = Array.isArray(competitors) && competitors.length > 0
      ? competitors.join(', ')
      : 'none supplied - infer the real competitors from live search';

    const prompt = `You are a Generative Engine Optimization (GEO) & AI Search auditor.
Using live web search grounding, generate the ${DEFAULT_QUERY_COUNT} most relevant, real-world search queries that target customers actually use when searching for or evaluating "${businessName}"${domain ? ` (Domain: ${domain})` : ''}${industry ? `, which operates in: "${industry}"` : ''}.
Write the queries the way a real buyer would type them into an AI assistant. If the business is local or physical, include the kind of location-aware phrasing buyers actually use.
Competitors: ${competitorText}.

Categorize each query under one of these intents:
- commercial_comparison
- direct_recommendation
- alternatives_search
- feature_specific
- localized_vendor
- pricing_roi

Return a JSON array of exactly ${DEFAULT_QUERY_COUNT} query objects.`;

    try {
      const response = await generateContentWithRetry(aiInstance, {
        model: AUDIT_MODEL,
        contents: prompt,
        config: {
          systemInstruction:
            'You produce realistic buyer search queries. Never invent metrics or statistics.',
          tools: [{ googleSearch: {} }],
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING, description: 'Unique query id, e.g. q-1' },
                intent: { type: Type.STRING, description: 'One of the allowed query intent strings' },
                queryText: { type: Type.STRING, description: 'Exact search query string' },
                targetPersona: { type: Type.STRING, description: 'Target user persona asking this query' }
              },
              required: ['id', 'intent', 'queryText', 'targetPersona']
            }
          }
        }
      });
      const parsed = parseJsonText(response.text);
      if (Array.isArray(parsed) && parsed.length > 0) return { queries: parsed.slice(0, DEFAULT_QUERY_COUNT), source: 'generated' };
    } catch (genErr: any) {
      console.log(`Query generation failed: ${describeProviderError(genErr, 'Gemini').message}`);
    }

    // The model gave nothing usable (or failed): say these are the standard
    // set, not something it wrote - the client labels them accordingly.
    return { queries: getFallbackQueries(businessName, domain, industry, coreOfferings, competitors), source: 'standard' };
  }

  app.post('/api/audit/generate-queries', async (req, res) => {
    const idempotencyKey = scopedKey('generate-queries', readIdempotencyKey(req.headers as any), res.locals.user?.owner);
    try {
      const businessName = cleanText(req.body?.businessName, MAX_NAME_LENGTH);
      if (!businessName) {
        return res.status(400).json({ error: 'A business or brand name is required.' });
      }
      const domain = cleanText(req.body?.domain, 200);
      const industry = cleanText(req.body?.industry, 200);
      const coreOfferings = cleanText(req.body?.coreOfferings, 300);
      const competitors = cleanCompetitors(req.body?.competitors);
      const ai = getGeminiClient();
      if (!ai) {
        return res.json({ queries: getFallbackQueries(businessName, domain, industry, coreOfferings, competitors), source: 'standard' });
      }
      // One click on "Generate Query Matrix" costs one Gemini call, however
      // many connection attempts it took to deliver the request.
      const { value } = inFlightRequests.run(idempotencyKey, () =>
        generateAuditQueries(ai, { businessName, domain, industry, coreOfferings, competitors })
      );
      let result: { queries: any[]; source: 'generated' | 'standard' };
      try {
        result = await value;
      } catch (workErr) {
        inFlightRequests.forget(idempotencyKey);
        throw workErr;
      }
      res.json(result);
    } catch (err: any) {
      // Never invent a name for the business: a query about "Business" is a
      // question nobody asked. Validation above already guaranteed a real one.
      res.json({
        queries: getFallbackQueries(
          cleanText(req.body?.businessName, MAX_NAME_LENGTH),
          req.body?.domain,
          req.body?.industry,
          req.body?.coreOfferings,
          req.body?.competitors
        ),
        source: 'standard',
      });
    }
  });

  // POST: Evaluate search visibility across AI search engines for a single query (auto or manually added)
  /**
   * Append one manually-typed query to a live audit.
   *
   * Uses the same evidence-first pipeline as a full audit: every engine is
   * genuinely queried, and the returned position is computed from the answer
   * text rather than asserted by a model.
   */
  app.post('/api/audit/evaluate-query', async (req, res) => {
    try {
      const businessName = cleanText(req.body?.businessName, MAX_NAME_LENGTH);
      const domain = cleanText(req.body?.domain, 200);
      const queryText = cleanText(req.body?.queryText, MAX_QUERY_LENGTH);
      const competitors = cleanCompetitors(req.body?.competitors);

      if (!businessName || !queryText) {
        return res.status(400).json({ error: 'Enter a search query to evaluate.' });
      }

      const ai = getGeminiClient();
      const engines = configuredEngines();

      const query = {
        id: `q-manual-${Date.now()}`,
        intent: 'feature_specific',
        queryText: String(queryText).trim(),
        targetPersona: 'Target Customer',
      };

      // Vendor discovery runs on Gemini, so Gemini is required even when other
      // engines are configured. Say which key is missing rather than claiming
      // nothing is configured.
      if (!ai) {
        const others = engines.filter((e) => e !== 'Gemini');
        return res.status(503).json({
          error: others.length
            ? `GEMINI_API_KEY is required to analyse answers, even though ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} configured.`
            : 'No answer engine is configured, so this query cannot be measured.',
        });
      }
      if (engines.length === 0) {
        return res.status(503).json({
          error: 'No answer engine is configured, so this query cannot be measured.',
        });
      }

      const competitorList = competitors;

      // One click on "Add & Audit Query" costs one round of engine calls,
      // however many connection attempts it took to deliver the request.
      const idempotencyKey = scopedKey('evaluate-query', readIdempotencyKey(req.headers as any), res.locals.user?.owner);
      const { value: evidencePromise } = inFlightRequests.run(idempotencyKey, () =>
        collectQueryEvidence(ai, query, engines)
      );
      let evidence: QueryEvidence[];
      try {
        evidence = await evidencePromise;
      } catch (workErr) {
        inFlightRequests.forget(idempotencyKey);
        throw workErr;
      }
      const usable = evidence.filter((e) => !e.error && e.answerText.trim().length > 0);

      if (usable.length === 0) {
        const readable = summariseFailures(evidenceFailures(evidence), 'The answer engine');
        return res.status(502).json({ error: readable.message });
      }

      const clientMatcher = buildBrandMatcher(businessName, domain);
      const competitorMatchers = competitorList.map((c: string) => buildBrandMatcher(c));
      const discovered = discoverVendors(evidence, [clientMatcher, ...competitorMatchers]);

      const allMatchers = dedupeMatchers([
        clientMatcher,
        ...competitorList.map((c: string) => buildBrandMatcher(c)),
        ...discovered.map((d) => buildBrandMatcher(d)),
      ]);

      const engineResults: Record<string, any> = {};
      let bestProminence = 0;
      const aheadUnion = new Set<string>();

      for (const ev of evidence) {
        if (ev.error || !ev.answerText.trim()) {
          engineResults[ev.engine] = {
            engine: ev.engine,
            status: 'retrieval_failed',
            position: null,
            excerpt: `No answer captured from ${ev.engine}${ev.error ? `: ${ev.error}` : ''}.`,
            citations: [],
          };
          continue;
        }

        const rows = analyseAnswer(ev, allMatchers);
        const client = rows.find((r) => r.brand === clientMatcher.label);
        const ahead = rows
          .filter((r) => r.rank && (!client?.rank || r.rank < client.rank))
          .sort((a, b) => (a.rank || 0) - (b.rank || 0))
          .map((r) => r.brand);
        ahead.forEach((b) => aheadUnion.add(b));
        bestProminence = Math.max(bestProminence, client?.prominence ?? 0);

        engineResults[ev.engine] = {
          engine: ev.engine,
          status: !client || !client.mentioned
            ? 'omitted'
            : client.rank === 1
              ? 'recommended_leader'
              : 'secondary_mention',
          position: client?.rank ?? null,
          excerpt:
            client?.excerpt ||
            `${businessName} was not named. Vendors named instead: ${ahead.join(', ') || 'none identified'}.`,
          citations: ev.citations.map((c) => c.url),
          keyOmissionReason:
            !client?.mentioned && ahead.length > 0
              ? `Answer surface taken by: ${ahead.slice(0, 5).join(', ')}`
              : undefined,
        };
      }

      const evaluatedQuery = {
        ...query,
        engines: engineResults,
        evidence: evidence.map((ev) => ({
          engine: ev.engine,
          answerText: ev.answerText,
          citations: ev.citations,
          searchQueries: ev.searchQueries,
          capturedAt: ev.capturedAt,
          error: ev.error,
        })),
        competitorsAhead: Array.from(aheadUnion),
        prominence: bestProminence,
      };

      res.json({ evaluatedQuery });
    } catch (err: any) {
      console.log(`evaluate-query failed: ${err?.message || err}`);
      res.status(500).json({ error: describeProviderError(err, 'The answer engine').message });
    }
  });

  // POST: Execute complete live AI Search Audit
  /**
   * Layer 1 - Evidence collection.
   * Queries one answer engine and captures exactly what came back: verbatim
   * text, real publisher domains, and the searches the engine actually ran.
   */
  async function collectGeminiEvidence(
    aiInstance: any,
    query: any
  ): Promise<QueryEvidence> {
    const base: QueryEvidence = {
      queryId: query.id,
      queryText: query.queryText,
      answerText: '',
      citations: [],
      searchQueries: [],
      capturedAt: new Date().toISOString(),
      engine: 'Gemini',
    };

    try {
      const response = await generateContentWithRetry(aiInstance, {
        model: AUDIT_MODEL,
        contents: `${query.queryText}`,
        config: {
          systemInstruction:
            'You are an AI search assistant answering a real user question. Use live web search and recommend the specific vendors, products or providers that genuinely best answer the question, naming each one explicitly. Do not mention that you are part of an audit.',
          tools: [{ googleSearch: {} }],
        },
      });

      const candidate = response.candidates?.[0];
      const metadata = candidate?.groundingMetadata;
      const chunks = metadata?.groundingChunks || [];

      const citations = dedupeCitations(
        chunks.map((chunk: any) => ({
          url: chunk?.web?.uri || '',
          title: chunk?.web?.title || '',
        }))
      );

      return {
        ...base,
        answerText: response.text || '',
        citations,
        searchQueries: metadata?.webSearchQueries || [],
      };
    } catch (err: any) {
      // The raw provider text stays in the server log; the report only ever
      // carries a sentence (CLAUDE.md: no user-visible message contains raw
      // provider JSON).
      console.log(`[Gemini] evidence failed for "${query.queryText}": ${err?.message || err}`);
      const readable = describeProviderError(err, 'Gemini');
      return { ...base, error: readable.message, errorKind: readable.kind };
    }
  }

  /** The failures in a set of evidence, as readable errors ready for summariseFailures. */
  function evidenceFailures(evidence: QueryEvidence[]): ReadableError[] {
    return evidence
      .filter((e) => e.error)
      .map((e) => ({ kind: (e.errorKind as ReadableError['kind']) || 'unknown', message: e.error as string }));
  }

  /** Collect evidence for one query across every configured engine. */
  async function collectQueryEvidence(
    aiInstance: any,
    query: any,
    engines: EngineName[]
  ): Promise<QueryEvidence[]> {
    const tasks = engines.map(async (engine): Promise<QueryEvidence> => {
      if (engine === 'Gemini') return collectGeminiEvidence(aiInstance, query);

      const answer = await askEngine(engine, query.queryText);
      // The adapter already worded the failure for this provider; describing it again
      // flattened every specific reason ("cut off", "declined", "out of credit") to
      // "unexpected error".
      if (answer.error) console.log(`[${engine}] evidence failed for "${query.queryText}": ${answer.rawError || answer.error}`);
      return {
        queryId: query.id,
        queryText: query.queryText,
        answerText: answer.answerText,
        citations: answer.citations,
        searchQueries: answer.searchQueries,
        capturedAt: new Date().toISOString(),
        engine,
        error: answer.error,
        errorKind: answer.errorKind,
      };
    });

    return Promise.all(tasks);
  }

  /**
   * Layer 2a - Vendor discovery.
   *
   * Ranking a brand only against the competitors the user happened to type
   * overstates its position: if the engine names four vendors and the user
   * tracks one, the client can look like #2 while actually placing #5. So we
   * read the vendors named in each answer, then DISCARD any that do not
   * literally appear in the source text. The model is used to perceive names,
   * never to judge - anything it invents is dropped before it can affect a metric.
   */
  /**
   * Find vendor-name candidates in captured evidence with zero LLM calls.
   *
   * This used to ask Gemini to list vendors, then verify every returned name
   * literally occurs in the source text before accepting it - meaning the
   * model's answer was already being fully re-derived from the text either
   * way. That verification step alone (extractCandidateVendors -> the same
   * findFirstMention check every discovered name already had to survive) is
   * sufficient, and removes one Gemini call from every single audit -
   * previously the single largest reason a one-query search cost far more
   * than one query's worth of quota.
   */
  function discoverVendors(evidenceForQuery: QueryEvidence[], excludeMatchers: any[]): string[] {
    const usable = evidenceForQuery.filter((e) => !e.error && e.answerText.trim().length > 0);
    if (usable.length === 0) return [];

    // Merge candidates across every answer, keeping the first-seen casing
    // for each distinct name rather than collapsing to a lowercase key.
    const byKey = new Map<string, string>();
    for (const ev of usable) {
      for (const candidate of extractCandidateVendors(ev.answerText, excludeMatchers)) {
        const key = candidate.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, candidate);
      }
    }
    return Array.from(byKey.values());
  }

  /**
   * Layer 3 - Narrative interpretation.
   * The model receives captured evidence and the already-computed metrics, and
   * is asked only for qualitative judgement. It is never asked for a number.
   */
  async function generateNarrative(aiInstance: any, ctx: any) {
    const evidenceDigest = ctx.usableEvidence
      // Every answer the accuracy rate counts must be one the model was shown: 8 queries
      // across 4 engines is 32. (A cap below that made unseen answers count as "no
      // flagged inaccuracy".)
      .slice(0, NARRATIVE_MAX_ANSWERS)
      .map((ev: QueryEvidence) => {
        const rows = ctx.analysisByEvidence.get(ev);
        const client = rows?.find((r: any) => r.brand === ctx.clientLabel);
        const ahead = (rows || [])
          .filter((r: any) => r.rank && (!client?.rank || r.rank < client.rank))
          .map((r: any) => r.brand);
        return [
          `[Q${(ctx.queryNumberOf.get(ev) ?? 0) + 1}][${ev.engine}] QUERY: "${ev.queryText}"`,
          `Client named: ${client?.mentioned ? `YES (position ${client.rank} of ${(rows || []).filter((r: any) => r.rank).length} vendors named)` : 'NO'}`,
          `Vendors named ahead of client: ${ahead.join(', ') || 'none'}`,
          `Sources cited: ${ev.citations.map((c) => c.domain).join(', ') || 'none'}`,
          `Answer excerpt: ${(ev.answerText || '').slice(0, 1000)}`,
        ].join('\n');
      })
      .join('\n\n---\n\n');

    const topSources = ctx.citationSources
      .slice(0, 12)
      .map((s: any) => `${s.domain} (cited ${s.citationCount}x across ${s.queryCount} queries)${s.isOwned ? ' [CLIENT-OWNED]' : ''}`)
      .join('\n');

    const prompt = `You are a senior Generative Engine Optimization (GEO) consultant writing the analysis section of a paid audit for "${ctx.businessName}" ${ctx.domain ? `(${ctx.domain})` : '(no website was given)'}.

Industry: ${ctx.industry}
Core offerings: ${ctx.coreOfferings}
Competitors the client asked us to track: ${ctx.competitorList.join(', ') || 'none supplied'}
Engines actually queried: ${ctx.measuredEngines.join(', ')}

MEASURED RESULTS (computed from captured evidence - do NOT recompute or contradict):
- Cited in ${ctx.clientScore.timesMentioned} of ${ctx.totalObservations} engine answers (${ctx.clientScore.visibility}% visibility)
- Share of voice against every vendor named by the engines: ${ctx.clientScore.shareOfVoice}%
- Named first in ${ctx.clientScore.timesFirst} answers
${ctx.domain ? `- Client's own domain cited as a source ${ctx.clientScore.citedAsSourceCount} times` : '- Client website: not given, so whether it is cited was not measured'}

VENDOR SCOREBOARD (all vendors the engines actually named):
${ctx.scorecards.map((s: any) => `- ${s.brand}: named in ${s.timesMentioned}/${ctx.totalObservations} answers, ${s.shareOfVoice}% share of voice, first ${s.timesFirst}x`).join('\n')}

SOURCES THE ENGINES RELIED ON:
${topSources || 'none captured'}

RAW EVIDENCE:
${evidenceDigest}

Write the analysis. Rules:
- Ground every statement in the evidence above. Never invent a statistic, citation or competitor.
- If competitors appear in the scoreboard that the client did not ask us to track, call that out explicitly - discovering an unexpected rival is a valuable finding.
- "inaccuracies": only claims made about ${ctx.businessName} that are wrong or misleading, quoting the claim verbatim. Return an empty array if the evidence shows none. Never invent one to fill space. Each one names the answer it comes from: "queryNumber" is the Q number shown in the evidence, "engine" is the engine in brackets, and "queryText" is that query copied exactly.
- "omissions": explain WHY the brand is absent where it is absent, tied to the specific source domains above. Categories: "Schema & Entity Data", "Review & Directory Signals", "Comparison & Top 10 Coverage", "Reddit / Forum Sentiment", "Pricing & Feature Clarity".
- "remediationPlan": 4-7 concrete tasks, each targeting a gap visible in the evidence, naming the exact source domains to pursue. Include valid JSON-LD in codeSnippet only where genuinely useful.
  priority: "P0 Critical" | "P1 High" | "P2 Medium" | "P3 Maintenance"
  effort: "Quick Win (< 2h)" | "Moderate (1-2 days)" | "Strategic (1-2 weeks)"
- "executiveSummary": 3-5 sentences a CMO can read: the visibility position, who owns the answer surface and why, and the highest-leverage move. Do not state any number, percentage, count or multiple in it (not even "twice" or "a third"): the report states the measured figures itself, and any sentence containing a figure is removed.

Return valid JSON matching the schema.`;

    const response = await generateContentWithRetry(aiInstance, {
      model: AUDIT_MODEL,
      contents: prompt,
      config: {
        systemInstruction:
          'You are a rigorous audit analyst. Every claim must trace to supplied evidence. Empty arrays are strongly preferred over invented findings.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            executiveSummary: { type: Type.STRING },
            inaccuracies: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  engine: { type: Type.STRING },
                  queryNumber: { type: Type.INTEGER },
                  queryText: { type: Type.STRING },
                  claimedFact: { type: Type.STRING },
                  actualFact: { type: Type.STRING },
                  impactSeverity: { type: Type.STRING },
                  sourceOriginUrl: { type: Type.STRING },
                },
                required: ['engine', 'queryNumber', 'queryText', 'claimedFact', 'actualFact', 'impactSeverity'],
              },
            },
            omissions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  description: { type: Type.STRING },
                  affectedQueriesCount: { type: Type.INTEGER },
                  rootCause: { type: Type.STRING },
                  recommendation: { type: Type.STRING },
                },
                required: ['category', 'description', 'rootCause', 'recommendation'],
              },
            },
            remediationPlan: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  category: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  effort: { type: Type.STRING },
                  expectedGain: { type: Type.STRING },
                  description: { type: Type.STRING },
                  stepByStepInstructions: { type: Type.ARRAY, items: { type: Type.STRING } },
                  codeSnippet: { type: Type.STRING },
                  targetUrls: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['title', 'category', 'priority', 'effort', 'description', 'stepByStepInstructions'],
              },
            },
          },
          required: ['executiveSummary', 'inaccuracies', 'omissions', 'remediationPlan'],
        },
      },
    });

    return parseJsonText(response.text);
  }

  /**
   * Run a full audit and return the response payload.
   *
   * Deliberately separated from the HTTP handler: an audit can take minutes
   * once engine pacing and quota back-off are involved, and a browser (mobile
   * Safari especially) aborts a request that long. The endpoint starts this as
   * a background job and the client polls for the result.
   */
  /** What an in-flight audit is doing, for the client to display truthfully. */
  interface AuditProgress {
    phase: 'querying' | 'analysing';
    /** Queries fully collected so far. */
    done: number;
    total: number;
  }

  async function performAudit(
    req: { body: any },
    onProgress: (p: AuditProgress) => void = () => {}
  ): Promise<any> {
    try {
      const {
        businessName,
        domain,
        industry,
        coreOfferings,
        targetAudience,
        competitors,
        queries,
      } = req.body;

      if (!businessName) {
        return { error: 'businessName is required', badRequest: true };
      }

      const ai = getGeminiClient();
      // Users paste full URLs into the domain field; store the bare host so
      // links render correctly and source matching compares like with like.
      const cleanDomain = normaliseDomain(domain || '');
      const competitorList = (Array.isArray(competitors) ? competitors : [competitors])
        .filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        .map((c: string) => c.trim());

      const suppliedQueries = Array.isArray(queries) ? queries.filter((q: any) => q?.queryText) : [];

      // Template-generated, not a Gemini call: a one-query audit should cost
      // one query's worth of quota, not one call to invent the query on top
      // of it. The LLM-authored version of this (generateAuditQueries) is
      // still available, but only behind the explicit "Generate Query
      // Matrix" step in the Run Audit modal - a deliberate spend the user
      // opted into, not something every default audit pays silently.
      const generatedQueries =
        suppliedQueries.length === 0
          ? getFallbackQueries(businessName, cleanDomain, industry, coreOfferings, competitorList)
          : [];

      const queryList = [...generatedQueries, ...suppliedQueries].slice(0, MAX_AUDIT_QUERIES);

      const engines = configuredEngines();

      if (!ai || engines.length === 0) {
        const others = engines.filter((e) => e !== 'Gemini');
        const reason = !ai && others.length
          ? `GEMINI_API_KEY is required to analyse answers, even though ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} configured. Nothing was measured.`
          : 'No answer engine is configured, so nothing could be measured. Add an engine API key and re-run.';
        return {
          report: {
            ...generateSynthesizedAudit(businessName, cleanDomain, industry, coreOfferings, competitorList, queryList, engines),
            degraded: true,
            degradedReason: reason,
          },
          degraded: true,
        };
      }

      // ---------- Layer 1: collect evidence across every configured engine ----------
      const evidenceByQuery: QueryEvidence[][] = [];
      for (let i = 0; i < queryList.length; i++) {
        // Once quota is known to be exhausted mid-audit, stop immediately
        // rather than pacing through the remaining queries only to have each
        // one fail the same way a moment later.
        if (engines.includes('Gemini') && geminiBreaker.isTripped()) {
          console.log(`Stopping after ${i}/${queryList.length} queries: Gemini quota breaker is tripped.`);
          break;
        }
        if (i > 0) await delay(1200);
        onProgress({ phase: 'querying', done: i, total: queryList.length });
        evidenceByQuery.push(await collectQueryEvidence(ai, queryList[i], engines));
      }
      onProgress({ phase: 'analysing', done: queryList.length, total: queryList.length });

      const allEvidence = evidenceByQuery.flat();
      const usableEvidence = allEvidence.filter((e) => !e.error && e.answerText.trim().length > 0);

      if (usableEvidence.length === 0) {
        // The breaker can trip during query generation, before any per-query
        // evidence collection even starts - the loop then breaks on its
        // first check and `allEvidence` stays empty. Evidence errors would
        // be empty too in that case, and summariseFailures([]) falls back to
        // a generic "returned no answers" that loses the actual reason. The
        // breaker's own status is the source of truth whenever it is tripped.
        const breakerStatus = geminiBreaker.status();
        const readable = breakerStatus.tripped
          ? { message: breakerStatus.reason || 'The answer engine quota is exhausted.' }
          : summariseFailures(evidenceFailures(allEvidence), 'The answer engine');
        const degraded = generateSynthesizedAudit(
          businessName, cleanDomain, industry, coreOfferings, competitorList, queryList, engines, evidenceByQuery
        );
        degraded.executiveSummary =
          `Audit could not complete: ${readable.message} No evidence was collected, so nothing below is a finding about ${businessName}.`;
        return {
          report: {
            ...degraded,
            degraded: true,
            degradedReason: readable.message,
          },
          degraded: true,
        };
      }

      // ---------- Layer 2: deterministic analysis over successful evidence only ----------
      const clientMatcher = buildBrandMatcher(businessName, cleanDomain);
      const clientLabel = clientMatcher.label;

      // Discover the vendors each answer actually named, so ranking is against
      // the real field rather than only the competitors the user typed. Pure
      // text extraction, not a model call - see discoverVendors.
      const trackedMatchers = competitorList.map((c: string) => buildBrandMatcher(c));
      const discovered = discoverVendors(usableEvidence, [clientMatcher, ...trackedMatchers]);
      const discoveredMatchers = discovered.map((d) => buildBrandMatcher(d));
      // Collapse name variants ("Stripe" vs "Stripe, Inc.") so one company
      // cannot occupy two ranks or double-count in share of voice.
      const allMatchers = dedupeMatchers([clientMatcher, ...trackedMatchers, ...discoveredMatchers]);

      const analysisByEvidence = new Map<QueryEvidence, ReturnType<typeof analyseAnswer>>();
      const perObservation = usableEvidence.map((ev) => {
        const rows = analyseAnswer(ev, allMatchers);
        analysisByEvidence.set(ev, rows);
        return rows;
      });

      const scorecards = buildScorecards(perObservation, allMatchers);
      const citationSources = buildCitationSourceMap(usableEvidence, clientMatcher);
      const clientScore = scorecards[0];
      const totalObservations = perObservation.length;
      const measuredEngines = Array.from(new Set(usableEvidence.map((e) => e.engine)));

      // Which query each captured answer belongs to, so the narrative can cite it by number.
      const queryNumberOf = new Map<QueryEvidence, number>();
      evidenceByQuery.forEach((group, qi) => group.forEach((ev) => queryNumberOf.set(ev, qi)));

      // ---------- Layer 3: narrative ----------
      let narrative: any = null;
      // Why the qualitative analysis is missing, when it is. An empty
      // `inaccuracies` array from a model that never answered is NOT a finding
      // of zero inaccuracies - it used to be reported as a 100% accuracy rate,
      // the exact failure-counted-as-success pattern CLAUDE.md forbids.
      let narrativeFailure: string | null = null;
      try {
        await delay(600);
        narrative = await generateNarrative(ai, {
          businessName,
          clientLabel,
          domain: cleanDomain,
          industry: industry || 'not specified',
          coreOfferings: coreOfferings || 'not specified',
          competitorList,
          usableEvidence,
          analysisByEvidence,
          queryNumberOf,
          scorecards,
          clientScore,
          citationSources,
          totalObservations,
          measuredEngines,
        });
      } catch (narrativeErr: any) {
        console.log(`Narrative synthesis failed: ${narrativeErr?.message || narrativeErr}`);
        narrativeFailure = describeProviderError(narrativeErr, 'Gemini').message;
      }
      if (!narrative && !narrativeFailure) {
        narrativeFailure = 'The analysis step returned nothing usable.';
      }
      const narrativeAvailable = narrativeFailure === null;

      // ---------- Layer 4: assemble an honest report ----------
      // How many of the questions asked name the brand outright (see
      // queryNamesBrand): the report says so, because for those the answer is
      // about the brand whatever the engine thinks of it.
      const queriesNamingBrand = queryList.filter((q: any) => queryNamesBrand(q.queryText || '', clientMatcher)).length;

      const queriesTested = queryList.map((q: any, idx: number) => {
        const group = evidenceByQuery[idx] || [];
        const engineResults: Record<string, any> = {};
        let bestProminence = 0;
        const aheadUnion = new Set<string>();

        for (const ev of group) {
          const rows = analysisByEvidence.get(ev);

          if (!rows) {
            engineResults[ev.engine] = {
              engine: ev.engine,
              status: 'retrieval_failed',
              position: null,
              excerpt: `No answer captured from ${ev.engine}${ev.error ? `: ${ev.error}` : ''}. This query was excluded from all metrics.`,
              citations: [],
            };
            continue;
          }

          const client = rows.find((r) => r.brand === clientLabel);
          const ahead = rows
            .filter((r) => r.rank && (!client?.rank || r.rank < client.rank))
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))
            .map((r) => r.brand);
          ahead.forEach((b) => aheadUnion.add(b));
          bestProminence = Math.max(bestProminence, client?.prominence ?? 0);

          engineResults[ev.engine] = {
            engine: ev.engine,
            status: !client || !client.mentioned
              ? 'omitted'
              : client.rank === 1
                ? 'recommended_leader'
                : 'secondary_mention',
            position: client?.rank ?? null,
            excerpt:
              client?.excerpt ||
              `${businessName} was not named. Vendors named instead: ${ahead.join(', ') || 'none identified'}.`,
            citations: ev.citations.map((c) => c.url),
            keyOmissionReason:
              !client?.mentioned && ahead.length > 0
                ? `Answer surface taken by: ${ahead.slice(0, 5).join(', ')}`
                : undefined,
          };
        }

        return {
          ...q,
          engines: engineResults,
          evidence: group.map((ev) => ({
            engine: ev.engine,
            answerText: ev.answerText,
            citations: ev.citations,
            searchQueries: ev.searchQueries,
            capturedAt: ev.capturedAt,
            error: ev.error,
          })),
          competitorsAhead: Array.from(aheadUnion),
          prominence: bestProminence,
        };
      });

      // Which captured answers exist, and which of them name the brand, keyed by
      // (query index, engine) - the unit the accuracy rate is a rate of.
      const mentionedKeys = new Set<string>();
      evidenceByQuery.forEach((group, qi) => {
        for (const ev of group) {
          const rows = analysisByEvidence.get(ev);
          if (!rows) continue;
          if (rows.find((r) => r.brand === clientLabel)?.mentioned) mentionedKeys.add(`${qi}|${ev.engine}`);
        }
      });
      const { kept: attributed, discarded: inaccuraciesDiscarded } = attributeInaccuracies<any>(
        narrative?.inaccuracies || [],
        queryList,
        measuredEngines,
        mentionedKeys
      );
      const inaccuracies = attributed.map(({ claim: item, queryIndex, engine }, i: number) => ({
        id: `inacc-${i + 1}`,
        engine,
        queryId: queryList[queryIndex].id,
        queryText: queryList[queryIndex].queryText,
        claimedFact: item.claimedFact,
        actualFact: item.actualFact,
        impactSeverity: ['high', 'medium', 'low'].includes(item.impactSeverity) ? item.impactSeverity : 'medium',
        sourceOriginUrl: item.sourceOriginUrl,
      }));

      // Accuracy is only meaningful where the brand was actually discussed, and
      // only where the qualitative analysis actually ran. Counted per answer.
      const accuracyRate = narrativeAvailable
        ? computeAccuracyRate(mentionedKeys, attributed.map((a) => `${a.queryIndex}|${a.engine}`))
        : null;

      const untrackedRivals = scorecards
        .filter((s) => discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()))
        .filter((s) => s.timesMentioned > 0)
        .sort((a, b) => b.shareOfVoice - a.shareOfVoice)
        .slice(0, 8)
        .map((s) => s.brand);

      // Questions that got a usable answer in which the brand was named by no engine: what an omission
      // "affects" when the model's own count is missing or impossible. Computed, not guessed.
      const unnamedQuestions = evidenceByQuery.filter(
        (group, qi) =>
          group.some((ev) => !ev.error && ev.answerText.trim().length > 0) && !group.some((ev) => mentionedKeys.has(`${qi}|${ev.engine}`))
      ).length;

      // Strings whose digits are not "figures": what the person typed and what the audit found.
      const guardNames: string[] = [
        businessName, cleanDomain, industry, coreOfferings, targetAudience,
        ...competitorList, ...discovered, ...scorecards.map((s) => s.brand),
        ...queryList.map((q: any) => q.queryText || ''),
      ].map((v) => String(v ?? ''));

      const report = {
        id: `audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        createdAt: new Date().toISOString(),
        businessName,
        domain: cleanDomain,
        industry: industry || '',
        // Blank stays blank. These used to default to "Products and services" /
        // "Buyers and decision makers" - a guess rendered in the report as if
        // it were something the client said about themselves.
        coreOfferings: coreOfferings || '',
        targetAudience: targetAudience || '',
        competitors: competitorList,

        // Metrics computed in code from captured evidence.
        geoVisibilityScore: clientScore.visibility,
        shareOfVoice: clientScore.shareOfVoice,
        leaderShare: clientScore.leaderShare,
        accuracyRate,
        // Model-reported claims that could not be tied to a captured answer and were left out.
        inaccuraciesDiscarded,
        avgProminence: clientScore.avgProminence,

        // Filled in below, once the figures it may state are known.
        executiveSummary: '',

        // Whether the qualitative analysis ran. The three arrays below are
        // empty when it did not, and an empty array must not read as "none found".
        narrativeAvailable,
        narrativeNote: narrativeAvailable
          ? undefined
          : `${narrativeFailure} Visibility, share of voice and the evidence below are measured; accuracy, omissions and the remediation plan were not assessed. Re-run the audit to try again.`,

        queriesTested,
        inaccuracies,
        omissions: (narrative?.omissions || []).map((o: any, i: number) => ({
          id: `om-${i + 1}`,
          category: o.category,
          description: o.description,
          // A model-supplied count is bounded by the number of questions actually asked; a missing or
          // impossible one is replaced by the number of answered questions that never named the brand.
          affectedQueriesCount:
            Number.isInteger(o.affectedQueriesCount) && o.affectedQueriesCount >= 0 && o.affectedQueriesCount <= queryList.length
              ? o.affectedQueriesCount
              : unnamedQuestions,
          rootCause: o.rootCause,
          recommendation: o.recommendation,
        })),
        remediationPlan: (narrative?.remediationPlan || []).map((t: any, i: number) => ({
          id: `rem-${i + 1}`,
          title: t.title,
          category: t.category,
          priority: t.priority,
          effort: t.effort,
          // Free text from the model that states a figure ("+40% visibility in 30 days") is a forecast
          // nobody measured: it is replaced by the plain default.
          expectedGain:
            t.expectedGain && !containsFigure(String(t.expectedGain), guardNames) ? t.expectedGain : 'Improved answer-engine citation rate',
          description: t.description,
          stepByStepInstructions: t.stepByStepInstructions || [],
          codeSnippet: t.codeSnippet,
          targetUrls: t.targetUrls || [],
          completed: false,
        })),

        competitorBenchmarks: scorecards
          .filter((s) => s.brand === clientLabel || s.timesMentioned > 0)
          .map((s) => ({
            name: s.brand === clientLabel ? `${s.brand} (Your Business)` : s.brand,
            domain: s.domain || '',
            shareOfVoice: s.shareOfVoice,
            topRecommendedCount: s.timesFirst,
            // Sources cited where THIS brand was named - not the audit-wide list.
            mainCitationSources: sourcesForBrand(usableEvidence, analysisByEvidence, s.brand, s.domain),
            discovered: discovered.some((d) => d.toLowerCase() === s.brand.toLowerCase()),
          })),

        citationSources,
        measuredEngines,
        // The model id each measured engine was queried with, and when the answers
        // were captured: a number from a model cannot be compared or reproduced
        // without them.
        engineModels: Object.fromEntries(measuredEngines.map((e) => [e, engineModelId(e as EngineName)])),
        answersCapturedFrom: usableEvidence.map((e) => e.capturedAt).sort()[0],
        answersCapturedTo: usableEvidence.map((e) => e.capturedAt).sort().slice(-1)[0],
        untrackedRivals,
        queriesAttempted: queryList.length,
        // Questions that produced at least one usable answer: the independent readings behind
        // the headline (a planned question that failed everywhere, or was never reached after
        // the quota breaker tripped, is not a reading).
        questionsAnswered: evidenceByQuery.filter((group) => group.some((ev) => !ev.error && ev.answerText.trim().length > 0)).length,
        queriesNamingBrand,
        observationsAttempted: allEvidence.length,
        observationsWithEvidence: usableEvidence.length,
        // Numerator behind geoVisibilityScore, so the UI can show "1 of 3".
        observationsMentioned: clientScore.timesMentioned,
        enginesRequested: engines,
      };

      // The model writes the qualitative summary; the figures come from the measurements, stated
      // by the server in the first sentence. A model sentence that states ANY figure is removed and
      // the removal is said, never hidden (docs/RELIABILITY.md section 4). Digits inside names the
      // person typed or the audit found ("3M", "7-Eleven", a query "top 10 ...") are not figures.
      const factualSentence = `${businessName} was named in ${clientScore.timesMentioned} of ${totalObservations} answers captured across ${measuredEngines.join(', ')} (${clientScore.visibility}% visibility), holding ${clientScore.shareOfVoice}% share of voice against every vendor the engines named.`;
      const guarded = narrativeAvailable
        ? guardSummary(typeof narrative?.executiveSummary === 'string' ? narrative.executiveSummary : '', guardNames)
        : null;
      report.executiveSummary = [
        factualSentence,
        guarded ? guarded.text : 'The qualitative analysis (inaccuracies, omissions, remediation plan) could not be generated, so none of it is reported here.',
      ]
        .filter(Boolean)
        .join(' ');
      if (guarded && guarded.removed > 0) {
        (report as any).summaryNote = `${guarded.removed} ${guarded.removed === 1 ? 'sentence' : 'sentences'} from the written summary ${guarded.removed === 1 ? 'was' : 'were'} removed because ${guarded.removed === 1 ? 'it' : 'they'} appeared to state a figure we could not verify. Only the figures in the first sentence are measured.`;
        console.warn(`[guard] removed ${guarded.removed} of ${guarded.total} summary sentences that stated a figure`);
      }

      // A report whose own figures contradict each other is a bug in this code, not a finding
      // about the client. It is never shown as done: the person gets a failed audit that says
      // so (not billable, not saved) and the violation is logged for the owner.
      // AUDIT_FORCE_INVARIANT_VIOLATION=1 is a test-only switch (like GEMINI_BASE_URL) that makes the
      // check report a violation, so the end-to-end test can prove the failure path. Unset everywhere real.
      const violations = process.env.AUDIT_FORCE_INVARIANT_VIOLATION === '1' ? ['forced by the test switch'] : assertReportInvariants(report);
      if (violations.length > 0) {
        console.error(`[invariant] report failed ${violations.length} consistency check(s): ${violations.join('; ')}`);
        const failedShape = generateSynthesizedAudit(businessName, cleanDomain, industry, coreOfferings, competitorList, queryList, engines);
        return {
          report: {
            ...failedShape,
            // The answers WERE collected: the cells must not claim a retrieval failure that did not happen.
            queriesTested: failedShape.queriesTested.map((q: any) => ({
              ...q,
              engines: Object.fromEntries(
                Object.entries(q.engines).map(([name, cell]: [string, any]) => [
                  name,
                  { ...cell, excerpt: `Answers were collected from ${name}, but this audit's figures failed a consistency check, so no result is shown.` },
                ])
              ),
            })),
            degraded: true,
            executiveSummary:
              'This audit finished collecting answers, but its figures failed an internal consistency check, so none of them are shown and nothing here is a measurement.',
            degradedReason:
              'This audit finished, but its figures failed an internal consistency check, so none of them are shown. Nothing was guessed. Please run the audit again; if it happens twice, tell the owner.',
          },
          degraded: true,
        };
      }

      return { report };
    } catch (err: any) {
      console.log(`Audit run failed: ${err?.message || err}`);
      const readableFailure = describeProviderError(err, 'The audit service');
      const fallback = generateSynthesizedAudit(
        req.body?.businessName || 'Business',
        normaliseDomain(req.body?.domain || ''),
        req.body?.industry,
        req.body?.coreOfferings,
        req.body?.competitors,
        req.body?.queries,
        configuredEngines()
      );
      fallback.executiveSummary = `Audit failed to complete: ${readableFailure.message} No findings were generated, so none of the figures are measurements.`;
      return {
        report: { ...fallback, degraded: true, degradedReason: readableFailure.message },
        degraded: true,
      };
    }
  }

  // ---- Audit jobs. State lives in the store (src/store.ts), not in process
  // memory, so a poll never depends on which request - or which process - began
  // the job, and a restart fails orphaned jobs honestly instead of losing them.

  /**
   * An audit still "running" after this long is stuck (a provider call that
   * never returned). Left alone it would hold a concurrency slot forever.
   */
  const JOB_MAX_RUN_MS = Number(process.env.JOB_MAX_RUN_MS || 15 * 60 * 1000);
  /** Job rows are kept this long: they are also the record the daily budget counts. */
  const JOB_RETENTION_MS = 7 * 24 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  /**
   * Audits share one answer-engine quota and one serialised Gemini queue
   * (scheduleGeminiCall), so running many at once does not make any of them
   * faster - it makes every one of them slower and spends the quota sooner.
   */
  const MAX_CONCURRENT_AUDITS = Number(process.env.MAX_CONCURRENT_AUDITS || 2);
  /** Rolling 24-hour budgets. 0 disables a budget. */
  const USER_AUDITS_PER_DAY = Number(process.env.USER_AUDITS_PER_DAY ?? 10);
  const GLOBAL_AUDITS_PER_DAY = Number(process.env.GLOBAL_AUDITS_PER_DAY ?? 100);

  /** A refusal to START an audit, with the status and wait the client should see. */
  class AdmissionError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly retryAfterSeconds?: number
    ) {
      super(message);
      this.name = 'AdmissionError';
    }
  }

  /**
   * Check-then-create must be atomic: two submits arriving together would both
   * pass the concurrency and budget checks. Admissions are serialised through
   * one promise chain (sufficient for one process; a shared database would need
   * a transaction instead - docs/MVP_AUDIT.md item 3).
   */
  let admissionChain: Promise<unknown> = Promise.resolve();
  function serialised<T>(fn: () => Promise<T>): Promise<T> {
    const next = admissionChain.then(fn, fn);
    admissionChain = next.catch(() => undefined);
    return next;
  }

  async function admit(budgetKey: string): Promise<void> {
    const running = await store.countRunning(JOB_MAX_RUN_MS);
    if (running >= MAX_CONCURRENT_AUDITS) {
      throw new AdmissionError(
        `This service is already running ${MAX_CONCURRENT_AUDITS} audits, which is as many as the shared answer-engine quota supports at once. Please try again in a minute or two.`,
        429,
        60
      );
    }
    const since = Date.now() - DAY_MS;
    const wait = (oldest: number | null) => Math.max(60, Math.ceil(((oldest ?? Date.now()) + DAY_MS - Date.now()) / 1000));

    if (USER_AUDITS_PER_DAY > 0 && (await store.countJobsSince(since, budgetKey)) >= USER_AUDITS_PER_DAY) {
      const retry = wait(await store.oldestJobSince(since, budgetKey));
      throw new AdmissionError(
        `You have used your ${USER_AUDITS_PER_DAY} audits for the last 24 hours (counted per access code). The next one frees up in about ${formatDuration(retry * 1000)}. Failed audits that collected no evidence are not counted.`,
        429,
        retry
      );
    }
    if (GLOBAL_AUDITS_PER_DAY > 0 && (await store.countJobsSince(since)) >= GLOBAL_AUDITS_PER_DAY) {
      const retry = wait(await store.oldestJobSince(since));
      throw new AdmissionError(
        `This service has reached its limit of ${GLOBAL_AUDITS_PER_DAY} audits for the last 24 hours, to protect the shared answer-engine budget. Please try again in about ${formatDuration(retry * 1000)}.`,
        429,
        retry
      );
    }
  }

  /** Run one audit to completion and record how it ended. Never throws. */
  async function runJob(jobId: string, owner: string, body: any) {
    const log = (what: string) => (err: any) =>
      console.error(`[job ${jobId}] ${what}: ${err?.message || err}`);
    try {
      const payload = await performAudit({ body }, (progress) => {
        void store.updateJob(jobId, { progress }).catch(log('progress update failed'));
      });

      // The reaper may already have marked this job failed after 15 minutes.
      // The evidence was still collected and paid for, so a late finish is
      // recorded rather than thrown away (only a pruned job is dropped).
      const current = await store.getJob(jobId);
      if (!current) return;

      const report = payload?.report;
      let saved = false;
      // A failed audit is shown to the person who ran it but not kept: it holds
      // no measurements, and a history of failures is noise, not a record.
      if (report && !report.degraded) {
        try {
          await store.saveAudit(owner, report);
          saved = store.info().durable;
        } catch (err) {
          log('could not save the audit')(err);
        }
      }
      await store.updateJob(jobId, {
        status: 'done',
        result: { ...payload, saved },
        finishedAt: Date.now(),
        // An audit that collected no evidence spent nothing; it must not use
        // up the person's daily allowance.
        billable: !!report && !report.degraded,
      });
    } catch (err: any) {
      console.log(`Audit job ${jobId} failed: ${err?.message || err}`);
      const latest = await store.getJob(jobId).catch(() => null);
      if (latest && latest.status !== 'running') return; // already ended (e.g. reaped); do not overwrite
      await store
        .updateJob(jobId, {
          status: 'error',
          error: describeProviderError(err, 'The audit service').message,
          finishedAt: Date.now(),
          billable: false,
        })
        .catch(log('could not record the failure'));
    }
  }

  app.post(
    '/api/audit/run',
    handle(async (req, res) => {
      const rawName = typeof req.body?.businessName === 'string' ? req.body.businessName.trim() : '';
      // (req.body can be undefined for an empty POST; every read below is optional-chained.)
      if (!rawName) {
        return res.status(400).json({ error: 'A business or brand name is required to run an audit.' });
      }
      if (rawName.length > MAX_NAME_LENGTH) {
        return res.status(400).json({
          error: `That business name is too long (${rawName.length} characters). Please shorten it to ${MAX_NAME_LENGTH} characters or fewer.`,
        });
      }

      // Normalise the shape once so the pipeline never sees ragged input.
      req.body.businessName = rawName;
      req.body.domain = cleanText(req.body?.domain, 200);
      req.body.industry = cleanText(req.body?.industry, 200);
      req.body.coreOfferings = cleanText(req.body?.coreOfferings, 300);
      req.body.targetAudience = cleanText(req.body?.targetAudience, 300);
      req.body.competitors = cleanCompetitors(req.body?.competitors);

      req.body.queries = (Array.isArray(req.body?.queries) ? req.body.queries : [])
        .filter((q: any) => q && typeof q.queryText === 'string' && q.queryText.trim().length > 0)
        .slice(0, MAX_AUDIT_QUERIES)
        .map((q: any, i: number) => ({
          id: typeof q.id === 'string' && q.id ? q.id.slice(0, 60) : `q-user-${i + 1}`,
          intent: typeof q.intent === 'string' ? q.intent.slice(0, 40) : 'feature_specific',
          queryText: q.queryText.trim().slice(0, MAX_QUERY_LENGTH),
          targetPersona: typeof q.targetPersona === 'string' ? q.targetPersona.slice(0, 80) : 'Target Customer',
        }));

      const owner: string = res.locals.user.owner;
      const budgetKey: string = res.locals.user.budgetKey;

      // The single most expensive thing to get wrong. A cold instance stalls
      // the submit long enough for the browser's own retry to fire, while the
      // server has already accepted the first one and started spending quota -
      // an aborted client request does not abort server work. Measured before
      // this guard: four attempts, four concurrent audits, 16 real Gemini
      // calls for one click. The key is per click and scoped to the owner, so
      // one user can never be handed another's job.
      const idemKey = readIdempotencyKey(req.headers as any);

      let outcome: { id: string; replayed: boolean };
      try {
        outcome = await serialised(async () => {
          await store.failStuck(JOB_MAX_RUN_MS, 'The audit took too long and was stopped. Please run it again.');
          await store.pruneJobs(Date.now() - JOB_RETENTION_MS);

          // A replayed submit (the same click, retried) is never refused by
          // the caps below and never starts a second audit.
          if (idemKey) {
            const existing = await store.findJobByKey(owner, idemKey);
            if (existing) return { id: existing.id, replayed: true };
          }

          await admit(budgetKey);

          const job: StoredJob = {
            id: `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            owner,
            budgetKey,
            idemKey,
            status: 'running',
            startedAt: Date.now(),
          };
          await store.createJob(job);
          // Kick the work off and answer immediately; the client polls for the result.
          void runJob(job.id, owner, req.body);
          return { id: job.id, replayed: false };
        });
      } catch (err) {
        if (err instanceof AdmissionError) {
          if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
          return res.status(err.status).json({ error: err.message });
        }
        throw err;
      }

      if (outcome.replayed) {
        console.log(`Audit submit replayed under an existing key; returning job ${outcome.id} instead of starting another.`);
      }
      // Report what the job is NOW: a replayed submit can name a job that has
      // already finished or failed (the client's next poll would say so anyway).
      const current = await store.getJob(outcome.id);
      res.status(202).json({ jobId: outcome.id, status: current?.status ?? 'running' });
    })
  );

  app.get(
    '/api/audit/job/:id',
    handle(async (req, res) => {
      await store.failStuck(JOB_MAX_RUN_MS, 'The audit took too long and was stopped. Please run it again.');
      const job = await store.getJob(req.params.id);
      // Someone else's job is reported exactly like a missing one.
      if (!job || job.owner !== res.locals.user.owner) {
        return res.status(404).json({
          error: 'That audit is no longer available. It may have expired or the server restarted; please run it again.',
        });
      }
      if (job.status === 'running') {
        return res.json({ status: 'running', elapsedMs: Date.now() - job.startedAt, progress: job.progress ?? null });
      }
      if (job.status === 'error') {
        return res.status(500).json({ status: 'error', error: job.error });
      }
      return res.json({ status: 'done', ...job.result });
    })
  );

  // ---- Saved audits: the history that survives a refresh (when storage is durable).
  app.get(
    '/api/audits',
    handle(async (_req, res) => {
      res.json({ audits: await store.listAudits(res.locals.user.owner), storage: store.info() });
    })
  );

  app.get(
    '/api/audits/:id',
    handle(async (req, res) => {
      const audit = await store.getAudit(res.locals.user.owner, req.params.id);
      if (!audit) return res.status(404).json({ error: 'That saved audit was not found. It may have been deleted.' });
      res.json({ audit });
    })
  );

  app.delete(
    '/api/audits/:id',
    handle(async (req, res) => {
      const deleted = await store.deleteAudit(res.locals.user.owner, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'That saved audit was not found. It may already be deleted.' });
      res.json({ deleted: true });
    })
  );

  // An unknown /api route is a JSON sentence, never an HTML error page - the
  // client parses every API response as JSON.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'That API route does not exist.' });
  });

  // Vite dev middleware or production static files - neither applies on
  // Vercel, which serves the built frontend from its own CDN and only ever
  // routes /api/* requests to this app (see api/[...path].ts). `vite` is
  // imported dynamically, only on this dev-only branch: it pulls in
  // esbuild/rollup (platform-native binaries), and a production Lambda has
  // no business loading a dev toolchain it will never call.
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    const distPath = path.join(process.cwd(), 'dist');
    // The backend bundle is built into dist/ next to the frontend, so serving
    // that directory as static files published it (and its source map) to
    // anyone who asked: GET /server.cjs returned 200 on every non-Vercel
    // deployment. vercel.json deletes the files on Vercel; this is the same
    // protection for everywhere else. Found by scripts/smoke.mjs.
    app.use((req, res, next) => {
      if (/^\/server\.cjs(\.map)?$/.test(req.path)) {
        return res.status(404).json({ error: 'Not found.' });
      }
      next();
    });
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Last: anything thrown by a route or by body parsing. Express' default
  // handler answers with an HTML page that includes a stack trace outside
  // production; every user-visible error here is a sentence (CLAUDE.md).
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That request was too large. Please shorten what you entered and try again.' });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'The request could not be read. Please reload the page and try again.' });
    }
    console.error('Unhandled server error:', err);
    return res.status(500).json({
      error: 'Something went wrong on the server. Please try again; if it keeps happening, the server logs have the detail.',
    });
  });

  return app;
}

async function startServer() {
  const app = await buildApp();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

/**
 * The report returned when an audit could not collect evidence.
 *
 * Every field that would be a *finding* is empty or null, because nothing was
 * found - nothing was measured. This used to ship a placeholder Schema.org
 * remediation task (with an invented `"price": "0"` offer), a made-up
 * "no indexed web entities" omission, an `accuracyRate` of 0, and every engine
 * marked `omitted` - which the matrix renders as "the engine left you out", a
 * finding about the client. The UI also withholds the numbers (see
 * `src/reportView.ts`), but the payload must not carry fabrications either:
 * the Export modal, "Copy Summary" and any API consumer read it directly.
 */
function generateSynthesizedAudit(
  businessName: string,
  domain: string = '',
  industry: string = '',
  coreOfferings: string = '',
  competitors: any = [],
  queries: any[] = [],
  engines: string[] = [],
  /** Evidence attempted per query (same order as `queries`), for the per-engine failure reason. */
  attempted: QueryEvidence[][] = []
) {
  const compList = (Array.isArray(competitors) ? competitors : [competitors]).filter(
    (c: any) => typeof c === 'string' && c.trim().length > 0
  );
  const queryList = queries.length > 0 ? queries : [];

  return {
    id: `audit-failed-${Date.now()}`,
    createdAt: new Date().toISOString(),
    businessName,
    domain,
    industry,
    coreOfferings,
    targetAudience: '',
    competitors: compList,
    // Zeros so the shape is stable; `degraded: true` (set by every caller) is
    // what tells the UI and any consumer that these are not measurements.
    geoVisibilityScore: 0,
    shareOfVoice: 0,
    leaderShare: 0,
    accuracyRate: null,
    executiveSummary: `This audit did not complete, so there are no findings about ${businessName}.`,
    queriesTested: queryList.map((q: any, idx: number) => ({
      ...q,
      // Only engines that were configured - and for those, "no data", never
      // "omitted", which would be a claim that the engine left the brand out.
      engines: Object.fromEntries(
        engines.map((engine) => {
          const reason = attempted[idx]?.find((ev) => ev.engine === engine)?.error;
          return [
            engine,
            {
              engine,
              status: 'retrieval_failed',
              position: null,
              excerpt: reason
                ? `No answer was captured from ${engine}: ${reason}`
                : `No answer was captured from ${engine}.`,
              citations: [],
            },
          ];
        })
      ),
    })),
    inaccuracies: [],
    omissions: [],
    remediationPlan: [],
    narrativeAvailable: false,
    // Only brands the user actually named. Inventing "Competitor A" would put a
    // fictional rival in a report about a real business.
    competitorBenchmarks: [
      {
        name: `${businessName} (Your Business)`,
        domain: domain,
        shareOfVoice: 0,
        topRecommendedCount: 0,
        mainCitationSources: [],
      },
      ...compList.map((c: string) => ({
        name: c,
        domain: '',
        shareOfVoice: 0,
        topRecommendedCount: 0,
        mainCitationSources: [],
      })),
    ],
    enginesRequested: engines,
    measuredEngines: [] as string[],
  };
}

// Vercel provides its own request/response lifecycle via api/[...path].ts,
// which imports buildApp directly - a long-running listener would never
// receive traffic there and would just hold the function open.
if (!process.env.VERCEL) {
  startServer();
}

export default buildApp;
