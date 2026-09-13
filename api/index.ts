// Node's native ESM loader (not a bundler) resolves this at runtime on
// Vercel - it requires the real output extension, even though the source
// file is server.ts. Omitting it is exactly what produced
// "Cannot find module '/var/task/server'" (ERR_MODULE_NOT_FOUND) in
// production. See TECH_DEBT.md 1.4a.
import buildApp from '../server.js';

/**
 * Vercel serverless entry point. Every request under /api/* is routed
 * here by an explicit rewrite in vercel.json (`/api/:path* -> /api`) -
 * see TECH_DEBT.md 1.4a for why this exists at all (Vercel's zero-config
 * Vite detection built only the static frontend and never ran server.ts)
 * and 1.4b for why this is an explicit rewrite rather than a
 * `[...path].ts` catch-all filename: the catch-all only matched
 * single-segment paths in production (`/api/health` worked,
 * `/api/audit/status` 404'd at Vercel's own routing layer, confirmed by
 * curling a matrix of real paths), for reasons this session could not
 * fully diagnose without deeper platform access. An explicit rewrite is
 * unambiguous regardless of that behavior.
 *
 * `app` is built once per warm Lambda instance and reused across
 * invocations, exactly like the long-running process on Render reuses it
 * across requests - the only difference is who owns the socket.
 */
let appPromise: ReturnType<typeof buildApp> | null = null;

export default async function handler(req: any, res: any) {
  try {
    if (!appPromise) {
      appPromise = buildApp();
    }
    const app = await appPromise;
    return (app as unknown as (req: any, res: any) => void)(req, res);
  } catch (err) {
    // A crash here previously surfaced as Vercel's own opaque
    // FUNCTION_INVOCATION_FAILED page - the exact "unreadable failure"
    // CLAUDE.md treats as a bug, just one layer below this app's own
    // error handling. Reset the memoized promise so a transient failure
    // (e.g. a cold-start race) doesn't wedge every future invocation on
    // this warm instance into repeating the same rejected promise.
    appPromise = null;
    const message = err instanceof Error ? err.message : String(err);
    console.error('Vercel function failed to build/serve the app:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The server failed to start.', detail: message }));
  }
}
