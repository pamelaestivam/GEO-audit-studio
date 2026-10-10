#!/usr/bin/env node
/**
 * Post-deploy smoke test: does a DEPLOYED instance actually work?
 *
 *   node scripts/smoke.mjs https://your-app.example.com
 *   node scripts/smoke.mjs https://your-app.example.com --email you@example.com --code YOUR_ACCESS_CODE
 *   node scripts/smoke.mjs https://your-app.example.com --warn-non-durable   (report memory-only storage as a warning)
 *
 * Without credentials it checks everything a stranger can see, including that
 * protected routes REFUSE a stranger. With credentials it signs in and also
 * checks the deep readiness endpoint (one real Gemini call - it spends a
 * request of quota, cached for 5 minutes server-side).
 *
 * Why this exists: every past deploy incident (API 404s, a crash on a missing
 * import extension, nested routes 404ing at the platform edge) passed
 * `npm test` and was found by the owner in production. These checks hit the
 * real deployed URL, so they would have caught each one first.
 *
 * Exit code 0 only if every check passed. Prints one line per check.
 */

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = flag('email');
// A known, documented limit of a deployment (for example the preview's non-durable storage) can be
// reported as a warning instead of a failure. It is still printed on every run, never hidden.
const warnNonDurable = args.includes('--warn-non-durable');
const code = flag('code');

if (!base) {
  console.error('Usage: node scripts/smoke.mjs <https://base-url> [--email you@example.com --code ACCESS_CODE]');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

async function get(path, init) {
  // A hung site must fail the check, not hang it: every request is bounded.
  const res = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

try {
  // --- the frontend is served
  const home = await get('/');
  check('the frontend is served at /', home.status === 200 && /<div id="root"/.test(home.text), `status ${home.status}`);
  check('the compiled backend bundle is NOT publicly downloadable', (await get('/server.cjs')).status !== 200 || !/express/.test((await get('/server.cjs')).text));

  // --- the API answers, at every depth (the Vercel catch-all only matched one segment)
  const health = await get('/api/health');
  check('GET /api/health is 200 JSON', health.status === 200 && health.json?.status === 'ok', `status ${health.status}: ${health.text.slice(0, 120)}`);
  const status = await get('/api/audit/status');
  check('GET /api/audit/status (a nested path) is 200 JSON', status.status === 200 && !!status.json?.engines, `status ${status.status}: ${status.text.slice(0, 120)}`);
  const unknown = await get('/api/definitely/not/a/route');
  check('an unknown nested API route is a JSON 404, not an HTML platform page', unknown.status === 404 && typeof unknown.json?.error === 'string', `status ${unknown.status}: ${unknown.text.slice(0, 80)}`);

  // --- what the deployment says about itself
  check('at least one answer engine is configured', (status.json?.engines || []).length > 0, 'No engine key is set, so no audit can measure anything.');
  check('sign-in is configured', status.json?.auth?.mode === 'configured', status.json?.auth?.problem || `mode: ${status.json?.auth?.mode}`);
  const durable = status.json?.storage?.durable === true;
  if (!durable && warnNonDurable) {
    console.log(`warn  storage is NOT durable (known limit of this deployment, see docs/PROGRAM.md): ${status.json?.storage?.note || 'audits are kept in memory only'}`);
  } else {
    check('storage is durable (audits survive a restart)', durable, status.json?.storage?.note || 'Audits are kept in memory only.');
  }

  // --- strangers are refused
  const noToken = await get('/api/audit/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessName: 'Smoke Test' }) });
  check('POST /api/audit/run without a session is refused (401)', noToken.status === 401 || noToken.status === 503, `status ${noToken.status} - an open endpoint spends quota for anyone`);
  const noList = await get('/api/audits');
  check('GET /api/audits without a session is refused', noList.status === 401 || noList.status === 503, `status ${noList.status}`);
  const badLogin = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'smoke@example.com', accessCode: 'definitely-not-a-real-code' }) });
  check('a wrong access code is refused', badLogin.status === 401 || badLogin.status === 503, `status ${badLogin.status}`);
  check('the old placeholder token is not accepted', (await get('/api/audits', { headers: { Authorization: `Bearer token-${Date.now()}` } })).status !== 200);

  // --- signed in
  if (email && code) {
    const login = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, accessCode: code }) });
    check('signing in with the supplied credentials works', login.status === 200 && !!login.json?.token, `status ${login.status}: ${login.json?.error || login.text.slice(0, 100)}`);
    if (login.json?.token) {
      const auth = { Authorization: `Bearer ${login.json.token}` };
      const me = await get('/api/auth/me', { headers: auth });
      check('the session is accepted', me.status === 200, `status ${me.status}`);
      const list = await get('/api/audits', { headers: auth });
      check('saved audits can be listed', list.status === 200 && Array.isArray(list.json?.audits), `status ${list.status}`);
      const ready = await get('/api/audit/readiness', { headers: auth });
      check('deep readiness answers', ready.status === 200 && Array.isArray(ready.json?.checks), `status ${ready.status}: ${ready.text.slice(0, 120)}`);
      for (const c of ready.json?.checks || []) check(`readiness: ${c.name}${c.verified ? '' : ' (not verified by a live call)'}`, c.ok, c.detail);
    }
  } else {
    console.log('skip  signed-in checks (pass --email and --code to include them, and the live Gemini readiness call)');
  }
} catch (err) {
  failures++;
  console.log(`FAIL  could not reach ${base}: ${err?.message || err}`);
}

console.log(failures === 0 ? '\nSmoke test passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
