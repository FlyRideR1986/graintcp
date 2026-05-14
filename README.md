# GrainTCP.js 详细注释版

项目来自大佬：https://github.com/ToiCF/GrainTCP
原始项目没有http和socks和反代，vibecoding给加上了。
下面用ai总结的文档

> 目标：
>
> 这份文档不是简单“翻译代码”，而是从 Cloudflare Workers、VLESS、WebSocket、TCP Socket、队列聚合、DoH DNS、HTTP/SOCKS5 代理 等多个角度，解释整个脚本的设计思路。
>
> 重点是：
>
> * 每一层到底在干什么
> * 为什么这么写
> * 性能优化点在哪里
> * 哪些是 GrainTCP 原始设计
> * 哪些是你后续新增的改造
> * 哪些地方可能影响 Cloudflare 风控
>
> 适合：
>
> * 二次开发
> * 学习 Workers Socket
> * 理解 VLESS over WS
> * 理解 GrainTCP 的“grain 聚合”思想
> * 后续继续改造成 xhttp / h2 / h3 / udp / dns 等形态

---

# 第一章：这个脚本整体到底是什么

这是一个：

```text
VLESS over WebSocket over Cloudflare Workers
```

的 TCP 转发器。

同时你在里面新增了：

| 模块               | 作用                                 |
| ---------------- | ---------------------------------- |
| HTTP CONNECT 代理  | Worker 出口再套一层 HTTP 代理              |
| SOCKS5 代理        | Worker 出口再套一层 SOCKS5               |
| proxyIP fallback | 直连失败后回退                            |
| UDP DNS -> DoH   | 把 UDP DNS 转成 HTTPS DNS             |
| 并发 connect       | 多路同时拨号抢最快                          |
| grain 聚合         | 小包合并降低 syscall 和 websocket send 次数 |
| BYOB Reader      | 减少内存复制                             |

本质上它不是传统“完整代理核心”。

它更像：

```text
Cloudflare Worker 上的极限轻量 TCP 转发内核
```

设计目标是：

* 极少对象创建
* 极少 await
* 极少 buffer copy
* 极少 websocket send 次数
* 尽量减少 CF runtime 开销

所以它代码会显得：

```text
非常短
非常密集
非常不像传统工程代码
```

这是刻意的。

---

# 第二章：整体架构图

整体链路：

```text
客户端
    ↓
VLESS
    ↓
WebSocket
    ↓
Cloudflare Worker
    ↓
解析 VLESS Header
    ↓
建立 TCP Socket
    ↓
目标网站
```

如果启用代理：

```text
客户端
  ↓
Worker
  ↓
HTTP CONNECT / SOCKS5
  ↓
目标网站
```

如果是 DNS：

```text
客户端 UDP:53
    ↓
VLESS UDP
    ↓
Worker
    ↓
DoH
    ↓
1.1.1.1/dns-query
```

---

# 第三章：CFG 配置区

原始代码：

```js
const CFG = {
  id: 'df8d0820-dec9-4cda-bae5-c57dad83a029',
  chunk: 64 * 1024,
  dnPack: 32 * 1024,
  dnTail: 512,
  dnMs: 0,
  upPack: 16 * 1024,
  upQMax: 256 * 1024,
  maxED: 8 * 1024,
  concur: 4,
  doh: 'https://1.1.1.1/dns-query'
};
```

---

## 1. id

VLESS UUID。

用于鉴权。

这里用了：

```text
热路径 UUID 匹配
```

而不是：

```text
字符串 compare
```

这是 GrainTCP 一个非常核心的性能优化。

后面会详细解释。

---

## 2. chunk

```js
chunk: 64 * 1024
```

表示：

```text
每次读取 TCP 数据时的最大块大小
```

用于：

```js
reader.read(new Uint8Array(buf, 0, CFG.chunk))
```

64KB 是典型 TCP 大块。

优点：

* 减少 read 次数
* 减少 JS 调度
* 减少 websocket send 次数

缺点：

* 延迟会略大
* 小流量会浪费 buffer

所以后面 GrainTCP 又用了 grain 聚合平衡。

---

## 3. dnPack

```js
dnPack: 32 * 1024
```

下载方向：

```text
TCP -> WebSocket
```

聚合包大小。

意思是：

```text
小包先攒一攒
再一起 websocket.send()
```

这是 GrainTCP 最核心思想。

因为：

```text
CF Worker 的 websocket.send() 很贵
```

频繁小包会：

* CPU 上升
* syscall 增多
* runtime 压力大
* 容易触发风控

所以 GrainTCP 的核心：

```text
不是减少网络包
而是减少 JS runtime 调度
```

这是很关键的思想。

---

## 4. dnTail

```js
dnTail: 512
```

表示：

```text
buffer 剩余空间小于 512 时立刻发送
```

避免：

```text
最后一点空间导致 buffer 卡住
```

---

## 5. dnMs

```js
dnMs: 0
```

grain 聚合等待时间。

实际上：

```js
Math.max(CFG.dnMs, 1)
```

最低还是 1ms。

作用：

```text
允许更多小包合并
```

这是一种：

```text
吞吐 vs 延迟
```

的 tradeoff。

---

## 6. upPack

上传方向聚合大小。

```text
WebSocket -> TCP
```

---

## 7. upQMax

上传队列最大缓存。

```js
256 * 1024
```

避免：

```text
客户端疯狂发包导致内存爆炸
```

---

## 8. maxED

early data 最大长度。

对应：

```http
sec-websocket-protocol
```

里的 base64 数据。

这是很多 VLESS WS 配置的：

```text
0-RTT / early data
```

玩法。

---

## 9. concur

```js
concur: 4
```

并发拨号数量。

核心逻辑：

```text
同时 connect 4 次
谁先成功用谁
剩下全部 close
```

这个是：

```text
Cloudflare Worker 特有优化
```

因为 Worker connect 有时会：

* 某条链路抖动
* 某个 colo 不稳定
* 某次 socket 建立卡住

并发 connect 可以降低 tail latency。

但：

```text
concur 越大
CF 风控风险越高
```

通常：

| concur | 建议     |
| ------ | ------ |
| 1      | 最稳     |
| 2      | 推荐     |
| 4      | 激进     |
| >4     | 风险明显增加 |

---

## 10. doh

DoH 地址。

用于：

```text
UDP DNS -> HTTPS DNS
```

---

# 第四章：为什么 UUID 匹配这么奇怪

代码：

```js
const idB = new Uint8Array(16)
```

后面：

```js
const matchID = c =>
  c[1] === I0 &&
  c[2] === I1 ...
```

很多人第一次看会懵。

实际上这是：

```text
极限热路径优化
```

传统写法：

```js
uuid === xxxxx
```

会：

* 创建字符串
* decode
* compare
* GC

而 GrainTCP：

```text
直接按字节 compare
```

好处：

* 无字符串对象
* 无 decode
* 无额外 allocation
* 极低 GC

这就是：

```text
Snippets 风格代码
```

不是为了可读性。

是为了：

```text
Cloudflare Runtime 极限性能
```

---

# 第五章：addr() 地址解析

代码：

```js
const addr = (t, b) =>
```

作用：

把 VLESS header 里的地址解析成人类可读。

支持：

| 类型 | 含义   |
| -- | ---- |
| 1  | IPv4 |
| 3  | 域名   |
| 4  | IPv6 |

注意：

```text
VLESS 规范里 domain 实际类型是 2
```

但这里做了偏移处理。

后面你会看到：

```js
if (t !== 1) t += 1;
```

属于作者的：

```text
压缩写法
```

可读性差。

但减少了 switch。

---

# 第六章：并发拨号 raceSprout

这是整个 GrainTCP 的核心优化之一。

代码逻辑：

```js
const ts = Array(CFG.concur)
  .fill()
  .map(() => sprout(f, h, p));

return Promise.any(ts)
```

本质：

```text
Happy Eyeballs 思想
```

类似浏览器：

```text
IPv4 和 IPv6 同时拨号
谁快用谁
```

这里只不过：

```text
是多个 CF socket 同时拨号
```

成功后：

```js
s !== w && s.close()
```

关闭剩余连接。

---

## 为什么这对 CF 特别有效

Cloudflare Worker socket：

```text
不是传统 Linux socket
```

它底层：

* 有 colo 调度
* 有边缘网络
* 有内部 NAT
* 有 socket sandbox

所以：

```text
某次 connect 卡住非常常见
```

并发 connect 可以降低：

```text
P99 延迟
```

但副作用：

* socket 数量翻倍
* 更像扫描行为
* 更像机器人
* 更容易触发风控

这是为什么你后来想：

```text
concur=1
```

---

# 第七章：VLESS 解析器

代码：

```js
const vless = c => {
```

作用：

解析：

```text
VLESS Header
```

---

## VLESS 数据结构

大概：

```text
version
uuid
addons
command
port
address
payload
```

这里：

```js
const cmd = c[18 + optLen];
```

command：

| cmd | 含义  |
| --- | --- |
| 1   | TCP |
| 2   | UDP |

后面：

```js
if (r.cmd === 2 && port === 53)
```

就是：

```text
UDP DNS 特判
```

---

# 第八章：mkQ 上传队列

这是 GrainTCP 的：

```text
上传方向 grain 聚合器
```

作用：

```text
减少 write 次数
```

核心思想：

```text
多个 websocket message
合并成一次 TCP write
```

---

## 为什么要这样

Cloudflare Workers：

```text
每次 await writer.write()
都很贵
```

因为：

* JS runtime 调度
* promise
* socket bridge
* isolate 切换

都要成本。

所以 GrainTCP 的思路：

```text
少 write
大 write
```

---

## sow()

```js
sow(d)
```

就是：

```text
往队列播种
```

作者故意用了农业命名。

GrainTCP：

```text
grain
sow
reap
ripen
mill
```

全部是农业术语。

---

## bundle()

核心：

```text
合包
```

把多个小包：

```text
merge 成一个 Uint8Array
```

减少 write 次数。

---

# 第九章：mkDn 下载聚合器

这是：

```text
TCP -> WebSocket
```

方向。

和 mkQ 类似。

但是更复杂。

因为：

```text
下载流量通常远大于上传
```

---

# 第十章：ripen() 和 reap()

这是 GrainTCP 最有意思的部分。

---

## reap

```text
收割
```

意思：

```text
立刻发送 buffer
```

---

## ripen

```text
成熟
```

意思：

```text
等一等
看看还有没有小包
```

这是：

```text
微型 batching scheduler
```

非常像：

* Nagle
* delayed ack
* batching reactor

但它是在 JS runtime 做的。

---

## queueMicrotask()

这里非常关键。

```js
queueMicrotask(() => {
```

意思：

```text
当前 event loop 结束后再判断
```

好处：

```text
同一轮 event loop 的多个包
可以自然合并
```

这是 GrainTCP 性能的核心之一。

---

# 第十一章：mill() 数据泵

```js
const mill = async (rd, w) => {
```

mill：

```text
磨坊
```

作用：

```text
把 TCP readable
持续搬运到 websocket
```

---

## 为什么用 BYOB Reader

```js
getReader({ mode: 'byob' })
```

BYOB：

```text
Bring Your Own Buffer
```

意思：

```text
不要内部自动创建 Uint8Array
而是我自己给 buffer
```

作用：

* 减少 GC
* 减少 allocation
* 减少 copy

这在：

```text
大流量 Worker
```

里非常重要。

---

# 第十二章：UDP DNS over DoH

这是你  新增的重要能力。

---

## 为什么 Worker 不适合原生 UDP

Cloudflare Worker：

```text
原生 UDP 支持很有限
```

尤其：

```text
不能随意裸 UDP 出口
```

所以：

```text
UDP DNS -> DoH
```

是最常见方案。

---

## unpackUDP()

VLESS UDP：

```text
不是一个包一个 frame
```

而是：

```text
长度 + 数据
```

所以这里做拆包。

---

## packUDP()

反过来封装。

---

## handleDNSQuery()

核心：

```js
fetch(CFG.doh)
```

Worker 通过 HTTPS 请求：

```text
1.1.1.1/dns-query
```

然后拿回 DNS binary response。

本质：

```text
DNS over HTTPS 隧道
```

---

# 第十三章：ws() 主入口

这是整个系统的核心。

---

## WebSocketPair

```js
const [client, server] = Object.values(new WebSocketPair())
```

Cloudflare Workers 特有。

Worker 内部创建一对 WS。

* 一个返回客户端
* 一个自己处理

---

## allowHalfOpen

```js
server.accept({ allowHalfOpen: true })
```

允许半关闭。

避免：

```text
一端 FIN
另一端立刻断
```

对于代理很重要。

---

# 第十四章：Early Data

代码：

```js
sec-websocket-protocol
```

很多人不知道：

```text
这个 header 可以偷运数据
```

VLESS WS 经常这样做。

作用：

```text
减少一次 RTT
```

即：

```text
WS 建立时直接带 payload
```

这就是：

```text
0-RTT 风格
```

---

# 第十五章：为什么“没有配置 http 代理也能访问 CF 网站”

你之前问到的关键问题。

本质：

```text
Worker 自己就在 Cloudflare 网络里
```

所以：

```text
Worker -> Cloudflare CDN
```

很多时候：

* 不需要额外 proxy
* 不需要 socks
* 不需要回源绕路

因为：

```text
本来就在 CF Backbone 里面
```

所以你会感觉：

```text
怎么没代理也能访问
```

实际上：

```text
Worker 本身已经在 CF 内网生态里
```

---

# 第十六章：smartConnect() 的意义

这是  改造的重要部分。

逻辑：

```text
优先直连
失败再 fallback
```

---

## 为什么不能默认全局 proxy

因为：

```text
proxy 会增加：

- RTT
- TLS
- connect 时间
- 风控特征
```

所以最佳实践：

```text
优先直连
失败再回退
```

这是你  的正确方向。

---

# 第十七章：HTTP CONNECT 原理

HTTP CONNECT：

```http
CONNECT example.com:443 HTTP/1.1
```

本质：

```text
让 HTTP 代理帮你建立 TCP 隧道
```

建立成功后：

```text
后面就变成原始 TCP
```

所以 HTTPS 可以跑。

---

# 第十八章：SOCKS5 原理

SOCKS5 更底层。

流程：

```text
认证
↓
CONNECT
↓
代理建立 TCP
```

SOCKS5：

* 更通用
* 更像原生 socket
* 比 HTTP CONNECT 更底层

---

# 第十九章：为什么 GrainTCP 看起来不像“正常代码”

因为它目标不是：

```text
可维护性
```

而是：

```text
极限 runtime 性能
```

很多写法：

```js
a && b && c
```

或者：

```js
if (!x) return
```

甚至：

```js
const [d] = uq.bundle();
```

都属于：

```text
减少对象
减少变量
减少 branch
```

风格。

非常像：

* demoscene
* code golf
* runtime-oriented JS

不是传统工程代码。

---

# 第二十章：v1 和  的核心区别

---

## v1

特点：

```text
尽量保留 GrainTCP 原始极简风格
```

优点：

* 更接近原版
* 更轻
* 更纯粹
* 更像 snippets

缺点：

* 可读性差
* fallback 不够完整
* DNS 较弱

---

## 

特点：

```text
工程化增强
```

新增：

* smartConnect
* proxy ctx
* DNS DoH
* 更完整 fallback
* 更完整 socks/http

优点：

* 更稳定
* 更适合长期使用
* 更容易继续开发

缺点：

* 代码更长
* runtime 更复杂
* 风控特征略增加

---

# 第二十一章：哪些地方最可能触发 Cloudflare 风控

重点风险：

| 模块                | 风险             |
| ----------------- | -------------- |
| concur > 1        | 多 connect 很像扫描 |
| 大量 proxy fallback | 像中转站           |
| 高频 websocket.send | runtime 异常     |
| DNS over HTTPS 高频 | 像 resolver     |
| 全局 socks5         | 像匿名代理          |
| 长时间大流量            | 容易触发资源限制       |

---

# 第二十二章：最推荐的稳定配置

如果你目标是：

```text
长期稳定
```

建议：

```js
concur: 1
```

并且：

* 优先直连
* 失败 fallback
* 不全局 proxy
* 不做大规模 DNS
* 不做大量 UDP

这是最像：

```text
正常 websocket 应用
```

的行为。

---

# 第二十三章：这份代码真正厉害的地方

很多人会觉得：

```text
不就是一个代理吗
```

但实际上真正厉害的是：

```text
作者非常理解：

Cloudflare Workers 的 runtime 成本模型
```

它优化的不是：

```text
网络协议本身
```

而是：

```text
JS runtime 调度成本
```

这是很多传统代理作者不具备的思维。

GrainTCP 的核心哲学：

```text
减少 runtime 次数
比减少网络包更重要
```

这是非常 Cloudflare-native 的设计。

---

# 第二十四章：后续还能怎么演进

未来方向：

| 方向                   | 价值           |
| -------------------- | ------------ |
| xhttp                | 更像正常 HTTP    |
| h2/h3                | 更像浏览器流量      |
| ECH                  | 提高 TLS 隐蔽性   |
| REALITY 前置           | 混合伪装         |
| QUIC upstream        | 更低延迟         |
| 智能 concur            | 动态并发         |
| 自适应 grain            | 自动调包大小       |
| 多 DoH                | DNS fallback |
| DNS cache            | 降低 DoH 请求数   |
| region-aware routing | 区域优化         |

---

# 最终总结

这份  的本质：

```text
一个兼顾：

- GrainTCP 极简性能风格
- 工程化代理 fallback
- DNS over HTTPS
- Worker runtime 优化

的 Cloudflare VLESS WS 内核
```

它不是传统“完整代理框架”。

而是：

```text
Cloudflare Runtime 上的高性能 socket forwarding engine
```

真正难的地方：

不是协议。

而是：

```text
如何在 CF runtime 的限制下
把 runtime 调度成本压到极低
```

而 GrainTCP 的 grain/bundle/ripen/reap/mill 体系，本质上就是：

```text
把 JS runtime 当成需要优化的“网络栈”
```

这是它最有价值的地方。
