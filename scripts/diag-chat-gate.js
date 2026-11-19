'use strict';
/*
 * diag-chat-gate.js — why did the live gate time out?
 *
 *   node scripts/diag-chat-gate.js [--pool proxies.txt] [--exit 0] [--key-file keys-unverified.txt] [--model deepseek-v4.1-flash:free] [--timeout 300]
 *
 * Reads the first key from keys-unverified.txt (fallback: keys.txt) — the key
 * itself is never printed, only its last four characters — opens the same
 * browser client the mint uses, and calls /v1/chat/completions with the
 * gate's exact prompt, streaming the response body and logging when the
 * headers arrive, when each chunk arrives, and whether the stream ever ends.
 *
 * That separates the three ways a gate call can die:
 *   - slow start: headers arrive late (queued / slow model)
 *   - slow stream: chunks trickle in but the answer never completes
 *   - stuck: headers arrive, then nothing — or nothing arrives at all
 *
 * Nothing here mints anything; it only spends one chat call on a saved key.
 */
const fs = require('fs');
const solver = require('../src/solver.js');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const POOL = arg('--pool');
const EXIT = Number(arg('--exit', '0'));
const KEY_FILE = arg('--key-file');
const MODEL = arg('--model', 'deepseek-v4.1-flash:free');
const TIMEOUT_S = Number(arg('--timeout', '300'));
const HEADLESS = argv.includes('--headless');

const BASE = 'https://tokenharbor.ai';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

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

/** First key found: keys-unverified.txt lines are "key email", keys.txt lines are bare keys. */
function readKey() {
  const files = KEY_FILE ? [KEY_FILE] : ['keys-unverified.txt', 'keys.txt'];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const tok = line.trim().split(/\s+/).find((t) => t.startsWith('thk_live_'));
      if (tok) return { key: tok, file: f };
    }
  }
  return null;
}

/**
 * Runs inside the page (client.evaluate): the gate's exact chat call, with
 * the body read as a stream so the timing of every chunk is visible.
 * Self-contained on purpose: puppeteer serializes this function into the
 * page, so it must not close over anything. Exported so the VM tests can run
 * it against a local server with Node's own fetch.
 */
async function probeChatInPage({ url, key, model, timeoutMs }) {
  const t0 = Date.now();
  const events = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let firstBytes = '';
  let bodyText = '';
  let total = 0;
  const dec = new TextDecoder();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 64 }),
      credentials: 'include',
      signal: ctrl.signal,
    });
    events.push({ at: Date.now() - t0, ev: 'headers', status: r.status, ct: r.headers.get('content-type') || '' });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        events.push({ at: Date.now() - t0, ev: 'done', total });
        break;
      }
      total += value.length;
      bodyText += dec.decode(value, { stream: true });
      if (events.length < 40) events.push({ at: Date.now() - t0, ev: 'chunk', bytes: value.length, total });
    }
    bodyText += dec.decode();
    firstBytes = bodyText.slice(0, 200);
    return { ok: true, events, firstBytes, bodyText, total };
  } catch (e) {
    events.push({ at: Date.now() - t0, ev: 'error', name: (e && e.name) || 'error', message: String((e && e.message) || e).slice(0, 120) });
    bodyText += dec.decode();
    firstBytes = bodyText.slice(0, 200);
    return { ok: false, events, firstBytes, bodyText, total };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const found = readKey();
  if (!found) {
    console.log('no key found in keys-unverified.txt or keys.txt — mint one first (or pass --key-file <file>)');
    process.exit(1);
  }
  const { key } = found;
  console.log(`diag-chat-gate\n  key: …${key.slice(-4)} (from ${found.file})\n  model: ${MODEL}\n  timeout: ${TIMEOUT_S}s`);
  let px = null;
  if (POOL) {
    const lines = readPool(POOL);
    const line = lines[EXIT] || lines[0];
    px = parseProxy(line);
    console.log(`  proxy: ${px.host}:${px.port} (pool line ${EXIT + 1}/${lines.length})`);
  } else {
    console.log('  proxy: direct');
  }
  const log = (...a) => console.log(...a);
  // A diagnostic keeps the full proxy trail: verbose is always on here.
  const client = await solver.openBrowserClient({ px, log, headless: HEADLESS, ua: UA, verbose: true });
  try {
    const res = await client.evaluate(probeChatInPage, { url: `${BASE}/v1/chat/completions`, key, model: MODEL, timeoutMs: TIMEOUT_S * 1000 });
    for (const e of res.events) {
      if (e.ev === 'headers') console.log(`  [+${(e.at / 1000).toFixed(1)}s] headers: ${e.status} content-type=${e.ct}`);
      else if (e.ev === 'chunk') console.log(`  [+${(e.at / 1000).toFixed(1)}s] chunk ${e.bytes} bytes (total ${e.total})`);
      else if (e.ev === 'done') console.log(`  [+${(e.at / 1000).toFixed(1)}s] stream closed, ${e.total} bytes total`);
      else if (e.ev === 'error') console.log(`  [+${(e.at / 1000).toFixed(1)}s] ERROR ${e.name}: ${e.message}`);
    }
    if (res.firstBytes) console.log(`  first bytes: ${JSON.stringify(res.firstBytes.slice(0, 200))}`);
    const headers = res.events.find((e) => e.ev === 'headers');
    const done = res.events.find((e) => e.ev === 'done');
    const err = res.events.find((e) => e.ev === 'error');
    console.log('verdict:');
    if (done && headers && headers.status === 200) {
      const looksJson = (res.bodyText || res.firstBytes).trimStart().startsWith('{');
      console.log(`  the model answered in ${(done.at / 1000).toFixed(1)}s (${res.total} bytes, ${looksJson ? 'JSON' : 'not JSON — first bytes above'}) — the key is live`);
      if (done.at > 60000) console.log('  ...but slower than the old 60s gate timeout, which is why the mint failed the gate');
    } else if (done) {
      console.log(`  the endpoint answered ${headers ? headers.status : '?'} in ${(done.at / 1000).toFixed(1)}s — the key or the model was refused, not a timeout`);
    } else if (err && err.name === 'AbortError' && res.total > 0) {
      console.log(`  timed out after ${TIMEOUT_S}s with ${res.total} bytes already received — the model streams but never finishes within the timeout`);
    } else if (err && err.name === 'AbortError' && headers) {
      console.log(`  headers arrived in ${(headers.at / 1000).toFixed(1)}s, then no body for ${TIMEOUT_S}s — the endpoint stalls after accepting the request`);
    } else if (err) {
      console.log(`  ${err.name} after ${(err.at / 1000).toFixed(1)}s: ${err.message}`);
    } else {
      console.log('  no verdict — unexpected event sequence');
    }
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('diag failed:', e.message);
    process.exit(1);
  });
}

module.exports = { probeChatInPage, readKey, parseProxy, readPool };
