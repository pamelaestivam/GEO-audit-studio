/**
 * The login page with Google, in a real browser (Chromium via Playwright) against the real built server. Google's own
 * script (https://accounts.google.com/gsi/client) is replaced by a stand-in that draws a plain button and, when it is
 * clicked, hands the page a token minted here and signed with the key the fake Google keys server serves. So what is
 * proved is everything on our side of the button: what the page shows and hides, what it does with Google's answer, and
 * how it fails. What is NOT proved is Google's real button and popup: that needs a real Google account.
 *
 * Needs a current dist/ and a Chromium. Run: npx tsx test/googleLoginUi.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import { PortRange, randomPort } from './ports';
import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { TEST_ACCESS_CODE, TEST_AUTH_ENV, rawFetch } from './authHelper';
import { TEST_GOOGLE_CLIENT_ID, mintGoogleToken, startFakeKeys } from './googleTestKit';

let failures = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    console.log(`pass  ${name}`);
  }
}

const GSI = 'https://accounts.google.com/gsi/client';
const STUB = `
  window.google = { accounts: { id: {
    initialize: function (cfg) { window.__gsiCfg = cfg; },
    renderButton: function (el, opts) {
      window.__gsiOpts = opts;
      var b = document.createElement('button');
      b.id = 'stub-google'; b.type = 'button'; b.textContent = 'Continue with Google';
      b.onclick = function () { window.__gsiCfg.callback({ credential: window.__credential }); };
      el.appendChild(b);
    },
    disableAutoSelect: function () {}, cancel: function () {}
  } } };
`;

const nextPort = new PortRange(10900, 200);
const KEYS_PORT = randomPort(11200, 100);
const SHOTS = process.env.GOOGLE_LOGIN_SHOTS_DIR || '';

async function appears(page: Page, selector: string, timeout = 15000): Promise<boolean> {
  return page
    .waitForSelector(selector, { timeout })
    .then(() => true)
    .catch(() => false);
}
const visible = (page: Page, selector: string) => page.locator(selector).first().isVisible().catch(() => false);

async function main() {
  const keys = await startFakeKeys(KEYS_PORT);
  const procs: ChildProcess[] = [];
  let browser: Browser | null = null;

  const start = (env: Record<string, string> = {}) => {
    const port = nextPort.take();
    procs.push(
      spawn('node', ['dist/server.cjs'], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'production',
          DATA_DIR: '',
          GEMINI_API_KEY: 'fake-key',
          GEMINI_BASE_URL: 'http://127.0.0.1:1',
          GEMINI_MIN_INTERVAL_MS: '0',
          RATE_LIMIT_PER_MIN: '0',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          OPENAI_API_KEY: '',
          PERPLEXITY_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          ...TEST_AUTH_ENV,
          GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
          GOOGLE_ALLOWED_EMAILS: 'pamela@example.com',
          GOOGLE_JWKS_URL: keys.url,
          ...env,
        },
        stdio: 'ignore',
      })
    );
    return `http://127.0.0.1:${port}`;
  };
  const waitUp = async (base: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await rawFetch(`${base}/api/health`)).ok) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const newPage = async (ctx: BrowserContext, credential?: string) => {
    const page = await ctx.newPage();
    await page.route(GSI, (route) => route.fulfill({ contentType: 'text/javascript', body: STUB }));
    if (credential !== undefined) await page.addInitScript((c) => ((window as any).__credential = c), credential);
    return page;
  };

  try {
    const BOTH = start();
    const ONLY = start({ ACCESS_CODES: '' });
    const NONE = start({ GOOGLE_CLIENT_ID: '', GOOGLE_ALLOWED_EMAILS: '', GOOGLE_JWKS_URL: '' });
    const PARTIAL = start({ GOOGLE_ALLOWED_EMAILS: '' });
    assert('the four app servers start', (await Promise.all([BOTH, ONLY, NONE, PARTIAL].map(waitUp))).every(Boolean));
    browser = await chromium.launch();

    // ===== Desktop, Google and access codes both on
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    const page = await newPage(desktop, mintGoogleToken());
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BOTH);
    assert('the Google button is shown', await appears(page, '#stub-google'));
    assert('...as the first thing to do: the access-code form is not shown yet', !(await visible(page, '#auth-code-input')) && !(await visible(page, '#auth-email-input')));
    assert('...the page says which account to use', (await page.locator('text=Continue with the Google account you were invited with.').count()) === 1);
    assert('...and offers an access code as the other way in, collapsed', (await page.locator('button:has-text("Use an access code instead")').getAttribute('aria-expanded')) === 'false');
    const cfg = await page.evaluate(() => ({ id: (window as any).__gsiCfg?.client_id, auto: (window as any).__gsiCfg?.auto_select, opts: (window as any).__gsiOpts }));
    assert('Google is given the public client id the server published, and no automatic sign-in', cfg.id === TEST_GOOGLE_CLIENT_ID && cfg.auto === false);
    assert('...and asked for a "Continue with" button no narrower than 200 and no wider than 400 pixels', cfg.opts?.text === 'continue_with' && cfg.opts?.width >= 200 && cfg.opts?.width <= 400, JSON.stringify(cfg.opts));
    assert('there is no "Quick Demo" or other bypass', (await page.locator('text=Quick Demo').count()) === 0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'google-login-desktop.png') });

    // an invited account signs in
    await page.click('#stub-google');
    assert('an invited Google account lands in the app', await appears(page, '#business-name-input'));
    assert('...as that person', (await page.locator('text=pamela@example.com').count()) > 0);
    await page.reload();
    assert('...and a reload keeps the session', await appears(page, '#business-name-input'));
    await page.evaluate(() => localStorage.clear()); // the next scenarios must start signed out
    await page.close();

    // an account that is not invited
    const stranger = await newPage(desktop, mintGoogleToken({ email: 'stranger@example.com' }));
    await stranger.goto(BOTH);
    await stranger.click('#stub-google');
    assert('an account that is not invited is told so, in a sentence that names it', await appears(stranger, '[role=alert]:has-text("stranger@example.com has not been invited")'));
    assert('...stays on the sign-in page, with the button usable again', (await visible(stranger, '#stub-google')) && !(await stranger.locator('#business-name-input').count()));
    if (SHOTS) await stranger.screenshot({ path: path.join(SHOTS, 'google-login-not-invited.png') });
    await stranger.close();

    // an expired token
    const expired = await newPage(desktop, mintGoogleToken({}, { expiresInS: -7200 }));
    await expired.goto(BOTH);
    await expired.click('#stub-google');
    assert('an expired Google sign-in says so and does not sign in', (await appears(expired, '[role=alert]:has-text("expired")')) && !(await expired.locator('#business-name-input').count()));
    await expired.close();

    // the access code way in
    const code = await newPage(desktop);
    await code.goto(BOTH);
    await code.waitForSelector('button:has-text("Use an access code instead")');
    await code.click('button:has-text("Use an access code instead")');
    assert('"Use an access code instead" opens the email and code form', (await visible(code, '#auth-email-input')) && (await code.locator('button:has-text("Use an access code instead")').getAttribute('aria-expanded')) === 'true');
    await code.fill('#auth-email-input', 'tester@example.com');
    await code.fill('#auth-code-input', 'wrong-code-123');
    await code.click('button[type=submit]');
    assert('a wrong code shows the server\'s sentence', await appears(code, '[role=alert]:has-text("access code is not valid")'));
    await code.fill('#auth-code-input', TEST_ACCESS_CODE);
    await code.click('button[type=submit]');
    assert('the right code signs in', await appears(code, '#business-name-input'));
    await code.evaluate(() => localStorage.clear());
    await code.close();

    // Google's script cannot be loaded (an ad blocker, a network rule)
    const blocked = await desktop.newPage();
    await blocked.route(GSI, (route) => route.abort());
    await blocked.goto(BOTH);
    assert('when Google\'s script is blocked the page says so in a sentence', await appears(blocked, '[role=alert]:has-text("Google sign-in could not be loaded")'));
    assert('...with a way to try again', (await blocked.locator('button:has-text("Try again")').count()) === 1);
    await blocked.click('button:has-text("Use an access code instead")');
    assert('...and the access code still works as the way in', await visible(blocked, '#auth-code-input'));
    await blocked.unroute(GSI);
    await blocked.route(GSI, (route) => route.fulfill({ contentType: 'text/javascript', body: STUB }));
    await blocked.addInitScript((c) => ((window as any).__credential = c), mintGoogleToken());
    await blocked.click('button:has-text("Try again")');
    assert('...and "Try again" brings the button back once the script can load', await appears(blocked, '#stub-google'));
    await blocked.close();
    assert('no script errors on the sign-in page', errors.length === 0, errors.join(' | '));
    await desktop.close();

    // ===== Google only: no access code is offered
    const onlyCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const only = await newPage(onlyCtx, mintGoogleToken());
    await only.goto(ONLY);
    assert('on a Google-only server the button is shown', await appears(only, '#stub-google'));
    assert('...and no access code is offered, because none would work', (await only.locator('button:has-text("Use an access code instead")').count()) === 0 && !(await visible(only, '#auth-code-input')));
    assert('...and the page says only invited Google accounts can sign in', (await only.locator('text=Only invited Google accounts can sign in here.').count()) === 1);
    await only.click('#stub-google');
    assert('...and an invited account signs in', await appears(only, '#business-name-input'));
    await onlyCtx.close();

    // ===== No Google settings: the page is what it was
    const noneCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const none = await newPage(noneCtx);
    await none.goto(NONE);
    assert('with no Google settings the email and code form is the page', await appears(none, '#auth-code-input'));
    assert('...with no Google button, no "or", and the old sentence', (await none.locator('[data-testid=google-signin]').count()) === 0 && (await none.locator('button:has-text("Use an access code instead")').count()) === 0 && (await none.locator('text=Enter the email you were invited with and your access code.').count()) === 1);
    await noneCtx.close();

    // ===== A client id with nobody invited: said plainly, access codes still work
    const partialCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const partial = await newPage(partialCtx);
    await partial.goto(PARTIAL);
    assert('a half-set-up Google sign-in tells a visitor in plain words it is not available and what to do', await appears(partial, '[data-testid=google-off]:has-text("Google sign-in is not available right now. Use your access code.")'));
    assert('...without the operator\'s setting names', !/GOOGLE_|lists nobody/.test(await partial.locator('body').innerText()));
    assert('...shows no Google button, and the access code form is the page', (await partial.locator('[data-testid=google-signin]').count()) === 0 && (await visible(partial, '#auth-code-input')));
    await partialCtx.close();

    // ===== The server takes a while to say how people can sign in: no form that is taken away afterwards
    const slowCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const slow = await newPage(slowCtx, mintGoogleToken());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await slow.route('**/api/audit/status', async (route) => {
      await gate;
      await route.continue();
    });
    await slow.goto(BOTH);
    assert('while the server has not said how to sign in the page says it is checking', await appears(slow, '[data-testid=auth-checking]'));
    assert('...and shows no form to start typing in', !(await visible(slow, '#auth-email-input')) && !(await visible(slow, '#auth-code-input')));
    release();
    assert('...then the Google button replaces the wait, and the code form never appeared', (await appears(slow, '#stub-google')) && !(await visible(slow, '#auth-email-input')) && (await slow.locator('[data-testid=auth-checking]').count()) === 0);
    await slowCtx.close();

    const deadCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dead = await newPage(deadCtx);
    await dead.route('**/api/audit/status', (route) => route.abort());
    await dead.goto(BOTH);
    assert('if the server never says, the page does not hide the way in for ever: the form appears after a few seconds', await appears(dead, '#auth-code-input', 12000));
    await deadCtx.close();

    // ===== Reading order, focus, widths, touch size (desktop, both ways in)
    const detailCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const detail = await newPage(detailCtx, mintGoogleToken());
    await detail.goto(BOTH);
    await detail.waitForSelector('#stub-google');
    const order = await detail.evaluate(() => {
      const signIn = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Sign in');
      const pitch = Array.from(document.querySelectorAll('h2')).find((h) => /Audit Brand Visibility/.test(h.textContent || ''));
      return !!signIn && !!pitch && !!(signIn.compareDocumentPosition(pitch) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert('the "Sign in" heading comes before the pitch in the page itself (a screen reader reads it first)', order);
    const sides = await detail.evaluate(() => {
      const signIn = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Sign in')!.getBoundingClientRect();
      const pitch = Array.from(document.querySelectorAll('h2')).find((h) => /Audit Brand Visibility/.test(h.textContent || ''))!.getBoundingClientRect();
      return { signInLeft: signIn.left, pitchLeft: pitch.left };
    });
    assert('...yet side by side on a desktop the pitch is still on the left', sides.pitchLeft < sides.signInLeft, JSON.stringify(sides));
    const widths = await detail.evaluate(() => ({
      google: (document.querySelector('[data-testid=google-signin]') as HTMLElement).getBoundingClientRect().width,
      toggle: (Array.from(document.querySelectorAll('button')).find((b) => /Use an access code instead/.test(b.textContent || '')) as HTMLElement).getBoundingClientRect().width,
    }));
    assert('the Google button and the access-code line stack at the same width', Math.abs(widths.google - widths.toggle) <= 1 && widths.google <= 400, JSON.stringify(widths));
    await detail.click('button:has-text("Use an access code instead")');
    assert('opening the access-code form puts the cursor in the email field', await detail.evaluate(() => document.activeElement?.id === 'auth-email-input'));
    const eye = await detail.locator('button[aria-label="Show access code"]').boundingBox();
    const toggleBox = await detail.locator('button:has-text("Use an access code instead")').boundingBox();
    const submitBox = await detail.locator('button[type=submit]').boundingBox();
    assert('the show-code eye, the toggle and Sign in are all at least 36px to hit (the toggle and Sign in 44px)', !!eye && eye.width >= 36 && eye.height >= 36 && !!toggleBox && toggleBox.height >= 44 && !!submitBox && submitBox.height >= 44, JSON.stringify({ eye, toggleBox, submitBox }));
    await detailCtx.close();

    // ===== A Google-only server tells an uninvited account the truth
    const onlyBadCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const onlyBad = await newPage(onlyBadCtx, mintGoogleToken({ email: 'stranger@example.com' }));
    await onlyBad.goto(ONLY);
    await onlyBad.click('#stub-google');
    const onlyText = await onlyBad.locator('[role=alert]').first().innerText().catch(() => '');
    assert('on a Google-only server an uninvited account is not told to use an access code', /has not been invited/.test(onlyText) && !/access code/.test(onlyText), onlyText);
    await onlyBadCtx.close();

    // ===== A phone
    const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
    const mobile = await newPage(phone, mintGoogleToken());
    await mobile.goto(BOTH);
    assert('on a phone the Google button is shown', await appears(mobile, '#stub-google'));
    const box = await mobile.locator('#stub-google').boundingBox();
    assert('...and it is on the first screen, without scrolling', !!box && box.y + box.height <= 740, JSON.stringify(box));
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert('...the page does not scroll sideways', overflow <= 0, `overflow ${overflow}px`);
    const buttonWidth = await mobile.evaluate(() => (window as any).__gsiOpts?.width);
    const holderWidth = await mobile.evaluate(() => (document.querySelector('[data-testid=google-signin]') as HTMLElement)?.clientWidth || 0);
    assert('...and the button is asked to fit the space there is', buttonWidth >= 200 && buttonWidth <= Math.max(holderWidth, 200) && buttonWidth !== 320, `asked ${buttonWidth}, space ${holderWidth}`);
    await mobile.click('#stub-google');
    assert('...and signing in works there', await appears(mobile, '#business-name-input'));
    await mobile.evaluate(() => localStorage.clear());
    if (SHOTS) {
      const shot = await phone.newPage();
      await shot.route(GSI, (route) => route.fulfill({ contentType: 'text/javascript', body: STUB }));
      await shot.goto(BOTH);
      await shot.waitForSelector('#stub-google');
      await shot.screenshot({ path: path.join(SHOTS, 'google-login-phone.png'), fullPage: true });
    }
    await phone.close();
  } finally {
    if (browser) await browser.close();
    for (const p of procs) p.kill();
    await keys.close().catch(() => undefined);
  }
  console.log(failures === 0 ? '\nAll Google login page checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error('Google login page harness error:', err);
  process.exit(1);
});
