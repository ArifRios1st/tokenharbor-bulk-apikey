'use strict';
/*
 * solver.js — the browser half of the mint (only used when the panel asks for a
 * human check on the signup form).
 *
 * The widget is a Cloudflare Turnstile checkbox. A real browser, a real mouse and
 * the page's own state are what make it pass — nothing is pasted and no captcha
 * service is called.
 *
 * Chrome comes from `puppeteer-core` + the Chrome already installed on the machine
 * (`channel: 'chrome'`); `--enable-automation`, which puppeteer adds by default and
 * which Turnstile reads first, is suppressed on purpose.
 *
 * It also pre-solves Cloudflare's edge challenge page ("Just a moment..."):
 * presolveChallenge() loads the login page in Chrome, waits for the challenge to
 * clear, and returns the clearance cookies for the CLI's HTTP session.
 */
const BASE = 'https://tokenharbor.ai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchBrowser({ px = null, headless = false } = {}) {
  const puppeteer = require('puppeteer-core');
  const args = ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=en-US', '--mute-audio'];
  if (px) {
    const scheme = px.protocol && px.protocol.startsWith('socks') ? 'socks5' : 'http';
    args.push(`--proxy-server=${scheme}://${px.host}:${px.port}`);
  }
  const options = { headless, args, ignoreDefaultArgs: ['--enable-automation'], defaultViewport: null };
  return puppeteer
    .launch({ ...options, channel: 'chrome' })
    .catch(() => puppeteer.launch(options))
    .catch((e) => {
      throw new Error(
        `Chrome not found (${e.message}). Install Chrome, or run: npx puppeteer browsers install chrome`
      );
    });
}

async function proxyAuth(page, px) {
  if (!px || !px.username) return;
  const cdp = await page.target().createCDPSession();
  await cdp.send('Fetch.enable', { handleAuthRequests: true });
  cdp.on('Fetch.authRequired', async (e) => {
    await cdp
      .send('Fetch.continueWithAuth', {
        requestId: e.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: px.username, password: px.password || '' },
      })
      .catch(() => {});
  });
}

/** Click inside the Turnstile iframe with a real mouse until the token appears. */
async function solveTurnstile(page, log, { tries = 5, waitMs = 12000 } = {}) {
  const tokenOf = async () => {
    const v = await page
      .evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el ? el.value : '';
      })
      .catch(() => '');
    return String(v || '');
  };
  for (let attempt = 1; attempt <= tries; attempt++) {
    let token = await tokenOf();
    if (token && token.length > 20) return token;
    // The widget can be inline (no OOPIF) — click the container's checkbox spot.
    const hostBox = await page
      .evaluate(() => {
        const el = document.querySelector('.cf-turnstile, [data-sitekey]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      })
      .catch(() => null);
    if (hostBox) {
      const x = hostBox.x + Math.min(30, hostBox.w / 2);
      const y = hostBox.y + hostBox.h / 2;
      await page.mouse.move(x - 4, y - 3);
      await sleep(40 + Math.random() * 90);
      await page.mouse.click(x, y);
      log && log(`   turnstile container click #${attempt} @ ${Math.round(x)},${Math.round(y)}`);
    }
    const frames = page.frames().filter((f) => /challenges\.cloudflare\.com/.test(f.url()));
    for (const f of frames) {
      try {
        const box = await f.evaluate(() => {
          const el = document.querySelector('input[type=checkbox]') || document.body;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        if (box && box.w > 0) {
          // The iframe's own coordinate space is offset from the page; ask the page
          // where the widget sits and click the same relative point.
          const host = await page.evaluate(() => {
            const ifr = [...document.querySelectorAll('iframe')].find((i) => /challenges\.cloudflare\.com/.test(i.src || ''));
            if (!ifr) return null;
            const r = ifr.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          });
          if (host) {
            const x = host.x + Math.min(box.x + box.w / 2, host.w - 4);
            const y = host.y + Math.min(box.y + box.h / 2, host.h - 4);
            await page.mouse.move(x - 3, y - 2);
            await sleep(40 + Math.random() * 90);
            await page.mouse.click(x, y);
            log && log(`   turnstile click #${attempt} @ ${Math.round(x)},${Math.round(y)}`);
          }
        }
      } catch (e) {
        /* frame not ready */
      }
    }
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      token = await tokenOf();
      if (token && token.length > 20) return token;
      await sleep(700);
    }
  }
  return '';
}

/**
 * Fill the signup form in a real browser, press the button, and let the page mint
 * both the captcha token and the session. Returns the session cookies.
 */
async function signupInBrowser({ px = null, email, password, log = () => {}, headless = false, jarCookies = [] }) {
  const browser = await launchBrowser({ px, headless });
  try {
    const page = await browser.newPage();
    await proxyAuth(page, px);
    // Reuse the CLI session's cookies (e.g. cf_clearance from a pre-solved
    // challenge) so the browser does not face the challenge again.
    if (jarCookies.length) {
      await page.setCookie(...jarCookies.map((c) => ({ name: c.name, value: c.value, domain: 'tokenharbor.ai', path: '/' }))).catch(() => {});
    }
    try {
      await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      return { ok: false, why: `browser could not load the page (${String(e.message).slice(0, 60)})` };
    }
    await page
      .waitForSelector('input[name="email"]', { timeout: 60000 })
      .catch(() => {});
    // Cookie banner sits over the form.
    await page
      .evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /essential only|accept analytics/i.test(x.innerText || ''));
        if (b) b.click();
      })
      .catch(() => {});
    await sleep(400);
    // The signup panel gates its submit button behind a required consent box
    // ("I confirm that I am at least 18 years old."). It is a plain, unlabeled
    // <input type="checkbox"> that lives OUTSIDE the <form> in its own <label>,
    // so it has to be found by label text and clicked before anything is typed.
    const agreed = await page
      .evaluate(() => {
        const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(
          (b) => !b.disabled && b.getBoundingClientRect().width > 0
        );
        const textOf = (b) =>
          (b.labels && b.labels[0] && b.labels[0].innerText) || (b.parentElement && b.parentElement.innerText) || '';
        const pick =
          boxes.find((b) => /18|age|adult|years old/i.test(textOf(b))) || boxes[0];
        if (!pick) return false;
        if (!pick.checked) pick.click();
        return pick.checked;
      })
      .catch(() => false);
    log && log(`   age/terms consent ${agreed ? 'checked' : 'not found — continuing'}`);
    await sleep(300);
    await page.click('input[name="email"]').catch(() => {});
    await page.type('input[name="email"]', email, { delay: 40 + Math.random() * 60 }).catch(() => {});
    await page.click('input[name="password"]').catch(() => {});
    await page.type('input[name="password"]', password, { delay: 40 + Math.random() * 60 }).catch(() => {});
    await sleep(500);
    const press = async () => {
      const el = await page.$('button[type="submit"]').catch(() => null);
      if (el) return el.click().catch(() => {});
      await page
        .evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /create account/i.test(x.innerText || ''));
          if (b) b.click();
        })
        .catch(() => {});
    };
    // Success is leaving the signup page OR holding a session cookie: the form
    // lives at /signup (no mode=signup in the URL), so testing for mode=signup
    // was always true on the first check.
    const done = async () => {
      const gone = await page.evaluate(() => !/signup/.test(location.href)).catch(() => false);
      if (gone) return true;
      const cs = await page.cookies().catch(() => []);
      return cs.some((c) => /^sb-auth-auth-token/.test(c.name));
    };
    await press();
    let left = false;
    for (let i = 0; i < 20 && !left; i++) {
      await sleep(1500);
      left = await done();
    }
    if (!left) {
      const token = await solveTurnstile(page, log);
      if (!token) {
        const diag = await page.evaluate(() => ({ widget: !!document.querySelector('.cf-turnstile, [data-sitekey]'), frames: [...document.querySelectorAll('iframe')].map((i) => i.src).filter((s) => /cloudflare/.test(s)).length })).catch(() => ({}));
        return { ok: false, why: `turnstile token never appeared (widget=${diag.widget} cfFrames=${diag.frames})` };
      }
      log && log(`   turnstile token ${token.length} chars`);
      await press();
      for (let i = 0; i < 20 && !left; i++) {
        await sleep(1500);
        left = await done();
      }
    }
    const cookies = await page.cookies();
    const hasSession = cookies.some((c) => /^sb-auth-auth-token/.test(c.name));
    const text = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
    const ok = left && hasSession;
    return { ok, why: ok ? '' : left ? 'left the signup page without a session cookie' : String(text).replace(/\s+/g, ' ').slice(0, 120), cookies };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Pass Cloudflare's edge challenge page ("Just a moment...") in a real browser
 * and return the clearance cookies. The clearance is bound to the exit IP and the
 * user agent, so the browser must use the same proxy and the same UA string the
 * CLI sends over HTTP.
 */
async function presolveChallenge({ px = null, log = () => {}, headless = false, ua = null } = {}) {
  const browser = await launchBrowser({ px, headless });
  const t0 = Date.now();
  try {
    const page = await browser.newPage();
    await proxyAuth(page, px);
    if (ua) await page.setUserAgent(ua);
    try {
      await page.goto(`${BASE}/login?mode=signup`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      return { ok: false, why: `browser could not load the page (${String(e.message).slice(0, 60)})` };
    }
    // The challenge usually clears itself in a few seconds; wait for the real
    // page instead of sleeping a fixed time. If an interactive checkbox shows
    // up, solve it like the signup widget and wait again.
    let cleared = false;
    for (let round = 0; round < 3 && !cleared; round++) {
      cleared = await page
        .waitForFunction(() => !!document.querySelector('input[name="email"]') || !/Just a moment/.test(document.title), { timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      if (cleared) break;
      const token = await solveTurnstile(page, log, { tries: 2, waitMs: 8000 });
      log && log(`   challenge checkbox ${token ? 'solved' : 'no token'}`);
      if (!token) break;
    }
    if (!cleared) {
      const diag = await page.evaluate(() => ({ title: document.title, widget: !!document.querySelector('.cf-turnstile, [data-sitekey]') })).catch(() => ({}));
      return { ok: false, why: `challenge did not clear (title="${String(diag.title || '').slice(0, 40)}" widget=${diag.widget})` };
    }
    const cookies = await page.cookies();
    if (!cookies.some((c) => c.name === 'cf_clearance')) {
      return { ok: false, why: 'challenge cleared but no cf_clearance cookie' };
    }
    log && log(`   challenge cleared in ${Math.round((Date.now() - t0) / 1000)}s`);
    return { ok: true, cookies };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { launchBrowser, solveTurnstile, signupInBrowser, presolveChallenge };
