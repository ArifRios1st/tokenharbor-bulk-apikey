'use strict';
/*
 * diag-browser-proxy.js — is the presolve slowness the proxy or our code?
 *
 *   node scripts/diag-browser-proxy.js --proxy lax.socks.ipvanish.com:1080
 *   node scripts/diag-browser-proxy.js --proxy host:port --target https://tokenharbor.ai/login?mode=signup
 *
 * Phases:
 *   A. Raw SOCKS5 + TLS GET (the CLI's own path) with per-stage timings:
 *      TCP connect, SOCKS handshake, CONNECT, TLS handshake, first byte.
 *   B. Browser + proxy (hostname, as real runs do): example.com, then target.
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
const net = require('net');
const tls = require('tls');
const solver = require('../src/solver.js');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PROXY = arg('--proxy');
const TARGET = arg('--target', 'https://tokenharbor.ai/login?mode=signup');
const EXAMPLE = arg('--example', 'https://example.com');
const GOTO_TIMEOUT = Number(arg('--goto-timeout', '30000'));
const RAW_TIMEOUT = Number(arg('--raw-timeout', '20000'));

const s = (ms) => `${(ms / 1000).toFixed(1)}s`;

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

/** Minimal SOCKS5 (no auth) + TLS + HTTP/1.1 GET, mirroring the CLI's tunnel. */
async function rawFetchViaSocks({ proxyHost, proxyPort, host, port = 443, path = '/', timeoutMs = 20000 }) {
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
    sock.write(Buffer.from([0x05, 0x01, 0x00])); // VER, 1 method, no auth
    const hs = await reader.read(2);
    if (hs[0] !== 0x05 || hs[1] !== 0x00) {
      return finish({ ok: false, stage: 'socks-handshake', error: `proxy picked method ${hs[1]} (auth required?)` });
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
    const tlsSock = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] });
    await onceWithTimeout(tlsSock, 'secureConnect', timeoutMs, 'TLS handshake');
    stages.tlsMs = Date.now() - t0;
    tlsSock.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nuser-agent: diag/1.0\r\naccept: text/html\r\nconnection: close\r\n\r\n`);
    const head = await new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('no response bytes within timeout')), timeoutMs);
      tlsSock.on('data', (c) => {
        if (!stages.firstByteMs) stages.firstByteMs = Date.now() - t0;
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
    const status = head.toString('utf8', 0, 200).split('\r\n')[0];
    const challenge = head.includes('Just a moment') || head.includes('cf-challenge');
    return finish({ ok: true, status, bytes: head.length, challenge, alpn: tlsSock.alpnProtocol || null });
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
    const g0 = Date.now();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const title = await page.title().catch(() => '');
      return { ok: true, label, launchedMs, gotoMs: Date.now() - g0, title: String(title).slice(0, 60), url: page.url() };
    } catch (e) {
      const title = await page.title().catch(() => '');
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

  let proxyHost = null;
  let proxyPort = 1080;
  if (PROXY) {
    const m = PROXY.match(/^(?:socks5?:\/\/)?([A-Za-z0-9._-]+)(?::(\d+))?$/);
    if (!m) {
      console.log(`bad --proxy value: ${PROXY} (want host:port)`);
      process.exit(1);
    }
    proxyHost = m[1];
    proxyPort = Number(m[2] || 1080);
  }

  // Phase A — raw path, staged.
  if (proxyHost) {
    console.log(`\n[A] raw SOCKS5+TLS GET via ${proxyHost}:${proxyPort}`);
    const raw = await rawFetchViaSocks({ proxyHost, proxyPort, host: targetUrl.hostname, path: `${targetUrl.pathname}${targetUrl.search}`, timeoutMs: RAW_TIMEOUT });
    results.raw = raw;
    if (raw.ok) {
      console.log(`    OK in ${s(raw.ms)} — ${raw.status} (${raw.bytes} bytes, ALPN=${raw.alpn || 'none'}, challenge=${raw.challenge})`);
    } else {
      console.log(`    FAILED at ${raw.stage} after ${s(raw.ms)} — ${raw.error}`);
    }
    const st = raw.stages;
    console.log(`    stages: tcp ${st.tcpMs !== undefined ? s(st.tcpMs) : '—'}, socks ${st.socksMs !== undefined ? s(st.socksMs) : '—'}, connect ${st.connectMs !== undefined ? s(st.connectMs) : '—'}, tls ${st.tlsMs !== undefined ? s(st.tlsMs) : '—'}, first-byte ${st.firstByteMs !== undefined ? s(st.firstByteMs) : '—'}`);
  } else {
    console.log('\n[A] skipped (no --proxy given)');
  }

  const noBrowser = (r) => r && r.error && r.error.startsWith('launch failed');

  // Phase B — browser + proxy, hostname, as real runs do.
  if (proxyHost) {
    console.log(`\n[B] browser + proxy ${proxyHost}:${proxyPort} (hostname)`);
    const px = { protocol: 'socks5:', host: proxyHost, port: proxyPort };
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
        const ip = await dns.promises.lookup(proxyHost, { family: 4 }).then((r) => r.address).catch(() => null);
        if (ip && ip !== proxyHost) {
          console.log(`\n[C] browser + proxy ${ip}:${proxyPort} (resolved IPv4, DNS out of the way)`);
          const tgIp = await browserGoto({ px: { protocol: 'socks5:', host: ip, port: proxyPort }, url: TARGET, label: 'target via IP', timeoutMs: GOTO_TIMEOUT });
          showBrowserResult(tgIp);
          results.browserProxyIp = tgIp;
        } else {
          console.log('\n[C] skipped (could not resolve proxy hostname to IPv4)');
        }
      }

      // Phase D — HTTP/2 off, if still slow.
      const last = results.browserProxyIp || results.browserProxy;
      if (!last.ok || last.gotoMs > 15000) {
        console.log('\n[D] browser + proxy (hostname) with --disable-http2');
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
  const bp = results.browserProxy;
  const bIp = results.browserProxyIp;
  const bH1 = results.browserProxyH1;
  if (raw && !raw.ok) {
    console.log('  The proxy itself fails the raw fetch — the exit (or the proxy path) is the problem, not the browser code.');
  } else if (raw && raw.ms > 10000) {
    console.log(`  The raw fetch alone takes ${s(raw.ms)} — the exit is slow for everything. The browser needs several round trips through it, so it blows past every timeout. Try another exit.`);
  } else if (bp && !bp.ok && direct.ok) {
    if (bIp && bIp.ok) console.log('  Browser+proxy fails but direct works AND the IPv4-literal proxy works — the proxy hostname resolution (DNS/IPv6) is the slow part.');
    else if (bH1 && bH1.ok) console.log('  Browser+proxy fails but direct works AND --disable-http2 fixes it — HTTP/2 through this exit is broken. The fix is launching with --disable-http2.');
    else console.log('  Browser+proxy fails but direct works — the browser path through this exit is the problem (per-connection slowness the CLI avoids with one request). Try another exit, or the pool needs faster exits.');
  } else if (bp && !bp.ok && !direct.ok) {
    console.log('  The browser is slow even direct — not the proxy. Browser, machine, or network outside the proxy.');
  } else if (bp && bp.ok && direct.ok) {
    console.log('  Everything is fast right now — the slowness does not reproduce on this exit at this moment. Try the exit that was slow, or re-run when it happens.');
  } else {
    console.log('  Mixed results — compare the timings above; the slow stage names the culprit.');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('diag failed:', e);
    process.exit(1);
  });
}

module.exports = { rawFetchViaSocks, browserGoto };
