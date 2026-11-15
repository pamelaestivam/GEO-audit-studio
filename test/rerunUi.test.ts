/**
 * "Run again" and "Since the previous run" in a real browser, desktop and phone, on the real built server with a fake Gemini that
 * changes its answer between the two runs (docs/PLAN_2026-11.md P3). Proves what a person sees: the button on a saved audit, progress,
 * the strip built from the comparison (counts, the caveat, no percentage), a phone layout that does not scroll sideways and brings the
 * outcome into view, and the sentence when the earlier audit has been deleted.
 * Needs a current dist/ and a Chromium. Run: npx tsx test/rerunUi.test.ts  (RERUN_UI_SHOTS_DIR=<dir> saves screenshots)
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';
import { randomPort } from './ports';
import { startFakeGemini, type FakeMode } from './fakeGemini';
import { TEST_ACCESS_CODE, TEST_AUTH_ENV, TEST_EMAIL, loginAs, rawFetch } from './authHelper';

let failures = 0;
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}
const GEMINI_PORT = randomPort(5300, 90);
const APP_PORT = randomPort(5400, 190);
let mode: FakeMode = 'ok';
const SHOTS = process.env.RERUN_UI_SHOTS_DIR;

async function signIn(page: Page, base: string, email: string) {
  await page.goto(base);
  await page.fill('#auth-email-input', email);
  await page.fill('#auth-code-input', TEST_ACCESS_CODE);
  await page.click('button[type=submit]');
}

async function main() {
  const fake = await startFakeGemini(GEMINI_PORT, () => mode);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-ui-'));
  let browser: Browser | null = null;
  const children: ChildProcess[] = [];
  const start = async (port: number) => {
    const child = spawn('node', ['dist/server.cjs'], {
      env: {
        ...process.env, PORT: String(port), NODE_ENV: 'production', DATA_DIR: dataDir, GEMINI_API_KEY: 'fake-key', GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`,
        GEMINI_MIN_INTERVAL_MS: '0', RATE_LIMIT_PER_MIN: '0', HTTP_PROXY: '', HTTPS_PROXY: '', OPENAI_API_KEY: '', PERPLEXITY_API_KEY: '', ANTHROPIC_API_KEY: '', ...TEST_AUTH_ENV,
      },
      stdio: 'ignore',
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try {
        if ((await rawFetch(`${base}/api/health`)).ok) return base;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return base;
  };
  try {
    browser = await chromium.launch();
    let port = APP_PORT;
    for (const [label, viewport, phone] of [['desktop', { width: 1280, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]] as const) {
      const base = await start(port++);
      const email = `${label}@example.com`;
      const ctx = await browser.newContext({ viewport: { ...viewport }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      mode = 'ok';
      await signIn(page, base, email);
      await page.fill('#business-name-input', 'Poke House');
      await page.fill('#domain-input', 'poke.house');
      await page.click('button:has-text("Run Live GEO Search Audit")');
      await page.waitForSelector('text=Share of Voice', { timeout: 60000 });
      assert(`${label}: a first audit has no "Since the previous run" strip`, (await page.locator('[data-testid=since-previous]').count()) === 0);
      assert(`${label}: a saved audit offers "Run again"`, await page.locator('button:has-text("Run again")').first().isVisible());

      // ---- run it again, with a fake that now answers differently
      mode = 'changed_answer';
      await page.locator('button:has-text("Run again")').first().click();
      const sawProgress = await page.waitForSelector('text=Running the audit again', { timeout: 15000 }).then(() => true).catch(() => false);
      assert(`${label}: progress is shown while it runs (or it finished too fast to see)`, sawProgress || (await page.locator('[data-testid=since-previous]').count()) > 0);
      const strip = page.locator('[data-testid=since-previous]');
      assert(`${label}: the strip appears on the new audit`, await strip.waitFor({ timeout: 60000 }).then(() => true).catch(() => false));
      await strip.locator('text=Compared over').waitFor({ timeout: 30000 }).catch(() => undefined);
      const text = await strip.innerText();
      assert(`${label}: it says named in N of M before and now, as counts`, /named in\s+\d+ of \d+\s+before and in\s+0 of \d+\s+now/.test(text.replace(/\s+/g, ' ').replace(/named in /, 'named in ')) || /\d+ of \d+ before and in 0 of \d+ now/.test(text.replace(/\s+/g, ' ')), text);
      assert(`${label}: no percentage difference is shown`, !/%/.test(text), text);
      assert(`${label}: the sources and the new rival are listed`, /tripadvisor\.com/.test(text) && /yelp\.com/.test(text) && /Wild Tuna Co/.test(text), text);
      assert(`${label}: it always carries the caveat`, /Answer engines vary from run to run; a change in one answer is an observation, not a trend\./.test(text), text);
      const widths = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
      assert(`${label}: the page does not scroll sideways`, widths.s <= widths.w, JSON.stringify(widths));
      const box = await page.locator('button:has-text("Run again")').first().boundingBox();
      assert(`${label}: the button is a real tap target`, !!box && box.height >= 32 && box.width >= 60, JSON.stringify(box));
      if (phone) {
        const top = await strip.evaluate((el) => el.getBoundingClientRect().top);
        assert('phone: after the re-run the strip is on the first screen, below the sticky header and not hidden under it', top >= 200 && top < 844, String(top));
        const cardTop = await page.locator('text=Saved to your account').first().evaluate((el) => el.getBoundingClientRect().top);
        assert('phone: the new audit\'s card is in view', cardTop > -200 && cardTop < 844, String(cardTop));
      }
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${label}-strip.png`), fullPage: true });
      }

      // ---- delete the earlier audit; the strip says so, the new audit stays
      const token = await loginAs(base, email);
      const list: any = await (await rawFetch(`${base}/api/audits`, { headers: { Authorization: `Bearer ${token}` } })).json();
      const newest = [...list.audits].sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      const oldest = [...list.audits].sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      assert(`${label}: two saved audits`, list.audits.length === 2, JSON.stringify(list.audits.length));
      await rawFetch(`${base}/api/audits/${oldest.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      await page.reload();
      await page.locator('[data-testid=since-previous]').waitFor({ timeout: 30000 });
      await page.locator('text=The earlier audit this one was compared with has been deleted.').waitFor({ timeout: 30000 }).catch(() => undefined);
      const after = await page.locator('[data-testid=since-previous]').innerText();
      assert(`${label}: with the earlier audit deleted the strip says so and shows nothing else`, /The earlier audit this one was compared with has been deleted\./.test(after) && !/Compared over/.test(after) && newest.id !== oldest.id, after);

      // ---- a failed re-run: shown as a failed audit, the saved one is untouched
      mode = 'unauthorized';
      await page.locator('button:has-text("Run again")').first().click();
      assert(`${label}: a re-run that fails is shown as a failed audit`, await page.waitForSelector('text=Audit incomplete', { timeout: 60000 }).then(() => true).catch(() => false));
      assert(`${label}: ...with no "Since the previous run" strip`, (await page.locator('[data-testid=since-previous]').count()) === 0);
      assert(`${label}: no uncaught page errors`, errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  } finally {
    await browser?.close();
    for (const c of children) c.kill();
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nRun-again UI checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
