// GrainTCP 改造 v2 - 轻注释完整版
// 结构：VLESS over WebSocket on Cloudflare Workers
// 增强：HTTP/SOCKS5 出口代理、proxyIP fallback、UDP DNS -> DoH、上传/下载合包优化

const CFG = {
    id: '', // VLESS UUID
    chunk: 64 * 1024,                           // TCP 读取块大小
    dnPack: 32 * 1024,                          // 下载方向合包大小：TCP -> WS
    dnTail: 512,                                // 下载合包尾部阈值
    dnMs: 0,                                    // 下载方向最小延迟聚合时间
    upPack: 16 * 1024,                          // 上传方向合包大小：WS -> TCP
    upQMax: 256 * 1024,                         // 上传队列最大缓存
    maxED: 8 * 1024,                            // Early Data 最大长度
    concur: 1,                                  // workers部署4，snippets部署1
    doh: 'https://1.1.1.1/dns-query'            // UDP DNS 转 DoH 的上游
};

export default {
    fetch: async req => req.headers.get('Upgrade')?.toLowerCase() === 'websocket'
        ? ws(req, await getProxyCtx(req))
        : new Response('Hello world!')
};

// UUID 字符串预转 16 字节，后续直接字节比较，减少热路径开销
const hex = c => (c > 64 ? c + 9 : c) & 0xF;
const idB = new Uint8Array(16), dec = new TextDecoder(), enc = new TextEncoder();

for (let i = 0, p = 0, c, h; i < 16; i++) {
    c = CFG.id.charCodeAt(p++); c === 45 && (c = CFG.id.charCodeAt(p++));
    h = hex(c);
    c = CFG.id.charCodeAt(p++); c === 45 && (c = CFG.id.charCodeAt(p++));
    idB[i] = h << 4 | hex(c);
}

const [I0, I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, I11, I12, I13, I14, I15] = idB;

// VLESS UUID 鉴权：直接比较首包中的 UUID 字节
const matchID = c =>
    c[1] === I0 && c[2] === I1 && c[3] === I2 && c[4] === I3 &&
    c[5] === I4 && c[6] === I5 && c[7] === I6 && c[8] === I7 &&
    c[9] === I8 && c[10] === I9 && c[11] === I10 && c[12] === I11 &&
    c[13] === I12 && c[14] === I13 && c[15] === I14 && c[16] === I15;

// VLESS 地址类型转字符串：IPv4 / Domain / IPv6
const addr = (t, b) =>
    t === 1 ? `${b[0]}.${b[1]}.${b[2]}.${b[3]}` :
        t === 3 ? dec.decode(b) :
            `[${Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(':')}]`;

// 单次 TCP connect
const sprout = (f, h, p, s = f.connect({ hostname: h, port: p })) => s.opened.then(() => s);

// 并发 connect，谁先成功用谁；降低尾延迟，但 concur 越高越激进
const raceSprout = (f, h, p) => {
    if (!f?.connect) return Promise.reject(new Error('connect unavailable'));
    if (CFG.concur <= 1) return sprout(f, h, p);
    const ts = Array(CFG.concur).fill().map(() => sprout(f, h, p));
    return Promise.any(ts).then(w => {
        ts.forEach(t => t.then(s => s !== w && s.close(), () => { }));
        return w;
    });
};

// 解析 VLESS 地址字段，返回地址字节与 payload 起始位置
const parseAddr = (b, o, t) => {
    const l = t === 3 ? b[o++] : t === 1 ? 4 : t === 4 ? 16 : null;
    if (l === null) return null;
    const n = o + l;
    return n > b.length ? null : { targetAddrBytes: b.subarray(o, n), dataOffset: n };
};

// 解析 VLESS 首包：UUID / command / port / address / payload offset
const vless = c => {
    if (c.length < 24 || !matchID(c)) return null;
    const optLen = c[17];
    const cmd = c[18 + optLen]; // 1=TCP, 2=UDP
    let o = 19 + optLen;
    const p = (c[o] << 8) | c[o + 1];
    let t = c[o + 2];
    if (t !== 1) t += 1;
    const a = parseAddr(c, o + 3, t);
    return a ? { addrType: t, ...a, port: p, cmd, version: c[0] } : null;
};

// 出口连接策略：全局代理 > 直连 > HTTP/SOCKS5 fallback > proxyIP fallback
const smartConnect = async (fetcher, host, port, ctx) => {
    if (ctx.globalProxy && ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
    if (ctx.globalProxy && ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);

    try {
        return await raceSprout(fetcher, host, port);
    } catch (e) {
        if (ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
        if (ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);
        if (ctx.proxyIP) {
            const [ph, pp] = parseHostPort(ctx.proxyIP);
            return raceSprout(fetcher, ph, pp);
        }
        throw e;
    }
};

// 上传队列：WebSocket -> TCP，小包合并后写入 socket
const mkQ = (cap, qCap = cap, itemsMax = Math.max(1, qCap >> 8)) => {
    let q = [], h = 0, qB = 0, buf = null;

    const trim = () => { h > 32 && h * 2 >= q.length && (q = q.slice(h), h = 0); };

    const take = () => {
        if (h >= q.length) return null;
        const d = q[h];
        q[h++] = undefined;
        qB -= d.byteLength;
        trim();
        return d;
    };

    return {
        get bytes() { return qB; },
        get size() { return q.length - h; },
        get empty() { return h >= q.length; },
        clear() { q = []; h = 0; qB = 0; },

        // 入队；超过缓存上限时返回 0，外层会关闭连接
        sow(d) {
            const n = d?.byteLength || 0;
            if (!n) return 1;
            if (qB + n > qCap || q.length - h >= itemsMax) return 0;
            q.push(d); qB += n; return 1;
        },

        // 合并多个小包，降低 writer.write() 次数
        bundle(d) {
            d ||= take();
            if (!d || h >= q.length || d.byteLength >= cap) return [d, 0];

            let n = d.byteLength, e = h;
            while (e < q.length) {
                const x = q[e], nn = n + x.byteLength;
                if (nn > cap) break;
                n = nn; e++;
            }

            if (e === h) return [d, 0];

            const out = buf ||= new Uint8Array(cap);
            out.set(d);

            for (let o = d.byteLength; h < e;) {
                const x = q[h];
                q[h++] = undefined;
                qB -= x.byteLength;
                out.set(x, o);
                o += x.byteLength;
            }

            trim();
            return [out.subarray(0, n), 1];
        }
    };
};

// 下载聚合器：TCP -> WebSocket，小包延迟极短时间后合并发送
const mkDn = w => {
    const cap = CFG.dnPack, tail = CFG.dnTail, low = Math.max(4096, tail << 3);
    let pb = new Uint8Array(cap), p = 0, tp = 0, mq = 0, gen = 0, qk = 0, qr = 0;

    // 立即发送当前聚合 buffer
    const reap = () => {
        tp && clearTimeout(tp);
        tp = 0; mq = 0;
        if (!p) return;
        w.send(pb.subarray(0, p).slice());
        pb = new Uint8Array(cap); p = 0; qr = 0;
    };

    // 等待微小时间窗口，让同一轮 event loop 的小包聚合
    const ripen = () => {
        if (tp || mq) return;
        mq = 1; qk = gen;
        queueMicrotask(() => {
            mq = 0;
            if (!p || tp) return;
            if (cap - p < tail) return reap();
            tp = setTimeout(() => {
                tp = 0;
                if (!p) return;
                if (cap - p < tail) return reap();
                if (qr < 2 && (gen !== qk || p < low)) {
                    qr++; qk = gen; return ripen();
                }
                reap();
            }, Math.max(CFG.dnMs, 1));
        });
    };

    return {
        send(u) {
            let o = 0, n = u?.byteLength || 0;
            if (!n) return;

            while (o < n) {
                // 大包直接发送，小包进入聚合 buffer
                if (!p && n - o >= cap) {
                    const m = Math.min(cap, n - o);
                    w.send(o || m !== n ? u.subarray(o, o + m) : u);
                    o += m;
                    continue;
                }

                const m = Math.min(cap - p, n - o);
                pb.set(u.subarray(o, o + m), p);
                p += m; o += m; gen++;

                if (p === cap || cap - p < tail) reap();
                else ripen();
            }
        },
        reap
    };
};

// TCP readable -> WebSocket；优先 BYOB Reader，减少分配
const mill = async (rd, w) => {
    const r = rd.getReader({ mode: 'byob' }), tx = mkDn(w);
    let buf = new ArrayBuffer(CFG.chunk);

    try {
        for (; ;) {
            const { done, value: v } = await r.read(new Uint8Array(buf, 0, CFG.chunk));
            if (done) break;
            if (!v?.byteLength) continue;

            if (v.byteLength >= (CFG.chunk >> 1)) {
                tx.reap(); w.send(v); buf = new ArrayBuffer(CFG.chunk);
            } else {
                tx.send(v.slice()); buf = v.buffer;
            }
        }
        tx.reap();
    } catch { } finally {
        try { tx.reap(); } catch { }
        try { r.releaseLock(); } catch { }
    }
};

// VLESS UDP frame 拆包：每个 UDP payload 前有 2 字节长度
const unpackUDP = u => {
    if (!u?.byteLength) return [];
    const out = [];
    let o = 0;

    while (o + 2 <= u.byteLength) {
        const n = (u[o] << 8) | u[o + 1];
        if (!n || o + 2 + n > u.byteLength) break;
        out.push(u.subarray(o + 2, o + 2 + n));
        o += 2 + n;
    }

    return out.length && o === u.byteLength ? out : [u];
};

// VLESS UDP frame 封包
const packUDP = u => {
    const out = new Uint8Array(u.byteLength + 2);
    out[0] = u.byteLength >> 8;
    out[1] = u.byteLength & 255;
    out.set(u, 2);
    return out;
};

// DNS over HTTPS：把 UDP DNS query 转发到 DoH 上游
const doh = async q => {
    const r = await fetch(CFG.doh, {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: q
    });
    if (!r.ok) throw new Error(`doh ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
};

// 处理 UDP:53 payload，逐个 DNS query 查询并回包
const handleDNS = async (payload, server) => {
    for (const q of unpackUDP(payload)) server.send(packUDP(await doh(q)));
};

// WebSocket 主状态机：解析 VLESS、建立 TCP、转发双向数据
const ws = async (req, ctx) => {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept({ allowHalfOpen: true });
    server.binaryType = 'arraybuffer';

    const fetcher = req.fetcher;

    // Early Data：客户端可把首包放在 sec-websocket-protocol 中
    const edStr = req.headers.get('sec-websocket-protocol');
    const ed = edStr && edStr.length <= CFG.maxED * 4 / 3 + 4
        ? Uint8Array.fromBase64(edStr, { alphabet: 'base64url' })
        : null;

    let curW = null, sock = null, closed = false, busy = false, udpDNS = false;
    const uq = mkQ(CFG.upPack, CFG.upQMax, CFG.upQMax >> 8);

    // 统一清理 websocket、socket、writer、队列
    const wither = () => {
        if (closed) return;
        closed = true;
        uq.clear();
        try { curW?.releaseLock(); } catch { }
        try { sock?.close(); } catch { }
        try { server.close(); } catch { }
    };

    const toU8 = d => d instanceof Uint8Array
        ? d
        : ArrayBuffer.isView(d)
            ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
            : new Uint8Array(d);

    // 收到客户端数据后先入队，避免并发写 socket
    const sow = d => {
        const u = toU8(d), n = u.byteLength;
        if (!n) return 1;
        if (uq.sow(u)) return 1;
        wither();
        return 0;
    };

    // 核心调度循环：首包建链，后续包写入 TCP；UDP DNS 走 DoH 分支
    const thresh = async () => {
        if (busy || closed) return;
        busy = true;

        try {
            for (; ;) {
                if (closed) break;

                if (udpDNS) {
                    const [d] = uq.bundle();
                    if (!d) break;
                    await handleDNS(d, server);
                    continue;
                }

                if (!sock) {
                    const [d] = uq.bundle();
                    if (!d) break;

                    const r = vless(d);
                    if (!r) throw wither();

                    // VLESS response header
                    server.send(new Uint8Array([d[0], 0]));

                    const host = addr(r.addrType, r.targetAddrBytes);
                    const port = r.port;
                    const payload = d.subarray(r.dataOffset);

                    // 仅处理 UDP DNS；其他 UDP 不在此版本支持范围内
                    if (r.cmd === 2 && port === 53) {
                        udpDNS = true;
                        if (payload.byteLength) await handleDNS(payload, server);
                        continue;
                    }

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
            !uq.empty && !closed && queueMicrotask(thresh);
        }
    };

    if (ed && sow(ed)) thresh();

    server.addEventListener('message', e => {
        closed || (sow(e.data) && thresh());
    });

    server.addEventListener('close', () => wither());
    server.addEventListener('error', () => wither());

    return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Extensions': '' }
    });
};

// HTTP CONNECT：通过 HTTP 代理建立到目标的 TCP 隧道
async function httpConnect(fetcher, targetHost, targetPort, ctx) {
    const { username, password, hostname, port } = ctx.parsedProxy;
    const sock = await raceSprout(fetcher, hostname, port);

    const w = sock.writable.getWriter();
    const r = sock.readable.getReader();

    try {
        const auth = username && password
            ? `Proxy-Authorization: Basic ${btoa(`${username}:${password}`)}\r\n`
            : '';

        const req =
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            auth +
            `Proxy-Connection: Keep-Alive\r\n` +
            `Connection: Keep-Alive\r\n\r\n`;

        await w.write(enc.encode(req));

        let buf = new Uint8Array(0);

        for (; ;) {
            const { value, done } = await r.read();
            if (done) throw new Error('http proxy closed');
            if (!value?.byteLength) continue;

            const m = new Uint8Array(buf.length + value.length);
            m.set(buf);
            m.set(value, buf.length);
            buf = m;

            const s = dec.decode(buf);
            const i = s.indexOf('\r\n\r\n');

            if (i < 0) {
                if (buf.length > 8192) throw new Error('http proxy header too large');
                continue;
            }

            const h = s.slice(0, i);
            if (!h.startsWith('HTTP/1.1 200') && !h.startsWith('HTTP/1.0 200')) {
                throw new Error(h.split('\r\n')[0]);
            }

            break;
        }

        return sock;
    } finally {
        try { w.releaseLock(); } catch { }
        try { r.releaseLock(); } catch { }
    }
}

// SOCKS5 CONNECT：支持无认证和用户名密码认证
async function socks5Connect(fetcher, targetHost, targetPort, ctx) {
    const { username, password, hostname, port } = ctx.parsedProxy;
    const sock = await raceSprout(fetcher, hostname, port);
    const w = sock.writable.getWriter();
    const r = sock.readable.getReader();

    try {
        await w.write(new Uint8Array([5, 2, 0, 2]));
        const a = (await r.read()).value;
        if (!a || a[0] !== 5) throw new Error('bad socks5 auth response');

        if (a[1] === 2) {
            if (!username || !password) throw new Error('socks5 auth required');
            const u = enc.encode(username), p = enc.encode(password);
            await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
            const ar = (await r.read()).value;
            if (!ar || ar[1] !== 0) throw new Error('socks5 auth failed');
        } else if (a[1] !== 0) {
            throw new Error(`socks5 method ${a[1]}`);
        }

        const d = enc.encode(targetHost);
        await w.write(new Uint8Array([5, 1, 0, 3, d.length, ...d, targetPort >> 8, targetPort & 255]));
        const cr = (await r.read()).value;
        if (!cr || cr[1] !== 0) throw new Error(`socks5 connect ${cr?.[1]}`);

        return sock;
    } finally {
        try { w.releaseLock(); } catch { }
        try { r.releaseLock(); } catch { }
    }
}

// 解析 user:pass@host:port；IPv6 需写成 [IPv6]:port
function parseProxyAddress(address) {
    const lastAt = address.lastIndexOf('@');
    const latter = lastAt === -1 ? address : address.substring(lastAt + 1);
    const former = lastAt === -1 ? '' : address.substring(0, lastAt);

    let username, password;
    if (former) [username, password] = former.split(':');

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

    return { username, password, hostname, port };
}

// 解析 proxyIP / host:port / [IPv6]:port / .tp端口格式
function parseHostPort(proxyIP) {
    proxyIP = proxyIP.toLowerCase();
    let host = proxyIP, port = 443;

    if (proxyIP.includes('.tp')) {
        const m = proxyIP.match(/\.tp(\d+)/);
        if (m) port = parseInt(m[1], 10);
        return [host, port];
    }

    if (proxyIP.includes(']:')) {
        const parts = proxyIP.split(']:');
        host = parts[0] + ']';
        port = parseInt(parts[1], 10) || port;
    } else if (proxyIP.includes(':') && !proxyIP.startsWith('[')) {
        const i = proxyIP.lastIndexOf(':');
        host = proxyIP.slice(0, i);
        port = parseInt(proxyIP.slice(i + 1), 10) || port;
    }

    return [host, port];
}

// 从 URL 提取代理参数；支持 query 与 path 两种写法
async function getProxyCtx(request) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const lower = pathname.toLowerCase();

    const ctx = {
        proxyIP: request.cf?.colo ? `${request.cf.colo}.PrOxYip.CmLiuSsSs.nEt` : '',
        proxyType: null,
        globalProxy: false,
        proxyAddress: '',
        parsedProxy: {}
    };

    // proxyIP 优先级较高；逗号分隔时随机选一个
    if (searchParams.has('proxyip')) {
        const v = searchParams.get('proxyip') || '';
        ctx.proxyIP = v.includes(',') ? v.split(',')[Math.floor(Math.random() * v.split(',').length)] : v;
    } else {
        const m = lower.match(/\/(proxyip[.=]|pyip=|ip=)(.+)/);
        if (m) {
            const v = m[1] === 'proxyip.' ? `proxyip.${m[2]}` : m[2];
            ctx.proxyIP = v.includes(',') ? v.split(',')[Math.floor(Math.random() * v.split(',').length)] : v;
        }
    }

    // query 参数：?http= / ?socks5= / ?globalproxy
    if (searchParams.has('http')) {
        ctx.proxyType = 'http';
        ctx.proxyAddress = searchParams.get('http') || '';
    } else if (searchParams.has('socks5')) {
        ctx.proxyType = 'socks5';
        ctx.proxyAddress = searchParams.get('socks5') || '';
    }

    ctx.globalProxy = searchParams.has('globalproxy');

    let m;

    // path 参数：/socks5://... 或 /http://...，默认全局代理
    if ((m = pathname.match(/\/(socks5?|http):\/?\/?(.+)/i))) {
        ctx.proxyType = m[1].toLowerCase() === 'http' ? 'http' : 'socks5';
        ctx.proxyAddress = m[2].split('#')[0];
        ctx.globalProxy = true;
    }

    // path 参数：/s5= /gs5= /http= /ghttp=
    else if ((m = pathname.match(/\/(g?s5|socks5|g?http)=(.+)/i))) {
        const type = m[1].toLowerCase();
        ctx.proxyAddress = m[2];
        ctx.proxyType = type.includes('http') ? 'http' : 'socks5';
        ctx.globalProxy = type.startsWith('g') || ctx.globalProxy;
    }

    if (ctx.proxyAddress) {
        try {
            ctx.parsedProxy = parseProxyAddress(ctx.proxyAddress);
        } catch {
            ctx.proxyType = null;
            ctx.proxyAddress = '';
            ctx.parsedProxy = {};
        }
    }

    return ctx;
}
