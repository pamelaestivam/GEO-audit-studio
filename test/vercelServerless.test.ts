/**
 * Proof that the Vercel serverless entry point (api/[...path].ts) actually
 * answers requests, and that the ordinary Render/local path is unchanged.
 *
 * The live deploy at the time this was written served only the static
 * frontend - every /api/* route returned Vercel's own 404, because nothing
 * told Vercel to run server.ts at all. This test exercises the real
 * `handler` export the same way Vercel's Node runtime would call it (as a
 * plain (req, res) listener on a real http.Server), and separately proves
 * server.ts's own long-running path (buildApp + app.listen, used by
 * `npm start` / Render) still serves its static catch-all when VERCEL is
 * not set - so the branch this change added doesn't regress the other one.
 *
 * Run with: npx tsx test/vercelServerless.test.ts (needs a current `dist/`,
 * since the non-Vercel path serves dist/index.html for real).
 */

import http from 'http';

let failures = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

function listenOnEphemeralPort(requestListener: (req: any, res: any) => void): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(requestListener);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  // Both Render and Vercel run with NODE_ENV=production in real deploys -
  // set it here too, or this test would exercise the Vite dev-middleware
  // branch instead of the two branches actually in production.
  process.env.NODE_ENV = 'production';

  // Must be set before server.ts is imported: its top-level `if
  // (!process.env.VERCEL) startServer()` guard reads this at import time,
  // and if it were unset here the import would bind a real app.listen()
  // as a side effect - exactly what a real Vercel function must never do.
  process.env.VERCEL = '1';

  const { default: handler } = await import('../api/[...path]');
  const { default: buildApp } = await import('../server');

  // ---- simulated Vercel invocation: the real handler, on a real socket
  const vercel = await listenOnEphemeralPort((req, res) => handler(req, res));
  try {
    const health = await fetch(`${vercel.base}/api/health`);
    assert('the Vercel entry point answers /api/health', health.status === 200, `status ${health.status}`);
    const healthBody = await health.json();
    assert('the health response is the real payload, not a 404 shell', healthBody.status === 'ok', JSON.stringify(healthBody));

    const status = await fetch(`${vercel.base}/api/audit/status`);
    assert('the Vercel entry point answers /api/audit/status', status.status === 200, `status ${status.status}`);

    // A request Vercel's own file-system routing would never send here in
    // production (only /api/* reaches this function) should not be silently
    // swallowed into serving index.html - that would hide real 404s during
    // local testing of this exact file.
    const root = await fetch(`${vercel.base}/`, { redirect: 'manual' });
    assert(
      'a non-API path is not swallowed into a fake 200/index.html by the serverless entry point',
      root.status === 404,
      `status ${root.status}`
    );
  } finally {
    vercel.server.close();
  }

  // ---- the ordinary long-running path (Render / `npm start`), unchanged
  delete process.env.VERCEL;
  const renderApp = await buildApp();
  const render = await listenOnEphemeralPort(renderApp as any);
  try {
    const health = await fetch(`${render.base}/api/health`);
    assert('the non-Vercel path still answers /api/health', health.status === 200, `status ${health.status}`);

    const root = await fetch(`${render.base}/`);
    assert('the non-Vercel path still serves the built frontend at /', root.status === 200, `status ${root.status}`);
    const rootBody = await root.text();
    assert('the served page is the real built index.html, not an empty/placeholder body', rootBody.includes('<div id="root">'), rootBody.slice(0, 120));
  } finally {
    render.server.close();
  }

  console.log(failures === 0 ? '\nAll Vercel serverless checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E test harness error:', err);
  process.exit(1);
});
