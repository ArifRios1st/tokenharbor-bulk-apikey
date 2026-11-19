'use strict';
/*
 * diag-browser-proxy.js — is the presolve slowness the proxy or our code?
 *
 *   node scripts/diag-browser-proxy.js --pool proxies.txt [--exit 0]
 *   node scripts/diag-browser-proxy.js --proxy host:1080
 *   node scripts/diag-browser-proxy.js --proxy socks5://user:pass@host:1080
 *
 * --pool reads a real pool line and parses it exactly like the CLI does
 * (bare host:port is an HTTP proxy; socks5:// is SOCKS5; user:pass is kept).
 * Credentials are never printed.
 *
 * Phases:
 *   A. Raw fetch over the parsed proxy (SOCKS5 handshake or HTTP CONNECT,
 *      then TLS + GET) with per-stage timings.
 *   A2. The same raw fetch, but THROUGH the local proxy Chrome uses. If A
 *      works and A2 fails, the forwarding proxy is broken on this machine;
 *      if A2 works and B fails, the break is between Chrome and localhost.
 *   B. Browser + the same proxy: example.com, then target.
 *   C. If B is slow: browser + proxy with the resolved IPv4 literal, so a
 *      slow/broken DNS or IPv6 path for the proxy hostname is ruled out.
 *   D. If C is still slow: browser + proxy with --disable-http2, so a broken
 *      HTTP/2 path through the exit is ruled out.
 *   E. Browser direct (no proxy): target.
 *
 * The verdict at the end names the slow part from the timings. Nothing here
 * mints anything; it only loads pages and reads their titles.
 */
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const solver = require('../src/solver.js');
const { startLocalProxy } = require('../src/local-proxy.js');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const POOL = arg('--pool');
const EXIT = Number(arg('--exit', '0'));
const PROXY = arg('--proxy');
const TARGET = arg('--target', 'https://tokenharbor.ai/login?mode=signup');
const EXAMPLE = arg('--example', 'https://example.com');
const GOTO_TIMEOUT = Number(arg('--goto-timeout', '30000'));
const RAW_TIMEOUT = Number(arg('--raw-timeout', '20000'));

const s = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Same parsing as cli.js parseProxy — keep the two in sync. */
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

function readPool(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Read exact byte counts off a socket, for the SOCKS handshake. */
class Reader {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.onData = (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.pump();
    };
    sock.on('data', this.onData);
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        this.waiters.shift();
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.resolve(out);
      } else break;
    }
  }
  read(n) {
    return new Promise((resolve) => {
      this.waiters.push({ n, resolve });
      this.pump();
    });
  }
  detach() {
    this.sock.removeListener('data', this.onData);
  }
}

function onceWithTimeout(emitter, event, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    const onErr = (e) => {
      clearTimeout(timer);
      reject(e);
    };
    emitter.once(event, () => {
      clearTimeout(timer);
      emitter.removeListener('error', onErr);
      resolve();
    });
    emitter.once('error', onErr);
  });
}

/** TLS + HTTP/1.1 GET over an already-tunneled socket. Shared by both phases A. */
async function tlsGet(sock, { host, path, timeoutMs, stages, t0 }) {
  const tlsSock = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] });
  await onceWithTimeout(tlsSock, 'secureConnect', timeoutMs, 'TLS handshake');
  stages.tlsMs = Date.now() - t0;
  tlsSock.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nuser-agent: diag/1.0\r\naccept: text/html\r\nconnection: close\r\n\r\n`);
  const head = await new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('no response bytes within timeout')), timeoutMs);
    tlsSock.on('data', (c) => {
      if (stages.firstByteMs === undefined) stages.firstByteMs = Date.now() - t0;
      data = Buffer.concat([data, c]);
      if (data.length > 8192 || data.includes('\r\n\r\n')) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    tlsSock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    tlsSock.once('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
  return {
    status: head.toString('utf8', 0, 200).split('\r\n')[0],
    bytes: head.length,
    challenge: head.includes('Just a moment') || head.includes('cf-challenge'),
    alpn: tlsSock.alpnProtocol || null,
  };
}

/** SOCKS5 (no-auth, or username/password subnegotiation) + TLS + GET. */
async function rawFetchViaSocks({ proxyHost, proxyPort, host, port = 443, path = '/', username = null, password = null, timeoutMs = 20000 }) {
  const t0 = Date.now();
  const stages = {};
  const sock = net.connect(proxyPort, proxyHost);
  const finish = (r) => {
    try {
      sock.destroy();
    } catch (e) {
      /* already gone */
    }
    return { ...r, stages, ms: Date.now() - t0 };
  };
  try {
    await onceWithTimeout(sock, 'connect', timeoutMs, 'TCP connect to proxy');
    stages.tcpMs = Date.now() - t0;
    const reader = new Reader(sock);
    const methods = username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const hs = await reader.read(2);
    if (hs[0] !== 0x05 || hs[1] === 0xff) {
      return finish({ ok: false, stage: 'socks-handshake', error: `proxy picked method ${hs[1]} (no acceptable auth — credentials required?)` });
    }
    if (hs[1] === 0x02) {
      const u = Buffer.from(username || '');
      const p = Buffer.from(password || '');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const ar = await reader.read(2);
      if (ar[0] !== 0x01 || ar[1] !== 0x00) {
        return finish({ ok: false, stage: 'socks-auth', error: 'proxy rejected the username/password' });
      }
      stages.authMs = Date.now() - t0;
    }
    stages.socksMs = Date.now() - t0;
    const hostBuf = Buffer.from(host);
    sock.write(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([port >> 8, port & 0xff])])
    );
    const rep = await reader.read(4);
    if (rep[0] !== 0x05 || rep[1] !== 0x00) {
      return finish({ ok: false, stage: 'socks-connect', error: `proxy CONNECT failed, rep=${rep[1]}` });
    }
    const atyp = rep[3];
    const restLen = atyp === 0x01 ? 6 : atyp === 0x04 ? 18 : atyp === 0x03 ? (await reader.read(1))[0] + 2 : 0;
    if (restLen) await reader.read(restLen);
    stages.connectMs = Date.now() - t0;
    reader.detach();
    const r = await tlsGet(sock, { host, path, timeoutMs, stages, t0 });
    return finish({ ok: true, ...r });
  } catch (e) {
    return finish({ ok: false, stage: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 160) });
  }
}

/** HTTP CONNECT tunnel (+ Proxy-Authorization when given) + TLS + GET. */
async function rawFetchViaHttpConnect({ proxyHost, proxyPort, host, port = 443, path = '/', username = null, password = null, timeoutMs = 20000 }) {
  const t0 = Date.now();
  const stages = {};
  const sock = net.connect(proxyPort, proxyHost);
  const finish = (r) => {
    try {
      sock.destroy();
    } catch (e) {
      /* already gone */
    }
    return { ...r, stages, ms: Date.now() - t0 };
  };
  try {
    await onceWithTimeout(sock, 'connect', timeoutMs, 'TCP connect to proxy');
    stages.tcpMs = Date.now() - t0;
    const auth = username ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}\r\n` : '';
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const head = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('no CONNECT response within timeout')), timeoutMs);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]);
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(buf.toString('latin1'));
        }
      };
      sock.on('data', onData);
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    stages.connectMs = Date.now() - t0;
    const statusLine = head.split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 200/i.test(statusLine)) {
      return finish({ ok: false, stage: 'http-connect', error: `proxy CONNECT answered: ${statusLine}` });
    }
    const r = await tlsGet(sock, { host, path, timeoutMs, stages, t0 });
    return finish({ ok: true, ...r });
  } catch (e) {
    return finish({ ok: false, stage: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 160) });
  }
}

async function browserGoto({ px, url, extraArgs = [], label, timeoutMs = 30000 }) {
  const t0 = Date.now();
  let browser = null;
  try {
    browser = await solver.launchBrowser({ px, headless: false, log: (m) => console.log(`      ${m.trim()}`), extraArgs });
    const launchedMs = Date.now() - t0;
    const page = await browser.newPage();
    await solver.proxyAuth(page, px, (m) => console.log(`      ${m.trim()}`));
    const g0 = Date.now();
    // page.title() can hang on a wedged page long after goto gave up; cap it
    // so the reported goto time stays honest.
    const titleOf = () =>
      Promise.race([page.title().catch(() => ''), new Promise((r) => setTimeout(() => r(''), 5000))]);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const title = await titleOf();
      return { ok: true, label, launchedMs, gotoMs: Date.now() - g0, title: String(title).slice(0, 60), url: page.url() };
    } catch (e) {
      const title = await titleOf();
      return { ok: false, label, launchedMs, gotoMs: Date.now() - g0, error: String(e.message).split('\n')[0].slice(0, 120), title: String(title).slice(0, 60), url: page.url() };
    }
  } catch (e) {
    return { ok: false, label, error: `launch failed: ${String(e.message).split('\n')[0].slice(0, 140)}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function showBrowserResult(r) {
  if (r.error && !('gotoMs' in r)) {
    console.log(`    ${r.label}: FAILED — ${r.error}`);
    return;
  }
  const base = `    ${r.label}: launch ${s(r.launchedMs)}, goto ${s(r.gotoMs)}`;
  if (r.ok) console.log(`${base} — OK, title="${r.title}"`);
  else console.log(`${base} — FAILED (${r.error}) title="${r.title}" url=${r.url}`);
}

async function main() {
  console.log('diag-browser-proxy');
  console.log(`  target: ${TARGET}`);
  console.log(`  browser: ${solver.findBrowserExecutable() || '(channel chrome or none found)'}`);
  const targetUrl = new URL(TARGET);
  const results = {};

  let px = null;
  if (POOL) {
    let lines;
    try {
      lines = readPool(POOL);
    } catch (e) {
      console.log(`cannot read pool file ${POOL}: ${String(e.message).split('\n')[0]}`);
      process.exit(1);
    }
    if (!lines.length) {
      console.log(`pool ${POOL} is empty`);
      process.exit(1);
    }
    if (EXIT < 0 || EXIT >= lines.length) {
      console.log(`--exit ${EXIT} out of range (pool has ${lines.length} lines)`);
      process.exit(1);
    }
    px = parseProxy(lines[EXIT]);
    console.log(`  pool: ${POOL} line ${EXIT + 1}/${lines.length}`);
  } else if (PROXY) {
    try {
      px = parseProxy(PROXY);
    } catch (e) {
      console.log(`bad --proxy value: ${e.message} (want host:port or socks5://[user:pass@]host:port)`);
      process.exit(1);
    }
  }
  if (px) {
    console.log(`  proxy: ${px.protocol}://${px.host}:${px.port} (auth: ${px.username ? 'yes' : 'no'})`);
  }

  const noBrowser = (r) => r && r.error && r.error.startsWith('launch failed');

  // Phase A — raw path, staged, over the parsed proxy.
  if (px) {
    const isSocks = px.protocol.startsWith('socks');
    console.log(`\n[A] raw ${isSocks ? 'SOCKS5' : 'HTTP CONNECT'}+TLS GET via ${px.host}:${px.port}`);
    const rawArgs = { proxyHost: px.host, proxyPort: px.port, host: targetUrl.hostname, path: `${targetUrl.pathname}${targetUrl.search}`, username: px.username, password: px.password, timeoutMs: RAW_TIMEOUT };
    const raw = isSocks ? await rawFetchViaSocks(rawArgs) : await rawFetchViaHttpConnect(rawArgs);
    results.raw = raw;
    if (raw.ok) {
      console.log(`    OK in ${s(raw.ms)} — ${raw.status} (${raw.bytes} bytes, ALPN=${raw.alpn || 'none'}, challenge=${raw.challenge})`);
    } else {
      console.log(`    FAILED at ${raw.stage} after ${s(raw.ms)} — ${raw.error}`);
    }
    const st = raw.stages;
    const show = (v) => (v !== undefined ? s(v) : '—');
    console.log(`    stages: tcp ${show(st.tcpMs)}, socks ${show(st.socksMs)}, auth ${show(st.authMs)}, connect ${show(st.connectMs)}, tls ${show(st.tlsMs)}, first-byte ${show(st.firstByteMs)}`);
  } else {
    console.log('\n[A] skipped (no --pool or --proxy given)');
  }

  // Phase A2 — the same raw fetch, but THROUGH the local proxy Chrome uses.
  if (px && px.protocol.startsWith('socks') && px.username) {
    console.log('\n[A2] raw fetch THROUGH the local proxy (same path Chrome takes)');
    const local = await startLocalProxy(px, (m) => console.log(`      ${m.trim()}`));
    try {
      const via = await rawFetchViaHttpConnect({ proxyHost: '127.0.0.1', proxyPort: local.port, host: targetUrl.hostname, path: `${targetUrl.pathname}${targetUrl.search}`, timeoutMs: RAW_TIMEOUT });
      results.viaLocal = via;
      if (via.ok) console.log(`    OK in ${s(via.ms)} — ${via.status} (${via.bytes} bytes, challenge=${via.challenge})`);
      else console.log(`    FAILED at ${via.stage} after ${s(via.ms)} — ${via.error}`);
    } finally {
      await local.close();
    }
  }

  // Phase B — browser + the same proxy, as real runs do.
  if (px) {
    console.log(`\n[B] browser + proxy ${px.host}:${px.port} (${px.protocol})`);
    const ex = await browserGoto({ px, url: EXAMPLE, label: 'example.com', timeoutMs: GOTO_TIMEOUT });
    showBrowserResult(ex);
    const tg = await browserGoto({ px, url: TARGET, label: 'target', timeoutMs: GOTO_TIMEOUT });
    showBrowserResult(tg);
    results.browserProxy = tg;
    results.browserProxyExample = ex;

    if (noBrowser(tg)) {
      console.log('\n(no browser to test with — skipping phases C, D, E)');
      results.noBrowser = true;
    } else {
      // Phase C — same proxy by resolved IPv4, if B was slow.
      if (!tg.ok || tg.gotoMs > 15000) {
        const ip = await dns.promises.lookup(px.host, { family: 4 }).then((r) => r.address).catch(() => null);
        if (ip && ip !== px.host) {
          console.log(`\n[C] browser + proxy ${ip}:${px.port} (resolved IPv4, DNS out of the way)`);
          const tgIp = await browserGoto({ px: { ...px, host: ip }, url: TARGET, label: 'target via IP', timeoutMs: GOTO_TIMEOUT });
          showBrowserResult(tgIp);
          results.browserProxyIp = tgIp;
        } else {
          console.log('\n[C] skipped (could not resolve proxy hostname to IPv4)');
        }
      }

      // Phase D — HTTP/2 off, if still slow.
      const last = results.browserProxyIp || results.browserProxy;
      if (!last.ok || last.gotoMs > 15000) {
        console.log('\n[D] browser + proxy with --disable-http2');
        const tgH1 = await browserGoto({ px, url: TARGET, label: 'target, http/1.1 only', timeoutMs: GOTO_TIMEOUT, extraArgs: ['--disable-http2'] });
        showBrowserResult(tgH1);
        results.browserProxyH1 = tgH1;
      }
    }
  }

  // Phase E — browser direct.
  if (!results.noBrowser) {
    console.log('\n[E] browser direct (no proxy)');
    const direct = await browserGoto({ px: null, url: TARGET, label: 'target direct', timeoutMs: GOTO_TIMEOUT });
    showBrowserResult(direct);
    results.direct = direct;
  } else {
    console.log('\n[E] skipped (no browser)');
  }

  // Verdict.
  console.log('\nVERDICT');
  if (results.noBrowser || (results.direct && noBrowser(results.direct))) {
    console.log('  No usable browser on this machine — install Chrome or Brave, or run: npx puppeteer browsers install chrome');
    return;
  }
  const raw = results.raw;
  const via = results.viaLocal;
  const bp = results.browserProxy;
  const bIp = results.browserProxyIp;
  const bH1 = results.browserProxyH1;
  const needsAuth =
    (raw && raw.stage === 'socks-handshake' && /method 255/.test(raw.error || '')) ||
    (raw && raw.stage === 'http-connect' && / 407/.test(raw.error || ''));
  if (needsAuth) {
    console.log('  This exit requires a username/password and none was given. The CLI and the browser both support it — put credentials in the pool line, e.g. socks5://user:pass@host:1080 (URL-encode special characters in the password), then re-run this diag.');
  } else if (raw && !raw.ok) {
    console.log('  The proxy itself fails the raw fetch — the exit (or the proxy path) is the problem, not the browser code.');
  } else if (via && !via.ok) {
    console.log('  The raw fetch works but the same fetch THROUGH the local proxy fails — the forwarding proxy is broken on this machine (see the proxy log lines above).');
  } else if (raw && raw.ms > 10000) {
    console.log(`  The raw fetch alone takes ${s(raw.ms)} — the exit is slow for everything. The browser needs several round trips through it, so it blows past every timeout. Try another exit.`);
  } else if (bp && !bp.ok && directOk(results.direct)) {
    if (via && via.ok) console.log('  The local proxy fetches fine but Chrome hangs through it — the exit and the forwarding path are both fine; the break is inside the browser. Check the proxy log timestamps: tunnels closing right after the handshake means the page requests never left Chrome.');
    else if (bIp && bIp.ok) console.log('  Browser+proxy fails but direct works AND the IPv4-literal proxy works — the proxy hostname resolution (DNS/IPv6) is the slow part.');
    else if (bH1 && bH1.ok) console.log('  Browser+proxy fails but direct works AND --disable-http2 fixes it — HTTP/2 through this exit is broken. The fix is launching with --disable-http2.');
    else console.log('  Browser+proxy fails but direct works — the browser cannot use this exit. Check the local-proxy log lines above: no +conn lines means Chrome never reached the localhost proxy; upstream FAILED means the tunnel to the exit is broken.');
  } else if (bp && !bp.ok && !directOk(results.direct)) {
    console.log('  The browser is slow even direct — not the proxy. Browser, machine, or network outside the proxy.');
  } else if (bp && bp.ok && directOk(results.direct)) {
    console.log('  Everything is fast right now — the slowness does not reproduce on this exit at this moment. Try the exit that was slow, or re-run when it happens.');
  } else if (!bp && directOk(results.direct)) {
    console.log('  Direct browsing works; re-run with --pool to test an exit.');
  } else {
    console.log('  Mixed results — compare the timings above; the slow stage names the culprit.');
  }
}

function directOk(d) {
  return d && d.ok;
}

if (require.main === module) {
  main().catch((e) => {
    console.error('diag failed:', e);
    process.exit(1);
  });
}

module.exports = { rawFetchViaSocks, rawFetchViaHttpConnect, browserGoto, parseProxy };
