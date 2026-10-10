/**
 * In a real browser: when the analysis reports inaccuracy claims that cannot be
 * tied to a captured answer, the Inaccuracies tab must not show the green "No
 * inaccuracies flagged" panel as if nothing had been reported, and the accuracy
 * tile must say it is an upper bound. (The fake narrative's two claims name a query
 * nobody asked and an engine nobody measured, so both are discarded.)
 *
 * Needs a current dist/ and Chromium. Run: npx tsx test/discardedClaimsUi.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { startFakeGemini } from './fakeGemini';
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

const GEMINI_PORT = 6500 + Math.floor(Math.random() * 100);
const APP_PORT = 6700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${APP_PORT}`;

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => 'narrative_unattributable');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-discard-'));
  const app: ChildProcess = spawn('node', ['dist/server.cjs'], {
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
      ...TEST_AUTH_ENV,
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE);
    await page.fill('#auth-email-input', 'tester@example.com');
    await page.fill('#auth-code-input', TEST_ACCESS_CODE);
    await page.click('button[type=submit]');
    await page.waitForSelector('#business-name-input');
    await page.fill('#business-name-input', 'Poke House');
    await page.fill('#domain-input', 'poke.house');
    await page.click('button:has-text("Run Live GEO Search Audit")');
    await page.waitForSelector('text=Share of Voice', { timeout: 60000 });

    const card = await page.locator('main').innerText();
    assert('the accuracy tile says it is at most this when claims were discarded', /at most this, since 2 reported claims/.test(card), card.slice(0, 600));

    // The "Not counted" strip: visible without opening anything, and opening it lists each claim with a reason.
    const strip = page.locator('[data-testid=not-counted]');
    assert('a strip at the top says how many claims were not counted', /2 claims the analysis reported were not counted\./.test(await strip.innerText()), await strip.innerText());
    assert('...its list is closed until asked for', !(await strip.evaluate((el) => (el as HTMLDetailsElement).open)));
    await strip.locator('summary').click();
    const opened = await strip.innerText();
    assert('opened, it marks every row unverified and gives a plain reason', (opened.match(/unverified/gi) || []).length === 2 && /did not ask|could not be tied|did not measure/.test(opened), opened);
    assert('...and says none of it is in any figure', /left out of every figure and every rate/.test(opened), opened);

    assert('the findings tile does not read as a clean zero either', /2 reported claims not listed/.test(card), card.slice(0, 900));
    assert('the sidebar badge is a question mark, not blank', /Inaccuracies & Hallucinations\s*\?/.test(await page.locator('aside').innerText()), await page.locator('aside').innerText());

    await page.locator('aside').getByText('Inaccuracies & Hallucinations', { exact: false }).first().click();
    await page.waitForTimeout(300);
    const tab = await page.locator('main').innerText();
    assert('the tab says the claims could not be tied to an answer and that it cannot say there are none', /2 claims that could not be tied to a captured answer/.test(tab) && /cannot say there are\s+no inaccuracies/.test(tab), tab.slice(0, 600));
    assert('...and does NOT show the clean "No inaccuracies flagged" panel', !/No inaccuracies flagged/.test(tab));
  } finally {
    await browser.close();
    app.kill();
    fake.close();
  }
  console.log(failures === 0 ? '\nDiscarded-claims UI checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
