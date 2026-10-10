/**
 * In the real browser against the real server: what Auto-Detect hands the form,
 * and how a report with NO domain is presented.
 *  - A plain brand name never gets a guessed "<name>.com"; a model reply of
 *    "N/A" is not a domain; a found domain is normalised to a bare host.
 *  - After a reload (nothing explicitly selected) ticking a remediation task works,
 *    and the tab says it is not saved.
 *  - A report with a blank domain says the citation of "your own domain" was NOT
 *    MEASURED (it used to say "Your domain was never cited"), and no label prints
 *    an empty "()".
 * Needs a current dist/ and Chromium. Run: npx tsx test/lookupAndBlankDomainE2E.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_ACCESS_CODE, TEST_AUTH_ENV, rawFetch } from './authHelper';

let failures = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

const GEMINI_PORT = 7100 + Math.floor(Math.random() * 100);
const APP_PORT = 7300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${APP_PORT}`;
let mode: FakeMode = 'ok';

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-lookup-'));
  const app: ChildProcess = spawn('node', ['dist/server.cjs'], {
    env: {
      ...process.env, PORT: String(APP_PORT), NODE_ENV: 'production', DATA_DIR: dataDir, GEMINI_API_KEY: 'fake-key',
      GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`, GEMINI_MIN_INTERVAL_MS: '0', RATE_LIMIT_PER_MIN: '0',
      HTTP_PROXY: '', HTTPS_PROXY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '', ANTHROPIC_API_KEY: '', ...TEST_AUTH_ENV,
    },
    stdio: 'ignore',
  });
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await rawFetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const login = await rawFetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tester@example.com', accessCode: TEST_ACCESS_CODE }) });
    const token = (await login.json()).token;
    const lookup = async (input: string) => (await (await rawFetch(`${BASE}/api/audit/parse-url`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': Math.random().toString(36) }, body: JSON.stringify({ input }) })).json());

    // ---- the lookup's domain
    mode = 'lookup_placeholder';
    const na = await lookup('Acme Widgets');
    assert('a model reply of "N/A" is not accepted as a domain', na.detected === true && na.details.domain === '', JSON.stringify(na.details));
    const keptTyped = await lookup('https://acme.com');
    assert('a domain the person typed is kept when the lookup answers "N/A" for it', keptTyped.details.domain === 'acme.com', JSON.stringify(keptTyped.details));
    mode = 'lookup_good';
    const good = await lookup('Acme Widgets');
    assert('a found domain is reduced to a bare host (no scheme, www, path or case)', good.details.domain === 'acme-widgets.com', JSON.stringify(good.details));
    mode = 'ok';
    const typed = await lookup('https://www.Acme.com/menu');
    assert('a domain the person typed as a URL is kept (bare host)', typed.details.domain === 'acme.com', JSON.stringify(typed.details));

    // ---- the UI
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE);
    await page.fill('#auth-email-input', 'tester@example.com');
    await page.fill('#auth-code-input', TEST_ACCESS_CODE);
    await page.click('button[type=submit]');
    await page.waitForSelector('#business-name-input');
    mode = 'narrative_remediation';
    await page.fill('#business-name-input', 'Poke House');
    await page.fill('#domain-input', 'poke.house');
    await page.click('button:has-text("Run Live GEO Search Audit")');
    await page.waitForSelector('text=Share of Voice', { timeout: 60000 });

    await page.reload();
    await page.waitForSelector('text=Saved to your account');
    await page.locator('aside').getByText('Prioritized Remediation Plan', { exact: false }).first().click();
    await page.waitForSelector('text=0 / 1 Tasks Fixed');
    assert('the remediation tab says ticks are not saved', /lost on reload/.test(await page.locator('main').innerText()));
    await page.locator('button[title="Mark as Fixed"]').first().click();
    assert('after a reload (nothing selected) ticking a task works', await page.waitForSelector('text=1 / 1 Tasks Fixed', { timeout: 5000 }).then(() => true).catch(() => false));

    // ---- a report with no domain
    await page.locator('header >> text=GEO Audit Studio').first().click();
    await page.waitForSelector('#business-name-input');
    mode = 'ok';
    await page.fill('#business-name-input', 'Nameless Co');
    await page.click('button:has-text("Run Live GEO Search Audit")');
    await page.waitForSelector('text=Share of Voice', { timeout: 60000 });
    await page.locator('aside').getByText('Citation Source Map', { exact: false }).first().click();
    await page.waitForTimeout(300);
    const cites = await page.locator('main').innerText();
    assert('a blank domain says own-domain citation was NOT MEASURED', /not measured, no domain was given/.test(cites), cites.slice(0, 500));
    assert('...and does not claim "Your domain was never cited"', !/Your domain was never cited/.test(cites));
    const options = await page.locator('#audit-selector option').allInnerTexts();
    assert('no audit label prints an empty "()"', !options.some((o) => /\(\)/.test(o)), JSON.stringify(options));
    assert('...the nameless audit is labelled by its name alone', options.some((o) => /^Nameless Co — GEO Score/.test(o.trim())), JSON.stringify(options));
    await page.click('#export-report-btn');
    const exp = await page.locator('.fixed').innerText();
    assert('the export header does not start with an orphan bullet when the domain is blank', !/Nameless Co\s*\n\s*•/.test(exp), exp.slice(0, 300));
  } finally {
    await browser.close();
    app.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nLookup and blank-domain checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
