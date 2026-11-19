#!/usr/bin/env node
'use strict';
/*
 * tokenharbor-bulk-apikey CLI — mint Token Harbor (tokenharbor.ai) API keys.
 *
 * One command, no flags: `npm start` → menu → "Mint keys" → count → keys in keys.txt.
 * Every key is proven with a live chat-200 (two different prompts) before it is written.
 * Every account's login is saved to accounts.txt once its key exists, so the account
 * can be opened manually in a browser even if the live gate fails.
 *
 * Flow per account:
 *   mailbox → signup (Next.js server action, ids read live from the page) → activity
 *   beacon (/dashboard) → e-mail verification link → free-models consent (shown_text
 *   read live from the dashboard chunk + /api/me/free-tier, the way the browser's
 *   modal does) → API key (activity beacons before and after) → live chat-200.
 *
 * When the panel answers "complete the human check", the signup is replayed in a real
 * browser (src/solver.js, puppeteer-core, your installed Chrome or Brave) and the CLI
 * continues over HTTP with that browser's session.
 *
 * When Cloudflare answers the login page with its edge challenge ("Just a moment..."),
 * a real Chrome pre-solves it first and the clearance cookie is carried into the
 * HTTP session, so VPN/datacenter exits can mint too.
 *
 * Proxy is OPTIONAL: pass `--pool proxies.txt` and every request (and the browser)
 * leaves through your proxies; without it the CLI runs direct.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (e) {
  /* node < 17 */
}

const BASE = 'https://tokenharbor.ai';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const OUT = path.join(process.cwd(), 'keys.txt');
const ACCOUNTS_TXT = path.join(process.cwd(), 'accounts.txt');
// Strict mode: never fall back to a direct request (100% proxy runs).
const STRICT = process.argv.includes('--strict-proxy');
const CONSENT_TEXT = path.join(__dirname, 'consent-text.txt');
const FREE_MODEL = 'deepseek-v4.1-flash:free';
const FREE_FALLBACK = 'deepseek-v4-flash:free';
const LINK_RE = /https:\/\/tokenharbor\.ai\/verify-email\?token=[\w.\-]+/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function pool() {
  const explicit = arg('pool', null);
  let file = explicit || process.env.TOKENHARBOR_PROXIES || null;
  if (!file && fs.existsSync('proxies.txt')) file = 'proxies.txt';
  if (!file) return null;
  if (!fs.existsSync(String(file))) {
    if (explicit) throw new Error(`pool ${file} not found`);
    return null;
  }
  const lines = fs
    .readFileSync(String(file), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, '').trim()) // pool files often carry trailing comments
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error(`pool ${file} is empty`);
  return lines.map(parseProxy);
}
function parseProxy(line) {
  const clean = String(line).replace(/\s+#.*$/, '').trim();
  const m = clean.match(/^(https?|socks5h?):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/]+):(\d+)\/?$/i);
  if (!m) {
    const bare = clean.match(/^([^:/]+):(\d+)$/);
    if (bare) return { protocol: 'http', username: null, password: null, host: bare[1], port: Number(bare[2]) };
    throw new Error(`bad proxy line: ${String(line).slice(0, 40)}`);
  }
  return {
    protocol: m[1].toLowerCase(),
    username: m[2] ? decodeURIComponent(m[2]) : null,
    password: m[3] ? decodeURIComponent(m[3]) : null,
    host: m[4],
    port: Number(m[5]),
  };
}
/** Minimal cookie jar — the panel keeps its Supabase session in chunked cookies. */
class Jar {
  constructor() {
    this.c = new Map();
  }
  header() {
    return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(headers) {
    const set = headers['set-cookie'] || [];
    for (const line of set) {
      const m = /^([^=]+)=([^;]*)/.exec(String(line));
      if (!m) continue;
      const wipe = /max-age=0|expires=thu, 01 jan 1970/i.test(String(line));
      if (wipe || !m[2]) this.c.delete(m[1]);
      else this.c.set(m[1], m[2]);
    }
  }
  set(name, value) {
    if (value) this.c.set(name, value);
  }
  has(name) {
    return this.c.has(name);
  }
  keys() {
    return [...this.c.keys()];
  }
  entries() {
    return [...this.c.entries()].map(([name, value]) => ({ name, value }));
  }
}
/** HTTP helper. `px` is a parsed proxy or null (direct). */
async function req(url, { method = 'GET', headers = {}, body = null, px = null, jar = null, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const h = { 'user-agent': UA, ...(jar ? { cookie: jar.header() } : {}), ...headers };
  try {
    const opts = { method, headers: h, body, signal: ctrl.signal, redirect: 'manual' };
    // fetch() has no proxy support: the tunnel path must also feed the cookie jar,
    // otherwise the session cookies from a proxied signup are silently dropped.
    if (px) {
      const out = await tunnel(url, opts, px);
      if (jar) jar.absorb(out.headers);
      return out;
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    const hdrs = {};
    for (const [k, v] of r.headers) hdrs[k] = v;
    // fetch collapses multiple set-cookie headers; keep the list for the jar.
    if (r.headers.getSetCookie) hdrs['set-cookie'] = r.headers.getSetCookie();
    if (jar) jar.absorb(hdrs);
    return { status: r.status, headers: hdrs, text };
  } finally {
    clearTimeout(timer);
  }
}
/** CONNECT tunnel for HTTP proxies; SOCKS5 handshake for socks5 lines. */
async function tunnel(url, opts, px) {
  const net = require('net');
  const tls = require('tls');
  const http = require('http');
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  const raw = await new Promise((res, rej) => {
    const s = net.connect(px.port, px.host, () => res(s));
    s.once('error', rej);
    s.setTimeout(20000, () => s.destroy(new Error('proxy connect timeout')));
  });
  let sock = raw;
  if (px.protocol.startsWith('socks')) {
    await socks5(raw, u.hostname, Number(port), px);
  } else {
    const auth = px.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${px.username}:${px.password || ''}`).toString('base64')}\r\n`
      : '';
    sock.write(`CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n${auth}\r\n`);
    const head = await new Promise((res, rej) => {
      let buf = '';
      const onData = (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          sock.removeListener('data', onData);
          res(buf);
        }
      };
      sock.on('data', onData);
      sock.once('error', rej);
    });
    if (!/^HTTP\/1\.[01] 200/i.test(head)) throw new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`);
  }
  if (u.protocol === 'https:') {
    sock = tls.connect({ socket: sock, servername: u.hostname });
    await new Promise((res, rej) => {
      sock.once('secureConnect', res);
      sock.once('error', rej);
    });
  }
  return await new Promise((res, rej) => {
    const r = http.request(
      {
        method: opts.method,
        path: u.pathname + u.search,
        headers: { host: u.hostname, connection: 'close', ...opts.headers },
        createConnection: () => sock,
      },
      (x) => {
        let data = '';
        x.setEncoding('utf8');
        x.on('data', (c) => (data += c));
        x.on('end', () => res({ status: x.statusCode, headers: x.headers, text: data }));
      }
    );
    r.once('error', rej);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
function socks5(sock, host, port, px) {
  return new Promise((res, rej) => {
    const methods = px.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    let step = 0;
    const onData = (d) => {
      if (step === 0) {
        if (d[0] !== 0x05 || d[1] === 0xff) return rej(new Error('socks5 auth rejected'));
        if (d[1] === 0x02) {
          const u = Buffer.from(px.username || '');
          const p = Buffer.from(px.password || '');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          step = 1;
          return;
        }
        step = 2;
        return sendConnect();
      }
      if (step === 1) {
        if (d[1] !== 0x00) return rej(new Error('socks5 auth failed'));
        step = 2;
        return sendConnect();
      }
      if (step === 2) {
        sock.removeListener('data', onData);
        if (d[1] !== 0x00) return rej(new Error(`socks5 connect rc=${d[1]}`));
        res();
      }
    };
    const sendConnect = () => {
      step = 2;
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
    };
    sock.on('data', onData);
    sock.once('error', rej);
  });
}

/**
 * Mailbox rails. The panel asks for a "human check" when the address comes from a
 * disposable domain, and for those it does not even render the widget — so a real
 * inbound-mail host is the rail that works. Mailtrap's free tier is enough:
 * put its API token in `mailtrap.txt` (or MAILTRAP_TOKEN / --mailtrap-token) once.
 * The public temp-mail rails stay as a fallback for panels that accept them.
 */
function mailtrapToken() {
  const flag = arg('mailtrap-token', null);
  if (typeof flag === 'string' && flag.length > 20) return flag.trim();
  if (process.env.MAILTRAP_TOKEN) return String(process.env.MAILTRAP_TOKEN).trim();
  try {
    const t = fs.readFileSync('mailtrap.txt', 'utf8').trim();
    if (t.length > 20) return t;
  } catch (e) {
    /* no token file */
  }
  return null;
}
async function mailtrapBox(px, token) {
  const api = 'https://mailtrap.io/api';
  const H = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const folders = JSON.parse((await req(`${api}/inbound/folders`, { px, headers: H })).text);
  const arr = Array.isArray(folders) ? folders : folders.data || [];
  let folder = arr.find((f) => f.name === 'tokenharbor');
  if (!folder) {
    const made = await req(`${api}/inbound/folders`, { px, method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'tokenharbor' }) });
    folder = JSON.parse(made.text);
  }
  const made = await req(`${api}/inbound/folders/${folder.id}/inboxes`, {
    px,
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `th-${rand(8)}` }),
  });
  const box = JSON.parse(made.text);
  if (!box.address) throw new Error(`mailtrap inbox ${made.status} ${String(made.text).slice(0, 90)}`);
  return { address: box.address, rail: 'mailtrap', api, token, id: box.id, px };
}
async function makeMailbox(px) {
  const mt = mailtrapToken();
  if (mt) {
    // Mail providers are not the panel: when the exit cannot reach them, ask
    // directly instead of failing the account.
    try {
      return await mailtrapBox(px, mt);
    } catch (e) {
      try {
        return await mailtrapBox(null, mt);
      } catch (e2) {
        /* fall through to the public rails */
      }
    }
  }
  for (const [name, api] of [
    ['mail.tm', 'https://api.mail.tm'],
    ['mail.gw', 'https://api.mail.gw'],
  ]) {
    try {
      const d = JSON.parse((await req(api + '/domains', { px })).text);
      const dom = (d['hydra:member'] || d)[0].domain;
      const address = `th${rand(7)}@${dom}`;
      const password = `Px${rand(10)}!`;
      const cr = await req(api + '/accounts', {
        px,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (cr.status >= 300) continue;
      const tk = JSON.parse(
        (await req(api + '/token', { px, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, password }) })).text
      );
      if (!tk.token) continue;
      return { address, rail: name, api, token: tk.token, px };
    } catch (e) {
      /* next rail */
    }
  }
  throw new Error('no mailbox rail (set MAILTRAP_TOKEN or put it in mailtrap.txt)');
}
/** Newest-first message bodies for whichever rail the box came from. */
async function mailMessages(mail) {
  const out = [];
  if (mail.rail === 'mailtrap') {
    const H = { authorization: `Bearer ${mail.token}`, accept: 'application/json' };
    const list = JSON.parse((await req(`${mail.api}/inbound/inboxes/${mail.id}/messages?per_page=20`, { px: mail.px, headers: H })).text);
    for (const m of (list.data || list || []).slice(0, 10)) {
      const full = JSON.parse((await req(`${mail.api}/inbound/inboxes/${mail.id}/messages/${m.id}`, { px: mail.px, headers: H })).text);
      out.push(`${full.subject || ''} ${full.text_body || ''} ${JSON.stringify(full.html_body || '')}`);
    }
    return out;
  }
  const H = { authorization: `Bearer ${mail.token}` };
  const list = JSON.parse((await req(`${mail.api}/messages`, { px: mail.px, headers: H })).text);
  for (const m of (list['hydra:member'] || list || []).slice(0, 10)) {
    const full = JSON.parse((await req(`${mail.api}/messages/${m.id}`, { px: mail.px, headers: H })).text);
    out.push(`${full.subject || ''} ${full.text || ''} ${JSON.stringify(full.html || '')}`);
  }
  return out;
}
async function waitLink(mail, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      for (const hay of await mailMessages(mail)) {
        const hit = (hay.match(LINK_RE) || [])[0];
        if (hit) return hit.replace(/&amp;/g, '&');
      }
    } catch (e) {
      /* keep polling */
    }
    await sleep(5000);
  }
  return null;
}

/** Cloudflare's edge challenge page ("Just a moment..."). The signup form itself also
 * loads challenges.cloudflare.com for its Turnstile widget, so only the interstitial
 * page's own markers count — never the Turnstile script URL. */
function isChallengePage(html) {
  const h = html || '';
  return /<title>Just a moment\.\.\.<\/title>/i.test(h) || /id="cf-challenge"/i.test(h) || /window\._cf_chl_opt/i.test(h);
}
/** --screen verdict per exit: live (signup form), challenged (Cloudflare page),
 * dead (anything else, including connect failures). */
function classifyScreen(r) {
  const text = r.text || '';
  if (r.status === 200 && /Create your free account/i.test(text)) return 'live';
  if (isChallengePage(text)) return 'challenged';
  return 'dead';
}

/** Next.js server-action ids rotate on every deploy: read them from the live page. */
async function discover(px, jar) {
  const r = await req(`${BASE}/login?mode=signup`, { px, jar, headers: { accept: 'text/html' } });
  const html = r.text;
  if (isChallengePage(html)) throw new Error('cloudflare challenge page (Just a moment)');
  const deploy = (html.match(/data-dpl-id="([^"]+)"/) || [])[1];
  const action = (html.match(/\$ACTION_1:0" value="\{&quot;id&quot;:&quot;([^&]+)&quot;/) || [])[1];
  const actionKey = (html.match(/\$ACTION_KEY" value="([^"]+)"/) || [])[1];
  if (!deploy || !action || !actionKey) throw new Error('could not read the signup form ids from the page');
  return { deploy, action, actionKey, html };
}
function signupBody({ action, actionKey, fp, tz, email, password, turnstile }) {
  const b = '----WebKitFormBoundary' + rand(16);
  const f = [
    ['_1_$ACTION_REF_1', ''],
    ['_1_$ACTION_1:0', JSON.stringify({ id: action, bound: '$@1' })],
    ['_1_$ACTION_1:1', '["$undefined"]'],
    ['_1_$ACTION_KEY', actionKey],
    ['_1_device_fingerprint', fp],
    ['_1_timezone', tz],
    ['_1_next', ''],
    ['_1_email', email],
    ['_1_password', password],
    ['_1_invite_code', ''],
  ];
  if (turnstile) f.push(['cf-turnstile-response', turnstile]);
  f.push(['0', '["$undefined","$K1"]']);
  const body = f.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${b}--\r\n`;
  return { body, boundary: b };
}
const RST =
  '%5B%22%22%2C%7B%22children%22%3A%5B%22login%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4116%5D';
async function submitSignup({ px, jar, ids, fp, tz, email, password, turnstile }) {
  const { body, boundary } = signupBody({ action: ids.action, actionKey: ids.actionKey, fp, tz, email, password, turnstile });
  return req(`${BASE}/login?mode=signup`, {
    px,
    jar,
    method: 'POST',
    headers: {
      accept: 'text/x-component',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'next-action': ids.action,
      'next-router-state-tree': RST,
      'x-deployment-id': ids.deploy,
      origin: BASE,
      referer: `${BASE}/login?mode=signup`,
    },
    body,
    timeoutMs: 60000,
  });
}
async function tzFor(px) {
  for (const url of ['https://api.ip.sb/geoip', 'https://ipinfo.io/json']) {
    try {
      const j = JSON.parse((await req(url, { px, headers: { accept: 'application/json' }, timeoutMs: 12000 })).text);
      if (j.timezone) return j.timezone;
    } catch (e) {
      /* next source */
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Page-view activity beacon the dashboard sends on every page view (HAR 2026-11-19):
 * POST, no body, accept-anything header, `origin: BASE`, `referer` = the page URL.
 * Best-effort: a failed beacon must never fail the account. Returns the status (0 on error). */
async function activity(px, jar, page) {
  try {
    const r = await req(`${BASE}/api/auth/activity?page=${encodeURIComponent(page)}`, {
      px,
      jar,
      method: 'POST',
      headers: { accept: '*/*', origin: BASE, referer: `${BASE}${page}` },
      timeoutMs: 20000,
    });
    return r.status;
  } catch (e) {
    return 0;
  }
}

// --- Free-models consent text, read live like the browser does (HAR 2026-11-19) ---
// The dashboard modal builds shown_text from two live sources and POSTs the modal's
// innerText:
//   - model_labels from GET /api/me/free-tier, joined "A, B, C and D"
//   - five sentences hardcoded in one dashboard JS chunk (module 331251: o/a/Q/p/u)
// The chunk filename is hashed per deploy, so find it by scanning the dashboard
// page's script list for the chunk holding the consent strings. consent-text.txt
// stays as a fallback when the live read fails.
const CONSENT_MARKER = 'Turning this off stops future free-route collection';
const CONSENT_OPENERS = {
  o: 'Token Harbor may keep the requests and responses you send through free models',
  a: 'Our staff may read free-route conversations',
  Q: 'We also use the free-route content you share to infer broad interest categories',
  p: 'Token Harbor does not use paid-route prompts or responses',
  u: 'Turning this off stops future free-route collection',
};
/** Read one double-quoted JS string literal starting at `opener` (escapes unescaped). */
function jsStringAt(js, opener) {
  const at = js.indexOf(opener);
  if (at < 0) return null;
  let i = at;
  let out = '';
  while (i < js.length) {
    const ch = js[i];
    if (ch === '\\') {
      out += js.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  if (i >= js.length) return null;
  try {
    return JSON.parse(`"${out}"`);
  } catch (e) {
    return out;
  }
}
function extractConsentStrings(js) {
  const s = {};
  for (const [k, opener] of Object.entries(CONSENT_OPENERS)) {
    s[k] = jsStringAt(js, opener);
    if (!s[k]) throw new Error(`consent string ${k} not found in chunk`);
  }
  return s;
}
function joinModelLabels(labels) {
  if (!labels.length) return 'selected models';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
function assembleConsentText(labels, s) {
  const first = labels.length
    ? `${joinModelLabels(labels)} ${labels.length === 1 ? 'is' : 'are'} currently available through explicit free routes.`
    : 'Selected models are available through explicit free routes, listed as Free on the Models page.';
  const p1 = `${first} ${s.o} Your consent also covers free models we add later. ${s.a} ${s.Q} ${s.p}`;
  const p2 = `Turn on free models to start using them. You can turn this off anytime. ${s.u}`;
  return `${p1}\n\n${p2}`;
}
async function fetchConsentText({ px, jar }) {
  const dash = await req(`${BASE}/dashboard`, { px, jar, headers: { accept: 'text/html' }, timeoutMs: 30000 });
  if (dash.status !== 200) throw new Error(`dashboard ${dash.status}`);
  const chunks = [...new Set(dash.text.match(/\/_next\/static\/[^"'()\s]+\.js/g) || [])];
  let strings = null;
  for (const c of chunks.slice(0, 40)) {
    try {
      const r = await req(BASE + c, { px, headers: { accept: '*/*' }, timeoutMs: 20000 });
      if (r.status === 200 && r.text.includes(CONSENT_MARKER)) {
        strings = extractConsentStrings(r.text);
        break;
      }
    } catch (e) {
      /* next chunk */
    }
  }
  if (!strings) throw new Error('consent chunk not found in dashboard scripts');
  let labels = [];
  try {
    const ft = await req(`${BASE}/api/me/free-tier`, { px, jar, headers: { accept: 'application/json' }, timeoutMs: 20000 });
    const j = JSON.parse(ft.text);
    if (Array.isArray(j.model_labels)) labels = j.model_labels;
  } catch (e) {
    /* empty labels -> the generic first sentence */
  }
  return assembleConsentText(labels, strings);
}

/** Save `email:password` for a manual browser login. One line per account,
 * deduped by e-mail; a failed write must never fail the mint. Returns true
 * when a new line was written. */
function saveAccount(email, password) {
  try {
    const line = `${email}:${password}`;
    const known = fs.existsSync(ACCOUNTS_TXT)
      ? fs.readFileSync(ACCOUNTS_TXT, 'utf8').split(/\r?\n/).map((l) => l.trim())
      : [];
    if (known.some((l) => l === line || l.startsWith(email + ':'))) return false;
    fs.appendFileSync(ACCOUNTS_TXT, line + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** One account end to end. Returns { key, steps }. */
async function mintOne({ px, pool, index, total, log }) {
  const jar = new Jar();
  const steps = {};
  const mail = await makeMailbox(px);
  const password = `Th!${rand(12)}aQ9`;
  log(`[${index}/${total}] mailbox ${mail.address} (${mail.rail})`);
  let ids;
  try {
    ids = await discover(px, jar);
  } catch (e) {
    if (!/cloudflare challenge/i.test(e.message)) throw e;
    // VPN/datacenter exits get the edge challenge instead of the form: load it
    // once in a real Chrome (same exit, same user agent) and carry the
    // browser's cookies into this session, then read the form ids over HTTP
    // as usual. Usually that includes cf_clearance; when the browser passes
    // without ever facing the interstitial there is none, and the retry
    // below finds out whether the other cookies are enough.
    log(`   cloudflare challenge — pre-solving it in the browser via ${px ? `${px.host}:${px.port}` : 'direct'}`);
    const { presolveChallenge } = require('./solver');
    const out = await presolveChallenge({ px, log, headless: !!arg('headless', false), ua: UA });
    if (!out || !out.ok) throw new Error(`cloudflare challenge not solved (${(out && out.why) || 'no response'})`);
    for (const c of out.cookies || []) jar.set(c.name, c.value);
    steps.challenge = out.clearance === false ? 'presolved-no-clearance' : 'presolved';
    if (out.clearance === false) log('   no cf_clearance from the browser — retrying discover with its cookies anyway');
    else log('   challenge pre-solved in the browser');
    ids = await discover(px, jar);
  }
  const fp = crypto.randomUUID();
  const tz = await tzFor(px);
  const pre = await req(`${BASE}/api/auth/signup-precheck?fp=${fp}`, {
    px,
    jar,
    headers: { accept: 'application/json', referer: `${BASE}/login?mode=signup` },
  });
  steps.precheck = pre.status;
  const needsHuman = /"needCaptcha"\s*:\s*true/.test(pre.text);
  log(`   precheck ${pre.status} · human check ${needsHuman ? 'required' : 'no'}`);
  let res = null;
  let session = false;
  let refusal = '';
  let askedHuman = needsHuman;
  if (!needsHuman) {
    res = await submitSignup({ px, jar, ids, fp, tz, email: mail.address, password });
    session = jar.keys().some((k) => /^sb-auth-auth-token/.test(k));
    steps.signup = res.status;
    refusal = (String(res.text).match(/"error":"([^"]{0,140})"/) || [])[1] || '';
    // Next.js flight answers with references ("error":"$17"); resolve the row.
    const ref = /^\$(\d+)$/.exec(refusal);
    if (ref) {
      const row = new RegExp('(?:^|[\s,{])' + ref[1] + ':\{"error":"([^"]{0,160})').exec(String(res.text));
      refusal = (row && row[1]) || `reference ${refusal}`;
    }
    askedHuman = /human check|needCaptcha/i.test(res.text);
    if (!session && askedHuman) log('   panel asked for a human check — replaying the signup in Chrome');
    // A plain refusal ("too many sign-ups from this network", e-mail already used)
    // is not a captcha problem: the browser cannot help, so say what the panel said.
    if (!session && !askedHuman) throw new Error(`signup refused: ${refusal || `status ${res.status}`} | ${String(res.text).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (!session) {
    // Browser fallback: the widget's token and the session come from a real page.
    const { signupInBrowser } = require('./solver');
    const out = await signupInBrowser({ px, email: mail.address, password, log, headless: !!arg('headless', false), jarCookies: jar.entries() });
    if (!out || !out.ok) {
      const hasToken = Boolean(mailtrapToken());
      throw new Error(`signup blocked (${(out && out.why) || 'no response'}) — ${hasToken ? 'the panel is refusing sign-ups from this network; retry through a fresh proxy exit (--pool)' : 'the panel asks for a mailbox it trusts; add a Mailtrap token (mailtrap.txt) and retry'}`);
    }
    for (const c of out.cookies || []) jar.set(c.name, c.value);
    steps.signup = 'browser';
    session = true;
  }
  log(`   signup ${steps.signup} · session ${session ? 'ok' : 'yok'}`);
  // The dashboard beacons every page view (HAR 2026-11-19). The CLI has no
  // send-verification-email call (signup itself sends the mail), so the beacon goes
  // at the equivalent point: session established, before the verification wait.
  steps.activityDashboard = await activity(px, jar, '/dashboard');
  log(`   activity /dashboard ${steps.activityDashboard}`);
  const link = await waitLink(mail);
  steps.link = Boolean(link);
  if (!link) throw new Error('verification link did not arrive');
  let r = await req(link, { px, jar, headers: { accept: 'text/html' } });
  steps.verify = r.status;
  log(`   verify ${r.status} ${r.headers.location || ''}`);
  // A finished inbox is dead weight: Mailtrap caps an account at 300.
  if (mail.rail === 'mailtrap' && mail.id) {
    try {
      await req(`${mail.api}/inbound/inboxes/${mail.id}`, { px: null, method: 'DELETE', headers: { authorization: `Bearer ${mail.token}`, accept: 'application/json' } });
    } catch (e) {
      /* a stuck inbox is swept by the provider later */
    }
  }
  const loc = r.headers.location;
  if (loc) await req(loc.startsWith('http') ? loc : BASE + loc, { px, jar, headers: { accept: 'text/html' } }).catch(() => {});
  let consentText;
  let consentSource = 'file';
  try {
    consentText = await fetchConsentText({ px, jar });
    consentSource = 'live';
  } catch (e) {
    consentText = fs.readFileSync(CONSENT_TEXT, 'utf8').trim();
    log(`   consent text: live read failed (${e.message.slice(0, 70)}) — using ${path.basename(CONSENT_TEXT)}`);
  }
  steps.consentSource = consentSource;
  log(`   consent text ${consentSource} (${consentText.length} chars)`);
  let consent = 0;
  for (let i = 0; i < 3; i++) {
    r = await req(`${BASE}/api/me/privacy`, {
      px,
      jar,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: BASE, referer: `${BASE}/dashboard` },
      body: JSON.stringify({ free_models_enabled: true, shown_text: consentText, screen: 'consent_modal', path: '/dashboard' }),
    });
    consent = r.status;
    if (consent === 200) break;
    await sleep(2000);
  }
  steps.consent = consent;
  log(`   consent ${consent}`);
  if (consent !== 200) throw new Error(`consent ${consent} ${r.text.slice(0, 80)} (shown_text source: ${consentSource} — the panel may have changed its consent text; open the dashboard once and press "Enable free models")`);
  steps.activityKeysBefore = await activity(px, jar, '/dashboard/api-keys');
  log(`   activity /dashboard/api-keys ${steps.activityKeysBefore}`);
  r = await req(`${BASE}/api/keys`, {
    px,
    jar,
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', origin: BASE, referer: `${BASE}/dashboard/api-keys` },
    body: JSON.stringify({ label: 'bulk' }),
  });
  steps.key = r.status;
  log(`   key ${r.status}`);
  const key = (r.text.match(/thk_live_[A-Za-z0-9_-]{20,}/) || [])[0];
  if (!key) throw new Error(`key ${r.status} ${r.text.slice(0, 120)}`);
  steps.activityKeysAfter = await activity(px, jar, '/dashboard/api-keys');
  log(`   activity /dashboard/api-keys ${steps.activityKeysAfter}`);
  // The account + key exist from here on: save the login so the account can be
  // opened manually in a browser even if the live gate below fails.
  if (saveAccount(mail.address, password)) log('   account saved to accounts.txt');
  // Live proof: two different prompts must both answer 200 with different content.
  // The key exists from here on, so *any* failure inside the gate keeps it in
  // keys-unverified.txt instead of throwing the account away.
  const answers = [];
  const gateStart = Date.now();
  const GATE_BUDGET_MS = 480000; // a dead pool must not hang one account forever
  const keepKey = () => {
    try {
      fs.appendFileSync('keys-unverified.txt', `${key} ${mail.address}\n`);
    } catch (e) {
      /* the log line below still names the last four characters */
    }
  };
  try {
    for (const q of ['Reply with exactly: PONG', 'What is 17+25? Reply with the number only.']) {
      let ok = false;
      for (const model of [FREE_MODEL, FREE_FALLBACK]) {
        let c = null;
        for (let t = 0; t < 6 && !c; t++) {
          if (Date.now() - gateStart > GATE_BUDGET_MS) throw new Error('live gate budget exhausted');
          try {
            c = await req(`${BASE}/v1/chat/completions`, {
              px: STRICT ? (pool && pool.length ? pool[Math.floor(Math.random() * pool.length)] : null) : t < 2 && pool && pool.length ? pool[Math.floor(Math.random() * pool.length)] : null,
              method: 'POST',
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
              body: JSON.stringify({ model, messages: [{ role: 'user', content: q }], max_tokens: 64 }),
              timeoutMs: 60000,
            });
          } catch (e) {
            if (t === 5) throw e;
            continue;
          }
          // The panel also answers a rate limit with HTTP 200 + {"error":{"code":"rate_limit_exceeded","message":"… in N s."}}
          // (measured 2026-11-09), so a status check alone burns every retry on an exhausted window.
          const limited = c.status === 429 || (c.status === 200 && /"code"\s*:\s*"rate_limit_exceeded"/.test(c.text));
          if (limited) {
            const wait = Math.max(25, Number((c.text.match(/in (\d+) s/) || [])[1] || 25));
            log(`   rate limited — waiting ${wait}s`);
            await sleep(wait * 1000);
            c = null;
          }
        }
        if (!c) throw new Error('chat gate: still rate limited');
        const j = (() => {
          try {
            return JSON.parse(c.text);
          } catch (e) {
            return null;
          }
        })();
        const text = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
        if (c.status === 200 && text.trim()) {
          answers.push(text.trim());
          ok = true;
          break;
        }
        steps.lastChat = `${c.status} ${c.text.slice(0, 90)}`;
      }
      if (!ok) throw new Error(`chat-200 failed: ${steps.lastChat}`);
    }
  } catch (e) {
    keepKey();
    throw new Error(`${e.message} — key …${key.slice(-4)} saved to keys-unverified.txt`);
  }
  if (answers[0] === answers[1]) {
    keepKey();
    throw new Error('chat answered the same text to two different prompts — key saved to keys-unverified.txt');
  }
  return { key, email: mail.address, steps };
}

function keysFile() {
  if (!fs.existsSync(OUT)) return [];
  return fs
    .readFileSync(OUT, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
function printHelp() {
  console.log(`tokenharbor-bulk-apikey — mint Token Harbor API keys

  node src/cli.js                 interactive: asks how many keys
  node src/cli.js --auto --count 5
  node src/cli.js --auto --count 5 --pool proxies.txt
  node src/cli.js --verify        re-check every key in keys.txt with a live chat call
  node src/cli.js --models        print the free model list

Options
  --count <n>     how many accounts/keys (default 1)
  --pool <file>   proxy list, one exit per line (http://, socks5://, host:port).
                  Without it the CLI runs direct.
  --headless      run the fallback browser headless (default: off-screen window)
  --timeout <s>   per-account timeout (default 300)
  --help          this text

The CLI writes only the keys that pass a live chat-200 with two different prompts.`);
}
async function verifyKeys(px, log) {
  const keys = keysFile();
  if (!keys.length) throw new Error(`no API keys in ${OUT}`);
  let live = 0;
  for (const key of keys) {
    const r = await req(`${BASE}/v1/chat/completions`, {
      px,
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 16 }),
      timeoutMs: 120000,
    }).catch((e) => ({ status: 0, text: e.message }));
    const ok = r.status === 200;
    if (ok) live++;
    else fs.appendFileSync('keys-dead.txt', `${key} ${new Date().toISOString().slice(0, 10)} ${r.status}\n`);
    log(`${key.slice(0, 14)}… ${ok ? 'live' : `dead (${r.status}) ${String(r.text).slice(0, 70)}`}`);
  }
  log(`${live}/${keys.length} live`);
}
(async () => {
  const log = (...a) => console.log(...a);
  if (arg('help', false)) return printHelp();
  const px = pool();
  if (STRICT && !px) throw new Error('--strict-proxy needs a proxy pool (--pool <file> or proxies.txt)');
  const one = () => px && px[Math.floor(Math.random() * px.length)];
  if (arg('models', false)) {
    const r = await req(`${BASE}/v1/models`, { px: one() || null });
    const list = (() => {
      try {
        return (JSON.parse(r.text).data || []).filter((m) => /:free$/.test(m.id)).map((m) => m.id);
      } catch (e) {
        return [];
      }
    })();
    console.log(list.length ? list.join('\n') : `GET /v1/models → ${r.status} (a key is required)`);
    return;
  }
  if (arg('screen', false)) {
    const list = px || [];
    if (!list.length) throw new Error('--screen needs --pool <file>');
    let live = 0;
    let challenged = 0;
    for (const p of list) {
      const r = await req(BASE + '/login?mode=signup', { px: p, headers: { accept: 'text/html' }, timeoutMs: 20000 }).catch((e) => ({ status: 0, text: e.message }));
      const state = classifyScreen(r);
      if (state === 'live') live++;
      if (state === 'challenged') challenged++;
      // A challenged exit speaks for itself; only a dead one needs the reason.
      log(`${p.host}:${p.port} ${state}${state === 'dead' ? ' ' + String(r.text || r.status).slice(0, 60) : ''}`);
    }
    log(`${live}/${list.length} live, ${challenged} challenged (cloudflare), ${list.length - live - challenged} dead`);
    if (challenged) log('challenged exits are not dead: minting pre-solves the challenge in Chrome');
    return;
  }
  if (arg('verify', false)) {
    await verifyKeys(one() || null, log);
    return;
  }
  const auto = arg('auto', false) || !process.stdin.isTTY;
  let count = parseInt(arg('count', '0'), 10);
  if (!count) {
    if (auto) count = 1;
    else {
      process.stdout.write('How many keys? [1]: ');
      const answer = await new Promise((res) => process.stdin.once('data', (d) => res(String(d).trim())));
      count = parseInt(answer, 10) || 1;
    }
  }
  if (!fs.existsSync('proxies.txt') && !arg('pool', null)) log('proxy: direct (no proxies.txt, no --pool)');
  let minted = 0;
  for (let i = 1; i <= count; i++) {
    let r = null;
    let lastErr = null;
    // A pool line can die (or start demanding auth) between two requests: retry
    // the same account on other exits instead of losing the slot.
    for (let attempt = 1; attempt <= Math.max(1, Math.min(12, (px || []).length || 1)); attempt++) {
      try {
        r = await mintOne({ px: one() || null, pool: px, index: i, total: count, log });
        break;
      } catch (e) {
        lastErr = e;
        const retryable = /proxy CONNECT|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|tz unreadable|create another account from this network|Too many sign-ups|signup refused: status 200|cloudflare challenge/i.test(e.message);
        if (!retryable || !px) break;
        log(`   exit failed (${e.message.slice(0, 120)}) — retrying on another exit`);
      }
    }
    try {
      if (!r) throw lastErr || new Error('mint failed');
      const known = keysFile();
      if (!known.includes(r.key)) fs.appendFileSync(OUT, r.key + '\n');
      fs.appendFileSync('accounts.jsonl', JSON.stringify({ at: new Date().toISOString(), email: r.email, key_last4: r.key.slice(-4), steps: r.steps }) + '\n');
      minted++;
      log(`  ✔ ${r.key.slice(0, 14)}… saved to keys.txt (${minted}/${count})`);
    } catch (e) {
      log(`  ✖ ${e.message}`);
    }
  }
  log(`done — ${minted}/${count} keys minted`);
  if (!minted) process.exitCode = 1;
})().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
