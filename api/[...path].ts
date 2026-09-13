import buildApp from '../server';

/**
 * Vercel serverless entry point. Every request under /api/* lands here
 * (file-system catch-all routing - see TECH_DEBT.md 1.4a for why this
 * exists at all: Vercel's zero-config Vite detection built only the
 * static frontend and never ran server.ts).
 *
 * `app` is built once per warm Lambda instance and reused across
 * invocations, exactly like the long-running process on Render reuses it
 * across requests - the only difference is who owns the socket.
 */
let appPromise: ReturnType<typeof buildApp> | null = null;

export default async function handler(req: any, res: any) {
  if (!appPromise) {
    appPromise = buildApp();
  }
  const app = await appPromise;
  return (app as unknown as (req: any, res: any) => void)(req, res);
}
