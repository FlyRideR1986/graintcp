const CFG = { id: '', chunk: 64 * 1024, dnPack: 32 * 1024, dnTail: 512, dnQr: 4, upPack: 20 * 1024, maxED: 8 * 1024, concur: 4, proxyConcur: 1 };
export default { fetch: async req => req.headers.get('Upgrade')?.toLowerCase() === 'websocket' ? ws(req, getProxyCtx(req)) : new Response('Hello world!') };

const hex = c => (c > 64 ? c + 9 : c) & 0xF;
const idB = new Uint8Array(16), dec = new TextDecoder(), enc = new TextEncoder();
for (let i = 0, p = 0, c, h; i < 16; i++) {
  c = CFG.id.charCodeAt(p++); c === 45 && (c = CFG.id.charCodeAt(p++)); h = hex(c);
  c = CFG.id.charCodeAt(p++); c === 45 && (c = CFG.id.charCodeAt(p++)); idB[i] = h << 4 | hex(c);
}

const [I0, I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, I11, I12, I13, I14, I15] = idB;
const matchID = c => c[1] === I0 && c[2] === I1 && c[3] === I2 && c[4] === I3 && c[5] === I4 && c[6] === I5 && c[7] === I6 && c[8] === I7 && c[9] === I8 && c[10] === I9 && c[11] === I10 && c[12] === I11 && c[13] === I12 && c[14] === I13 && c[15] === I14 && c[16] === I15;
const addr = (t, b) => t === 1 ? `${b[0]}.${b[1]}.${b[2]}.${b[3]}` : t === 3 ? dec.decode(b) : `[${Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(':')}]`;
const stripBrackets = host => host?.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
const sprout = (f, h, p, s = f.connect({ hostname: h, port: p })) => s.opened.then(() => s);
const raceSprout = (f, h, p, concur = CFG.concur) => {
  if (!f?.connect) return Promise.reject(new Error('connect unavailable'));
  const n = Math.max(1, concur | 0);
  if (n === 1) return sprout(f, h, p);
  const ts = Array(n).fill().map(() => sprout(f, h, p));
  return Promise.any(ts).then(w => { ts.forEach(t => t.then(s => s !== w && s.close(), () => {})); return w; });
};
// Proxy entries normally have one host:port, so avoid redundant concurrent login/CONNECT attempts.
const proxySprout = (f, h, p) => raceSprout(f, h, p, CFG.proxyConcur);
const parseAddr = (b, o, t) => {
  const l = t === 3 ? b[o++] : t === 1 ? 4 : t === 4 ? 16 : null;
  if (l === null) return null;
  const n = o + l;
  return n > b.length ? null : { targetAddrBytes: b.subarray(o, n), dataOffset: n };
};
const relay = c => {
  if (c.length < 24 || !matchID(c)) return null;
  let o = 19 + c[17];
  const p = (c[o] << 8) | c[o + 1];
  let t = c[o + 2];
  if (t !== 1) t += 1;
  const a = parseAddr(c, o + 3, t);
  return a ? { addrType: t, ...a, port: p } : null;
};
const smartConnect = (fetcher, host, port, ctx) =>
  ctx.globalProxy && ctx.proxyType === 'http' ? httpConnect(fetcher, host, port, ctx) :
  ctx.globalProxy && ctx.proxyType === 'socks5' ? socks5Connect(fetcher, host, port, ctx) :
  raceSprout(fetcher, host, port);

const mkK = (cap, cpy = 0) => {
  let q = [], h = 0, b = 0, buf = null;
  const e = () => h >= q.length;
  const trim = () => { h > 32 && h * 2 >= q.length && (q = q.slice(h), h = 0); };
  const clear = () => { q = []; h = 0; b = 0; };
  const take = () => { if (e()) return null; const d = q[h]; q[h++] = undefined; b -= d.byteLength; trim(); return d; };
  const sow = d => { const n = d?.byteLength || 0; return !n || (q.push(d), b += n, 1); };
  const pack = d => {
    d ||= take();
    if (!d || e()) return [d, 0];
    let n = d.byteLength, j = h;
    while (j < q.length) { const x = q[j], nn = n + x.byteLength; if (nn > cap) break; n = nn; j++; }
    if (j === h) return [d, 0];
    const out = buf ||= new Uint8Array(cap);
    out.set(d);
    for (let o = d.byteLength; h < j;) { const x = q[h]; q[h++] = undefined; b -= x.byteLength; out.set(x, o); o += x.byteLength; }
    trim();
    const u = out.subarray(0, n);
    return [cpy ? u.slice() : u, 1];
  };
  return { e, get b() { return b; }, clear, take, sow, pack };
};
const mkQ = cap => { const k = mkK(cap); return { get empty() { return k.e(); }, clear: k.clear, sow: k.sow, bundle: d => k.pack(d) }; };
const mkDn = w => {
  const cap = CFG.dnPack, tail = CFG.dnTail, low = Math.max(4096, tail * 12), k = mkK(cap, 1);
  let tp = 0, gen = 0, qk = 0, qr = 0;
  const reap = () => { tp && clearTimeout(tp); tp = 0; qr = 0; for (;;) { const [u] = k.pack(); if (!u) break; w.send(u); } };
  const ripen = () => {
    if (k.e() || tp) return;
    if (k.b >= cap || cap - k.b < tail) return reap();
    tp = setTimeout(() => {
      tp = 0;
      if (k.e()) return;
      if (k.b >= cap || cap - k.b < tail) return reap();
      if (qr < CFG.dnQr && (gen !== qk || k.b < low)) { qr++; qk = gen; return ripen(); }
      reap();
    }, 1);
  };
  return {
    send(u) {
      let o = 0, n = u?.byteLength || 0;
      if (!n) return;
      while (o < n) {
        const m = Math.min(cap - k.b, n - o);
        if (!m) { reap(); continue; }
        k.sow(o || m !== n ? u.subarray(o, o + m) : u);
        gen++; o += m;
        if (k.b >= cap || cap - k.b < tail) reap(); else ripen();
      }
    },
    reap
  };
};
const mill = async (rd, w) => {
  const r = rd.getReader({ mode: 'byob' }), tx = mkDn(w);
  let buf = new ArrayBuffer(CFG.chunk);
  try {
    for (;;) {
      const { done, value: v } = await r.read(new Uint8Array(buf, 0, CFG.chunk));
      if (done) break;
      if (!v?.byteLength) continue;
      if (v.byteLength >= (CFG.chunk >> 1)) tx.reap(), w.send(v), buf = new ArrayBuffer(CFG.chunk);
      else tx.send(v.slice()), buf = v.buffer;
    }
    tx.reap();
  } catch {} finally {
    try { tx.reap(); } catch {}
    try { r.releaseLock(); } catch {}
  }
};
const ws = async (req, ctx) => {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept({ allowHalfOpen: true });
  server.binaryType = 'arraybuffer';
  const fetcher = req.fetcher;
  const edStr = req.headers.get('sec-websocket-protocol');
  const ed = edStr && edStr.length <= CFG.maxED * 4 / 3 + 4 ? /** @type {*} */ (Uint8Array).fromBase64(edStr, { alphabet: 'base64url' }) : null;
  let curW = null, sock = null, closed = false, busy = false;
  const uq = mkQ(CFG.upPack);
  const wither = () => {
    if (closed) return;
    closed = true;
    uq.clear();
    try { curW?.releaseLock(); } catch {}
    try { sock?.close(); } catch {}
    try { server.close(); } catch {}
  };
  const toU8 = d => d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  const sow = d => { const u = toU8(d), n = u.byteLength; if (!n) return 1; if (uq.sow(u)) return 1; wither(); return 0; };
  const thresh = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      for (;;) {
        if (closed) break;
        if (!sock) {
          const [d] = uq.bundle();
          if (!d) break;
          const r = relay(d);
          if (!r) throw wither();
          server.send(new Uint8Array([d[0], 0]));
          const host = addr(r.addrType, r.targetAddrBytes), port = r.port, payload = d.subarray(r.dataOffset);
          sock = await smartConnect(fetcher, host, port, ctx);
          if (!sock) throw wither();
          curW = sock.writable.getWriter();
          const [first] = uq.bundle(payload);
          first?.byteLength && await curW.write(first);
          mill(sock.readable, server).finally(() => wither());
          continue;
        }
        const [d] = uq.bundle();
        if (!d) break;
        await curW.write(d);
      }
    } catch {
      wither();
    } finally {
      busy = false;
      !uq.empty && !closed && thresh();
    }
  };
  if (ed && sow(ed)) thresh();
  server.addEventListener('message', e => { closed || (sow(e.data) && thresh()); });
  server.addEventListener('close', () => wither());
  server.addEventListener('error', () => wither());
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Extensions': '' } });
};

const findHeaderEnd = bytes => {
  for (let i = 0; i <= bytes.byteLength - 4; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) return i + 4;
  }
  return -1;
};

// Preserve bytes already received after CONNECT's HTTP header without losing BYOB support downstream.
const withPrefixedReadable = (socket, reader, prefix) => {
  let pending = prefix;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch {}
  };
  const close = () => {
    try { reader.cancel(); } catch {}
    release();
    try { socket.close(); } catch {}
  };
  const readable = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      try {
        if (pending?.byteLength) {
          const chunk = pending;
          pending = null;
          controller.enqueue(chunk);
          return;
        }
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          if (value?.byteLength) {
            controller.enqueue(value);
            return;
          }
        }
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
      release();
    }
  });
  return { readable, writable: socket.writable, closed: socket.closed, close };
};

async function httpConnect(fetcher, targetHost, targetPort, ctx) {
  const { username, password, hostname, port } = ctx.parsedProxy;
  const sock = await proxySprout(fetcher, stripBrackets(hostname), port);
  const w = sock.writable.getWriter(), r = sock.readable.getReader();
  let readerTransferred = false;
  try {
    const hasBasicAuth = username != null && password != null;
    const auth = hasBasicAuth ? `Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n` : '';
    const authority = `${targetHost}:${targetPort}`;
    const req = `CONNECT ${authority} HTTP/1.1\r\n`
      + `Host: ${authority}\r\n`
      + auth
      + 'User-Agent: Mozilla/5.0\r\n'
      + 'Proxy-Connection: Keep-Alive\r\n'
      + 'Connection: keep-alive\r\n\r\n';
    await w.write(enc.encode(req));

    let buf = new Uint8Array(0), headerEnd = -1;
    while (headerEnd < 0 && buf.byteLength < 8192) {
      const { value, done } = await r.read();
      if (done) throw new Error('http proxy closed before CONNECT response');
      if (!value?.byteLength) continue;
      const chunk = new Uint8Array(value);
      const merged = new Uint8Array(buf.byteLength + chunk.byteLength);
      merged.set(buf);
      merged.set(chunk, buf.byteLength);
      buf = merged;
      headerEnd = findHeaderEnd(buf);
    }

    if (headerEnd < 0) throw new Error('http proxy CONNECT response header too large or invalid');
    const statusLine = dec.decode(buf.subarray(0, headerEnd)).split('\r\n')[0];
    const status = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
    const code = status ? Number(status[1]) : NaN;
    if (!Number.isFinite(code) || code < 200 || code >= 300) throw new Error(`http proxy CONNECT failed: ${statusLine || 'invalid response'}`);

    if (buf.byteLength > headerEnd) {
      const tunnel = withPrefixedReadable(sock, r, buf.subarray(headerEnd));
      readerTransferred = true;
      return tunnel;
    }
    return sock;
  } finally {
    try { w.releaseLock(); } catch {}
    if (!readerTransferred) try { r.releaseLock(); } catch {}
  }
}

const socksAddress = host => {
  const raw = stripBrackets(host);
  const v4 = raw.split('.');
  if (v4.length === 4 && v4.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return new Uint8Array([1, ...v4.map(Number)]);

  const v6 = raw.split(':');
  if (raw.includes(':') && v6.length === 8 && v6.every(x => /^[0-9a-f]{1,4}$/i.test(x))) {
    const out = new Uint8Array(17);
    out[0] = 4;
    for (let i = 0; i < 8; i++) {
      const n = parseInt(v6[i], 16);
      out[1 + i * 2] = n >> 8;
      out[2 + i * 2] = n & 255;
    }
    return out;
  }

  const d = enc.encode(raw);
  if (!d.byteLength || d.byteLength > 255) throw new Error('invalid socks5 target domain');
  const out = new Uint8Array(d.byteLength + 2);
  out[0] = 3;
  out[1] = d.byteLength;
  out.set(d, 2);
  return out;
};

async function socks5Connect(fetcher, targetHost, targetPort, ctx) {
  const { username, password, hostname, port } = ctx.parsedProxy;
  const sock = await proxySprout(fetcher, stripBrackets(hostname), port);
  const w = sock.writable.getWriter(), r = sock.readable.getReader();
  let stash = new Uint8Array(0);
  const hasUserPass = Boolean(username && password);

  const readExact = async n => {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (!stash.byteLength) {
        const { value, done } = await r.read();
        if (done) throw new Error('socks5 proxy closed');
        if (!value?.byteLength) continue;
        stash = new Uint8Array(value);
      }
      const m = Math.min(n - o, stash.byteLength);
      out.set(stash.subarray(0, m), o);
      o += m;
      stash = m === stash.byteLength ? new Uint8Array(0) : stash.subarray(m);
    }
    return out;
  };

  try {
    await w.write(hasUserPass ? new Uint8Array([5, 2, 0, 2]) : new Uint8Array([5, 1, 0]));
    const hello = await readExact(2);
    if (hello[0] !== 5) throw new Error('bad socks5 auth response');

    if (hello[1] === 2) {
      if (!hasUserPass) throw new Error('socks5 auth required');
      const u = enc.encode(username), p = enc.encode(password);
      if (u.byteLength > 255 || p.byteLength > 255) throw new Error('invalid socks5 credentials');
      const auth = new Uint8Array(u.byteLength + p.byteLength + 3);
      auth[0] = 1;
      auth[1] = u.byteLength;
      auth.set(u, 2);
      auth[2 + u.byteLength] = p.byteLength;
      auth.set(p, 3 + u.byteLength);
      await w.write(auth);
      const ar = await readExact(2);
      if (ar[0] !== 1 || ar[1] !== 0) throw new Error(`socks5 auth failed ${ar[1]}`);
    } else if (hello[1] !== 0) {
      throw new Error(`socks5 method ${hello[1]}`);
    }

    const target = socksAddress(targetHost);
    const req = new Uint8Array(target.byteLength + 5);
    req.set([5, 1, 0], 0);
    req.set(target, 3);
    req[3 + target.byteLength] = targetPort >> 8;
    req[4 + target.byteLength] = targetPort & 255;
    await w.write(req);

    const head = await readExact(4);
    if (head[0] !== 5) throw new Error('bad socks5 connect response');
    if (head[1] !== 0) throw new Error(`socks5 connect ${head[1]}`);
    let boundLen;
    if (head[3] === 1) boundLen = 4;
    else if (head[3] === 4) boundLen = 16;
    else if (head[3] === 3) boundLen = (await readExact(1))[0];
    else throw new Error(`socks5 atyp ${head[3]}`);
    await readExact(boundLen + 2);
    return sock;
  } finally {
    try { w.releaseLock(); } catch {}
    try { r.releaseLock(); } catch {}
  }
}

function parseProxyAddress(address) {
  const lastAt = address.lastIndexOf('@');
  const latter = lastAt === -1 ? address : address.substring(lastAt + 1);
  const former = lastAt === -1 ? '' : address.substring(0, lastAt);
  let username, password;
  if (former) {
    const i = former.indexOf(':');
    username = i < 0 ? former : former.slice(0, i);
    password = i < 0 ? '' : former.slice(i + 1);
  }

  let hostname, port;
  if (latter.includes(']:')) {
    port = Number(latter.split(']:')[1].replace(/[^\d]/g, ''));
    hostname = latter.split(']:')[0] + ']';
  } else {
    const i = latter.lastIndexOf(':');
    if (i > -1) {
      hostname = latter.slice(0, i);
      port = Number(latter.slice(i + 1).replace(/[^\d]/g, ''));
    } else {
      hostname = latter;
      port = 80;
    }
  }

  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid proxy address');
  return { username, password, hostname, port };
}

function getProxyCtx(request) {
  const url = new URL(request.url), { pathname, searchParams } = url;
  let proxyType = null, proxyAddress = '', globalProxy = searchParams.has('globalproxy'), m;
  if (searchParams.has('http')) {
    proxyType = 'http';
    proxyAddress = searchParams.get('http') || '';
  } else if (searchParams.has('socks5')) {
    proxyType = 'socks5';
    proxyAddress = searchParams.get('socks5') || '';
  }

  if ((m = pathname.match(/\/(socks5?|http):\/?\/?(.+)/i))) {
    proxyType = m[1].toLowerCase() === 'http' ? 'http' : 'socks5';
    proxyAddress = m[2].split('#')[0];
    globalProxy = true;
  } else if ((m = pathname.match(/\/(gs5|ghttp)=(.+)/i))) {
    const type = m[1].toLowerCase();
    proxyType = type === 'ghttp' ? 'http' : 'socks5';
    proxyAddress = m[2];
    globalProxy = true;
  }

  if (!(globalProxy && proxyType && proxyAddress)) return { globalProxy: false, proxyType: null, parsedProxy: {} };
  try { return { globalProxy: true, proxyType, parsedProxy: parseProxyAddress(proxyAddress) }; }
  catch { return { globalProxy: false, proxyType: null, parsedProxy: {} }; }
}
