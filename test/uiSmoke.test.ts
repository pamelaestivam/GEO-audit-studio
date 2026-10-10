/**
 * Drives the real built app in a real browser (Chromium via Playwright) against
 * the real built server and a fake Gemini at the far end - the way a person
 * uses it. Until this existed, every UI defect in docs/MVP_AUDIT.md (B4, B5)
 * was found by eye; CLAUDE.md records "no UI test layer" as a known gap.
 *
 * The answers come from a fixed fake engine (test/fakeGemini.ts), so what this
 * proves is the product's behaviour - sign-in, what is shown, what survives a
 * reload, what is withheld on failure - not the quality of any real engine.
 *
 * Needs a current dist/ and a Chromium (npx playwright install chromium).
 * Run: npx tsx test/uiSmoke.test.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';
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

const GEMINI_PORT = 5600 + Math.floor(Math.random() * 100);
const APP_PORT = 5800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${APP_PORT}`;
let mode: FakeMode = 'ok';

async function waitForServer(): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      if ((await rawFetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** True if `selector` shows up within the timeout. Lets a missing element be a failed check, not a crash. */
async function appears(page: Page, selector: string, timeout = 20000): Promise<boolean> {
  return page
    .waitForSelector(selector, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function signIn(page: Page, email = 'tester@example.com', code = TEST_ACCESS_CODE) {
  await page.goto(BASE);
  await page.fill('#auth-email-input', email);
  await page.fill('#auth-code-input', code);
  await page.click('button[type=submit]');
}

async function runAudit(page: Page, name = 'Poke House', domain = 'poke.house') {
  await page.fill('#business-name-input', name);
  await page.fill('#domain-input', domain);
  await page.click('button:has-text("Run Live GEO Search Audit")');
  await page.waitForSelector('text=Share of Voice', { timeout: 60000 });
}

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-ui-'));
  let app: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    app = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: 'production',
        DATA_DIR: dataDir,
        GEMINI_API_KEY: 'fake-key',
        GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MIN_INTERVAL_MS: '0',
        RATE_LIMIT_PER_MIN: '0',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        OPENAI_API_KEY: '',
        PERPLEXITY_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        // The model-stamp checks below need the default whatever the shell has set.
        GEMINI_MODEL: '',
        ...TEST_AUTH_ENV,
      },
      stdio: 'ignore',
    });
    assert('the app server starts', await waitForServer());

    browser = await chromium.launch();

    // =====================================================================
    // Desktop
    // =====================================================================
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    // --- sign-in is real
    await page.goto(BASE);
    assert('a visitor lands on sign-in, not the dashboard', (await page.locator('#auth-email-input').count()) === 1);
    assert('there is no demo / one-click bypass', (await page.locator('text=Quick Demo').count()) === 0);

    // --- the deployment notices come from the server's own status, never hardcoded
    assert('a deployment with durable storage shows no temporary-storage notice', (await page.locator('[data-testid=storage-notice]').count()) === 0);
    const tempPage = await ctx.newPage();
    await tempPage.route('**/api/audit/status', (route) =>
      route.fulfill({
        json: { quota: { available: true, reason: null, resetAt: null, msRemaining: 0 }, engines: ['Gemini'], storage: { kind: 'memory', durable: false }, auth: { mode: 'configured' } },
      })
    );
    await tempPage.goto(BASE);
    assert('when the server reports temporary storage, the sign-in page says so', await appears(tempPage, '[data-testid=storage-notice]'));
    assert('...and tells the person what to do', /Export your report/.test(await tempPage.locator('[data-testid=storage-notice]').innerText()));
    await tempPage.close();

    await signIn(page, 'tester@example.com', 'definitely-wrong-code');
    await page.waitForSelector('[role=alert]');
    assert('a wrong access code shows the server\'s sentence', /access code is not valid/i.test(await page.locator('[role=alert]').innerText()));
    assert('...and stays on sign-in', (await page.locator('#business-name-input').count()) === 0);

    await page.fill('#auth-code-input', TEST_ACCESS_CODE);
    await page.click('button[type=submit]');
    assert('the right code reaches the dashboard', await appears(page, '#business-name-input'));
    assert('the sidebar shows who is signed in', /tester/i.test(await page.locator('aside').innerText()));

    // --- an audit
    const firstClickLabel = await page.locator('button:has-text("Run Live GEO Search Audit")').innerText();
    assert('the run button names what it does', /Run Live GEO Search Audit/.test(firstClickLabel));
    await runAudit(page);
    const card = await page.locator('main').innerText();
    assert('visibility is shown with its arithmetic', /Named in 2 of 2 answers \(Gemini\)/.test(card), card.slice(0, 400));
    assert('a small sample carries a caution', /indicative, not a stable rate/.test(card));
    assert('the score carries its rough 95% range, so 2 of 2 does not read as certainty', /Rough 95% range from this sample: 34%-100%/.test(card), card.slice(0, 600));
    await page.click('summary:has-text("How this was measured")');
    const how = await page.locator('details').first().innerText();
    assert('the disclosure says it is the developer API, once, not the consumer apps', /not what people see in the ChatGPT, Gemini, Claude or Perplexity apps/.test(how) && /once/.test(how), how);
    assert('...states what the range is and is not', /plausibly lie between 34%-100%/.test(how) && /not fully independent/.test(how), how);
    assert('...names the model requested and when the answers were captured', /Models requested: Gemini \(gemini-3\.6-flash\)/.test(how) && /Answers captured .* GMT/.test(how), how);
    await page.click('summary:has-text("How this was measured")'); // close it again so later steps see only their own <details>
    const ringClass = (await page.locator('main .border-4').first().getAttribute('class')) || '';
    assert('a 2-answer score has a neutral ring, no colour verdict', /text-slate-400/.test(ringClass) && !/emerald|amber|rose/.test(ringClass), ringClass);
    const optionNow = (await page.locator('#audit-selector option').allInnerTexts())[0];
    assert('the audit dropdown entry never shows the bare number', /GEO Score: 100% \(2 answers\)/.test(optionNow), optionNow);
    assert('the header badge and the sidebar never show the bare number', /GEO Score: 100% \(2 answers\)/.test(await page.locator('#header-geo-score-badge').innerText()) && /GEO 100% \(2 answers\)/.test(await page.locator('aside').innerText()));
    assert('when every query names the brand, the card says the score mostly reflects reputation, not discovery', /All 2 questions name your brand/.test(card), card.slice(0, 500));
    assert('share of voice is 33%', /33%/.test(card));
    const rivals = await page.locator('text=Rivals the engines named that you did not list').locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]').innerText();
    assert('only the real rivals are listed', /Pokeworks/.test(rivals) && /Sweetfin/.test(rivals) && !/Pricing|Key|Monday|Yelp|Austin/.test(rivals), rivals);
    assert('the audit says it was saved', /Saved to your account/.test(card));
    const matrix = await page.locator('main').innerText();
    assert('the default queries are well-formed questions (no blanks where a competitor should be)', /What are the best alternatives to Poke House\?/.test(matrix) && !/\bto\s{2,}for\b|\bvs\s{2,}/.test(matrix) && !/software/i.test(matrix.split('Search Query')[1] || ''), matrix.slice(matrix.indexOf('Search Query'), matrix.indexOf('Search Query') + 400));
    assert('nothing claims continuous monitoring is active', (await page.locator('aside').innerText()).indexOf('Active') === -1 || !/Continuous Sweeps\s*Active/.test(await page.locator('aside').innerText()));

    // --- every module opens and shows something
    for (const [label, expect] of [
      ['Query Intent Matrix', /Manual Search Query Entry/],
      ['Citation Source Map', /yelp\.com/i],
      ['Inaccuracies & Hallucinations', /No inaccuracies flagged/],
      ['Omission Analysis', /No omission diagnoses|Omission/],
      ['Prioritized Remediation Plan', /No remediation tasks|Remediation/],
      ['Competitor Intelligence', /Pokeworks/],
      ['Continuous Sweeps', /Preview|not yet active|not active/i],
    ] as const) {
      await page.locator('aside').getByText(label, { exact: false }).first().click();
      await page.waitForTimeout(250);
      const txt = await page.locator('main').innerText();
      assert(`the "${label}" module renders its content`, expect.test(txt), txt.slice(0, 200));
    }

    // --- the evidence behind the numbers can be read
    await page.locator('aside').getByText('Query Intent Matrix', { exact: false }).first().click();
    await page.locator('tbody tr').first().click();
    assert('a query row opens its detail', await appears(page, 'text=Captured AI Engine Responses'));
    await page.click('summary:has-text("Show the full answer as captured")');
    const evidenceText = await page.locator('details[open]').innerText();
    assert('the full verbatim answer is shown', /Pokeworks/.test(evidenceText) && /consistently rated highest/.test(evidenceText), evidenceText.slice(0, 200));
    assert('...with the searches the engine ran', /Gemini searched for/.test(evidenceText) && /poke austin/.test(evidenceText));
    await page.locator('.fixed button:has-text("✕")').click();

    // --- summary tiles are real buttons that go somewhere
    await page.locator('aside').getByText('Query Intent Matrix', { exact: false }).first().click();
    await page.locator('button:has-text("Fact Accuracy Rate")').click();
    await page.waitForTimeout(250);
    assert('tapping the accuracy tile opens the inaccuracies module', /No inaccuracies flagged/.test(await page.locator('main').innerText()));

    // --- add a query to the audit
    await page.locator('aside').getByText('Query Intent Matrix', { exact: false }).first().click();
    await page.fill('input[placeholder^="Type extra target search query"]', 'poke bowl delivery near me');
    await page.click('button:has-text("Add & Audit Query")');
    assert('an added query appears in the matrix', await appears(page, 'text=poke bowl delivery near me', 30000));
    assert('...and the card says it is not in the headline figures', /1 query was added after this audit ran/.test(await page.locator('main').innerText()));

    // --- the Run Audit modal says what its queries are
    await page.click('#run-new-audit-btn');
    await page.fill('.fixed input[placeholder^="e.g. Acme SaaS"]', 'Acme Bowls');
    await page.click('.fixed button:has-text("Generate Viewer-Intent Queries")');
    assert('the modal reaches the query step', await appears(page, '.fixed >> text=Target Queries', 30000));
    const modalText = await page.locator('.fixed').innerText();
    assert('standard queries are not described as written by the model', /the model did not write these/.test(modalText) && !/AI-suggested/.test(modalText), modalText.slice(0, 300));
    assert('...and are well-formed', /What are the best alternatives to Acme Bowls\?/.test(modalText));
    await page.locator('.fixed button:has-text("✕")').click();

    // --- export
    await page.click('#export-report-btn');
    assert('the export modal opens', await appears(page, 'text=Executive Audit Report Export'));
    const exportText = await page.locator('.fixed').innerText();
    assert('the export carries the same basis as the card', /Named in 2 of 2 answers/.test(exportText));
    assert('the export (and so the printed PDF) shows the range, the model and when the answers were captured beside the score', /Rough 95% range: 34%-100%/.test(exportText) && /Models requested: Gemini \(gemini-3\.6-flash\)/.test(exportText) && /Answers captured .* GMT/.test(exportText), exportText.slice(0, 700));
    assert('...and says it is not the consumer app', /not what people see/.test(exportText));
    await page.locator('.fixed button:has-text("✕")').click();

    // --- reload: the session and the saved audit survive
    await page.reload();
    assert('a reload keeps the user signed in', await appears(page, '#audit-selector'));
    assert('the saved audit is restored after a reload', await appears(page, 'text=Saved to your account'));
    const reloaded = await page.locator('main').innerText();
    const optionAfterReload = (await page.locator('#audit-selector option').allInnerTexts())[0];
    assert('after a reload the dropdown (built from the saved summary) still carries what the score rests on', /GEO Score: 100% \(2 answers\)/.test(optionAfterReload), optionAfterReload);
    assert('the saved audit comes back after a reload, in full', /Named in 2 of 2 answers/.test(reloaded) && /33%/.test(reloaded), reloaded.slice(0, 300));

    // --- after a reload nothing is explicitly selected; adding a query must still work
    await page.locator('aside').getByText('Query Intent Matrix', { exact: false }).first().click();
    await page.fill('input[placeholder^="Type extra target search query"]', 'poke bowl catering');
    await page.click('button:has-text("Add & Audit Query")');
    assert('after a reload an added query still appears (it used to vanish silently)', await appears(page, 'text=poke bowl catering', 30000));
    assert('...and the card says added queries are not kept', /lost on reload/.test(await page.locator('main').innerText()));

    // --- Fresh search really leaves the audit
    await page.locator('header >> text=GEO Audit Studio').first().click();
    assert('"fresh search" returns to the search form even when audits exist', await appears(page, '#business-name-input', 5000));

    // --- failure is shown as failure
    mode = 'unauthorized';
    await runAudit(page, 'Failing Co', 'failing.example');
    const failedCard = await page.locator('main').innerText();
    assert('a failed audit says the figures are not measurements', /Audit incomplete/.test(failedCard) && /not measurements/.test(failedCard));
    assert('...and says why in a sentence', /rejected the API key/.test(failedCard));
    assert('...with no fabricated percentages', !/\b0%/.test(failedCard.split('EXECUTIVE SUMMARY')[0]), failedCard.slice(0, 500));
    assert('...and it is not claimed to be saved', !/Saved to your account/.test(failedCard));
    mode = 'ok';

    // --- history holds only the real audit; delete removes it for good
    const optionTexts = await page.locator('#audit-selector option').allInnerTexts();
    assert('the failed audit is shown now but is not what was saved', optionTexts.some((o) => /Failing Co/.test(o)) && optionTexts.some((o) => /Poke House/.test(o)), JSON.stringify(optionTexts));
    const savedValue = await page.locator('#audit-selector option', { hasText: 'Poke House' }).first().getAttribute('value');
    await page.locator('#audit-selector').selectOption(savedValue!);
    assert('a saved audit offers delete', await appears(page, 'button:has-text("Delete this audit")', 15000));
    page.once('dialog', (d) => d.accept());
    await page.click('button:has-text("Delete this audit")');
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('#audit-selector option')).some((o) => /Poke House/.test((o as HTMLElement).innerText)), null, { timeout: 15000 }).catch(() => {});
    const token = JSON.parse((await page.evaluate(() => localStorage.getItem('geo_session_v2')))!).token;
    const afterDelete = await (await rawFetch(`${BASE}/api/audits`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert('the server no longer has the deleted audit', afterDelete.audits.length === 0, JSON.stringify(afterDelete.audits));

    // --- sign out
    await page.locator('button:has-text("Sign Out")').click();
    assert('sign out returns to sign-in', await appears(page, '#auth-email-input'));
    const stored = await page.evaluate(() => localStorage.getItem('geo_session_v2'));
    assert('...and clears the stored session', stored === null);

    // --- an expired / invalid stored session is refused with a reason
    await signIn(page);
    assert('signing in again works', await appears(page, '#business-name-input'));
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('geo_session_v2')!);
      s.token = s.token.slice(0, -4) + 'AAAA';
      localStorage.setItem('geo_session_v2', JSON.stringify(s));
    });
    await page.reload();
    assert('a tampered session sends the user back to sign-in with a reason', await appears(page, 'text=Your session is not valid'));
    assert('...on the sign-in page', (await page.locator('#auth-email-input').count()) === 1);

    // --- the legacy fake session is not honoured
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('geo_radar_user_session', JSON.stringify({ id: 'usr-demo-101', name: 'Sarah Jenkins', email: 'x@y.com' }));
    });
    await page.reload();
    assert('the old placeholder session no longer signs anyone in', await appears(page, '#auth-email-input'));
    assert('...and is removed from storage', (await page.evaluate(() => localStorage.getItem('geo_radar_user_session'))) === null);

    assert('no uncaught page errors occurred on desktop', consoleErrors.length === 0, consoleErrors.join(' | '));
    // --- no engine configured: the run button is disabled and the reason is on screen
    const noEnginePage = await ctx.newPage();
    await noEnginePage.route('**/api/audit/status', (route) =>
      route.fulfill({
        json: { quota: { available: true, reason: null, resetAt: null, msRemaining: 0 }, engines: [], storage: { kind: 'sqlite', durable: true }, auth: { mode: 'configured' } },
      })
    );
    await noEnginePage.goto(BASE);
    await noEnginePage.waitForSelector('#run-new-audit-btn');
    await noEnginePage.click('#run-new-audit-btn');
    assert('with no engine configured the modal says nothing can be measured', await appears(noEnginePage, '[data-testid=no-engine-notice]'));
    assert('...and the button that would start an audit is disabled, not a dead click', await noEnginePage.locator('.fixed button:has-text("Generate Viewer-Intent Queries")').isDisabled());
    assert('...and the durable-storage notice is absent (storage is fine here)', (await noEnginePage.locator('[data-testid=storage-notice]').count()) === 0);
    await noEnginePage.close();

    await ctx.close();

    // =====================================================================
    // Phone
    // =====================================================================
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const m = await phone.newPage();
    const phoneErrors: string[] = [];
    m.on('pageerror', (e) => phoneErrors.push(String(e)));
    await signIn(m, 'phone@example.com');
    assert('phone sign-in works', await appears(m, '#business-name-input'));
    const formTop = await m.evaluate(() => document.querySelector('#business-name-input')!.getBoundingClientRect().top);
    assert('on a phone the audit form is on the first screen, not buried under navigation', formTop > 0 && formTop < 600, `form top at ${formTop}px`);
    assert('before any audit there are no inert module tabs to tap', (await m.locator('aside nav').count()) === 0);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert('the dashboard does not scroll sideways on a phone', overflow <= 1, `overflow ${overflow}px`);
    // A returning user with a long brand name: the audit dropdown used to size
    // itself to its longest option and push the page ~400px sideways.
    await runAudit(m, 'Northwind Traders International Holdings', 'northwind-traders-international.example.com');
    await m.reload();
    assert('the returning phone user sees their saved audit', await appears(m, 'text=Saved to your account'));
    for (const tab of ['Query Intent Matrix', 'Citation Source Map', 'Competitor Intelligence']) {
      await m.locator('aside').getByText(tab, { exact: false }).first().tap();
      await m.waitForTimeout(300);
      const over = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(`the "${tab}" view does not scroll sideways on a phone (returning user, long name)`, over <= 1, `overflow ${over}px`);
    }
    await m.evaluate(() => window.scrollTo(0, 0));
    await m.locator('aside').getByText('Citation Source Map', { exact: false }).first().tap();
    await m.waitForTimeout(900);
    const inView = await m.evaluate(() => {
      const el = Array.from(document.querySelectorAll('main *')).find((n) => /yelp\.com/i.test((n as HTMLElement).innerText || '') && (n as HTMLElement).children.length === 0) as HTMLElement | undefined;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight;
    });
    assert('tapping a module on a phone brings its content into view', inView === true, `inView=${inView}`);
    assert('no uncaught page errors occurred on the phone', phoneErrors.length === 0, phoneErrors.join(' | '));
    await phone.close();
  } finally {
    await browser?.close();
    app?.kill('SIGKILL');
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll UI smoke checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UI smoke harness error:', err?.message || err);
  process.exit(1);
});
