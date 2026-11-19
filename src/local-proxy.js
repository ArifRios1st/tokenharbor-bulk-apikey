'use strict';
/*
 * local-proxy.js — a localhost HTTP CONNECT proxy that forwards through an
 * upstream SOCKS5 proxy (with username/password auth) in plain Node.
 *
 * Why it exists: Chrome's SOCKS5-auth handling hangs. With an authenticated
 * SOCKS5 exit, the browser never completes the handshake — no dialog, no CDP
 * Fetch.authRequired event, the tab just sits on about:blank until the
 * navigation timeout fires. Credentials in the --proxy-server URL do not fix
 * it either. Node's own SOCKS5 client, on the other hand, completes the same
 * handshake in under a second (see scripts/diag-browser-proxy.js phase A).
 *
 * So for SOCKS proxies with a username, the browser talks plain HTTP CONNECT
 * to this proxy on 127.0.0.1 (no auth, nothing for Chrome to fumble) and this
 * module does the SOCKS5 handshake upstream. One instance per browser launch;
 * it listens on an ephemeral loopback port and is closed with the browser.
 */
const net = require('net');

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

/** Open a TCP connection to host:port through an upstream SOCKS5 proxy. */
async function socks5Connect({ proxyHost, proxyPort, username = null, password = null, host, port, timeoutMs = 20000 }) {
  const sock = net.connect(proxyPort, proxyHost);
  const fail = (e) => {
    try {
      sock.destroy();
    } catch (err) {
      /* already gone */
    }
    throw e;
  };
  try {
    await onceWithTimeout(sock, 'connect', timeoutMs, 'TCP connect to proxy');
    const reader = new Reader(sock);
    const methods = username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const hs = await reader.read(2);
    if (hs[0] !== 0x05 || hs[1] === 0xff) {
      throw new Error(`socks5 handshake rejected (method ${hs[1]})`);
    }
    if (hs[1] === 0x02) {
      const u = Buffer.from(username || '');
      const p = Buffer.from(password || '');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const ar = await reader.read(2);
      if (ar[0] !== 0x01 || ar[1] !== 0x00) throw new Error('socks5 auth rejected');
    }
    const hostBuf = Buffer.from(host);
    sock.write(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([port >> 8, port & 0xff])])
    );
    const rep = await reader.read(4);
    if (rep[0] !== 0x05 || rep[1] !== 0x00) throw new Error(`socks5 connect rc=${rep[1]}`);
    const atyp = rep[3];
    const restLen = atyp === 0x01 ? 6 : atyp === 0x04 ? 18 : atyp === 0x03 ? (await reader.read(1))[0] + 2 : 0;
    if (restLen) await reader.read(restLen);
    reader.detach();
    return sock;
  } catch (e) {
    return fail(e);
  }
}

/** Read one HTTP request head (up to the blank line) off a client socket. */
function readHead(sock, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('request head timeout'));
    }, timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.includes('\r\n\r\n') || buf.length > 8192) {
        cleanup();
        resolve(buf);
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
    };
    sock.on('data', onData);
    sock.once('error', onErr);
  });
}

function pipePair(a, b, sockets) {
  const kill = () => {
    try {
      a.destroy();
    } catch (e) {
      /* gone */
    }
    try {
      b.destroy();
    } catch (e) {
      /* gone */
    }
  };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', () => {
    sockets.delete(a);
    try {
      b.end();
    } catch (e) {
      /* gone */
    }
  });
  b.on('close', () => {
    sockets.delete(b);
    try {
      a.end();
    } catch (e) {
      /* gone */
    }
  });
  a.pipe(b);
  b.pipe(a);
}

async function handleClient(client, px, sockets) {
  let head;
  try {
    head = await readHead(client);
  } catch (e) {
    try {
      client.destroy();
    } catch (err) {
      /* gone */
    }
    return;
  }
  // Bytes after the head belong to the tunneled stream (for CONNECT, the TLS
  // ClientHello can arrive in the same TCP segment as the request head).
  const headEnd = head.indexOf('\r\n\r\n') + 4;
  const leftover = head.length > headEnd ? head.subarray(headEnd) : null;
  const text = head.toString('latin1');
  const [requestLine, ...headerLines] = text.split('\r\n');
  const [method, target] = (requestLine || '').split(' ');
  let host;
  let port;
  let rewrite = null;
  if (method === 'CONNECT') {
    const m = (target || '').match(/^([^:]+):(\d+)$/);
    if (!m) {
      client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      client.destroy();
      return;
    }
    host = m[1];
    port = Number(m[2]);
  } else {
    // Plain http:// request: forward it in origin form through the tunnel.
    const m = (target || '').match(/^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
    if (!m) {
      client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      client.destroy();
      return;
    }
    host = m[1];
    port = Number(m[2] || 80);
    rewrite = `${method} ${m[3] || '/'} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`;
  }
  let upstream;
  try {
    upstream = await socks5Connect({ proxyHost: px.host, proxyPort: px.port, username: px.username, password: px.password, host, port });
  } catch (e) {
    client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    client.destroy();
    return;
  }
  sockets.add(upstream);
  if (method === 'CONNECT') {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  } else {
    upstream.write(rewrite);
  }
  if (leftover) upstream.write(leftover);
  pipePair(client, upstream, sockets);
}

/**
 * Start the forwarding proxy for one upstream pool entry. Resolves with
 * { port, close() }; the port is an ephemeral loopback port.
 */
function startLocalProxy(px) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((client) => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      handleClient(client, px, sockets).catch(() => {
        try {
          client.destroy();
        } catch (e) {
          /* gone */
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch (e) {
                /* gone */
              }
            }
            server.close(() => res());
          }),
      });
    });
  });
}

module.exports = { startLocalProxy, socks5Connect };
