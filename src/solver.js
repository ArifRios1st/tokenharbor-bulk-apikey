'use strict';
/*
 * solver.js — the browser half of the mint (only used when the panel asks for a
 * human check on the signup form).
 *
 * The widget is a Cloudflare Turnstile checkbox. A real browser, a real mouse and
 * the page's own state are what make it pass — nothing is pasted and no captcha
 * service is called.
 *
 * The browser comes from `puppeteer-core` + a Chromium on the machine, in this
 * order: `channel: 'chrome'`, the env override (`PUPPETEER_EXECUTABLE_PATH` /
 * `CHROME_PATH` / `BRAVE_PATH`), Chrome from the puppeteer cache (`npx puppeteer
 * browsers install chrome`), then well-known Brave/Chrome install paths;
 * `--enable-automation`, which puppeteer adds by default and which Turnstile reads
 * first, is suppressed on purpose.
 *
 * It also pre-solves Cloudflare's edge challenge page ("Just a moment..."):
 * presolveChallenge() loads the login page in Chrome, waits for the challenge to
 * clear, and returns the clearance cookies for the CLI's HTTP session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = 'https://tokenharbor.ai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when a navigation error is only a timeout: the page may still be
 * loading in the background, so the caller can keep watching instead of
 * failing. A net::ERR_* is a real failure. */
function isNavigationTimeout(e) {
  // goto: "Navigation timeout of 30000 ms exceeded"; waits: "Waiting failed:
  // 30000ms exceeded". A net::ERR_* matches neither.
  return /timeout|exceeded/i.test(String((e && e.message) || e));
}

/** Resource types the Cloudflare challenge never needs. Blocking them keeps a
 * slow exit's bandwidth for the challenge scripts. */
function shouldBlockResource(type) {
  return ['image', 'stylesheet', 'font', 'media'].includes(type);
}

/** Chrome installed by `npx puppeteer browsers install chrome` lives in the
 * puppeteer cache (~/.cache/puppeteer, or PUPPETEER_CACHE_DIR), which neither
 * channel resolution nor the system install paths look at. Layout:
 * chrome/<platform>-<buildId>/chrome-<platform>/<exe>. Newest install wins. */
function findPuppeteerChrome() {
  const cache = process.env['PUPPETEER_CACHE_DIR'] || path.join(os.homedir(), '.cache', 'puppeteer');
  const chromeDir = path.join(cache, 'chrome');
  let entries;
  try {
    entries = fs.readdirSync(chromeDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  const plats =
    process.platform === 'win32'
      ? ['win64', 'win32']
      : process.platform === 'darwin'
        ? [process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64', process.arch === 'arm64' ? 'mac-x64' : 'mac-arm64']
        : ['linux-64'];
  for (const plat of plats) {
    const exeRel =
      process.platform === 'win32'
        ? path.join(`chrome-${plat}`, 'chrome.exe')
        : process.platform === 'darwin'
          ? path.join(`chrome-${plat}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
          : path.join(`chrome-${plat}`, 'chrome');
    const dirs = entries
      .filter((d) => d.isDirectory() && d.name.startsWith(`${plat}-`))
      .map((d) => path.join(chromeDir, d.name))
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch (e) {
          return 0;
        }
      });
    for (const dir of dirs) {
      const exe = path.join(dir, exeRel);
      try {
        if (fs.existsSync(exe)) return exe;
      } catch (e) {
        /* next */
      }
    }
  }
  return null;
}

/** Find a Chromium executable: explicit env override first, then the puppeteer
 * cache, then well-known install locations. Brave is Chromium, puppeteer-core
 * drives it the same way. */
function findBrowserExecutable() {
  for (const v of ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH', 'BRAVE_PATH']) {
    const p = process.env[v];
    if (p && fs.existsSync(p)) return p;
  }
  const cached = findPuppeteerChrome();
  if (cached) return cached;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push('/usr/bin/brave-browser', '/usr/bin/brave', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      /* next candidate */
    }
  }
  return null;
}

/** The --proxy-server value for a pool entry. Credentials ride in the URL:
 * Chrome authenticates a SOCKS5 proxy from them directly, no dialog and no
 * CDP round trip. (proxyAuth() below stays as the fallback for proxies that
 * challenge over HTTP 407.) */
function proxyServerArg(px) {
  if (!px) return null;
  const scheme = px.protocol && px.protocol.startsWith('socks') ? 'socks5' : 'http';
  const creds = px.username ? `${encodeURIComponent(px.username)}:${encodeURIComponent(px.password || '')}@` : '';
  return `--proxy-server=${scheme}://${creds}${px.host}:${px.port}`;
}

async function launchBrowser({ px = null, headless = false, log = null, extraArgs = [] } = {}) {
  const puppeteer = require('puppeteer-core');
  // The background flags matter on slow proxies: without them the browser phones
  // home (component updates, variations, sync) through the proxy at startup and
  // competes with the page itself for the exit.
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-sync',
    '--disable-default-apps',
    '--window-size=1280,900',
    '--lang=en-US',
    '--mute-audio',
    ...extraArgs,
  ];
  if (px) {
    args.push(proxyServerArg(px));
  }
  const options = { headless, args, ignoreDefaultArgs: ['--enable-automation'], defaultViewport: null };
  const attempts = [{ ...options, channel: 'chrome', label: "Chrome (channel 'chrome')" }];
  const exe = findBrowserExecutable();
  if (exe) attempts.push({ ...options, executablePath: exe, label: exe });
  let lastErr = null;
  for (const attempt of attempts) {
    const { label, ...launchOpts } = attempt;
    try {
      const browser = await puppeteer.launch(launchOpts);
      log && log(`   using browser: ${label}`);
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `No browser found (${lastErr ? lastErr.message : 'none'}). Install Chrome or Brave, set BRAVE_PATH/CHROME_PATH to the browser executable, or run: npx puppeteer browsers install chrome`
  );
}

async function proxyAuth(page, px, log = null) {
  if (!px || !px.username) return;
  const cdp = await page.target().createCDPSession();
  await cdp.send('Fetch.enable', { handleAuthRequests: true });
  cdp.on('Fetch.authRequired', async (e) => {
    const url = (e.request && e.request.url) || '?';
    const isProxy = e.authChallenge && e.authChallenge.isProxy;
    log && log(`   proxy auth challenge (proxy=${!!isProxy}) for ${String(url).slice(0, 80)}`);
    await cdp
      .send('Fetch.continueWithAuth', {
        requestId: e.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: px.username, password: px.password || '' },
      })
      .catch((err) => log && log(`   proxy auth continue failed: ${String(err.message).split('\n')[0].slice(0, 120)}`));
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
  const browser = await launchBrowser({ px, headless, log });
  try {
    const page = await browser.newPage();
    await proxyAuth(page, px, log);
    // Reuse the CLI session's cookies (e.g. cf_clearance from a pre-solved
    // challenge) so the browser does not face the challenge again.
    if (jarCookies.length) {
      await page.setCookie(...jarCookies.map((c) => ({ name: c.name, value: c.value, domain: 'tokenharbor.ai', path: '/' }))).catch(() => {});
    }
    try {
      await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      // A timeout is not a failure: the page keeps loading in the background
      // and the selector wait below covers it. Only a net::ERR_* fails here.
      if (!isNavigationTimeout(e)) {
        return { ok: false, why: `browser could not load the page (${String(e.message).slice(0, 200)})` };
      }
      log && log('   signup page still loading after 60s, watching for the form anyway');
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
  const browser = await launchBrowser({ px, headless, log });
  const t0 = Date.now();
  try {
    const page = await browser.newPage();
    await proxyAuth(page, px, log);
    if (ua) await page.setUserAgent(ua);
    // Block what the challenge never needs (images, fonts, stylesheets): on a
    // slow exit they eat the bandwidth the challenge scripts need. Only when
    // there is no proxy auth — proxyAuth() enables the Fetch domain for auth,
    // and interception uses the same domain.
    if (!px || !px.username) {
      const intercepted = await page
        .setRequestInterception(true)
        .then(() => true)
        .catch(() => false);
      if (intercepted) {
        page.on('request', (req) => {
          if (shouldBlockResource(req.resourceType())) req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });
      }
    }
    try {
      // NOTE: 'commit' is not a valid waitUntil for puppeteer-core goto — it
      // throws "Unknown value for options.waitUntil". domcontentloaded stays,
      // but its timeout is short and non-fatal (see below).
      await page.goto(`${BASE}/login?mode=signup`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log && log(`   browser + page load in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      // A timeout is not a failure: the page keeps loading in the background
      // and the challenge wait below covers it. Only a net::ERR_* fails here.
      if (!isNavigationTimeout(e)) {
        return { ok: false, why: `browser could not load the page (${String(e.message).slice(0, 200)})` };
      }
      log && log('   challenge page still loading after 30s, watching for the challenge anyway');
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

module.exports = { launchBrowser, solveTurnstile, signupInBrowser, presolveChallenge, proxyAuth, proxyServerArg, findBrowserExecutable, findPuppeteerChrome, isNavigationTimeout, shouldBlockResource };
