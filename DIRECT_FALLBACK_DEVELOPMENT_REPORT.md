# 直连优先代理回退开发过程汇报

## 1. 本次开发目标与边界

本次在 `test` 分支中，为 Cloudflare Worker 的 VLESS-over-WebSocket TCP 中继增加并修正“显式 HTTP CONNECT / SOCKS5 上游代理”与“直连优先、失败后代理回退”的行为。

目标不是把 Worker 做成复杂的分流器，而是保持以下边界：

```text
客户端负责路由、规则和 DNS 策略。
Worker 负责透明中继，以及在明确配置时选择直连或上游代理。
Worker 默认不承担域名分类、geosite、地区规则、自动 DNS 分流等职责。
```

最终需要同时满足两类用户需求：

```text
A. 我明确要求全局走代理
   → 必须固定走 HTTP CONNECT 或 SOCKS5，不应先暴露一次直连尝试。

B. 我只提供代理作为备用出口
   → 先尝试 Cloudflare Worker 直连目标；只有直连 TCP 建连失败时才走代理。
```

---

## 2. 最终行为定义

### 2.1 Query 参数形式

```text
?socks5=USER:PASS@HOST:PORT&globalproxy
?http=USER:PASS@HOST:PORT&globalproxy
```

行为：强制全局 SOCKS5 或 HTTP CONNECT。不会尝试直连。

```text
?socks5=USER:PASS@HOST:PORT
?http=USER:PASS@HOST:PORT
```

行为：保留代理配置为备用出口。Worker 先尝试直连目标 TCP；只有直连建连失败时，才改走 SOCKS5 或 HTTP CONNECT。

### 2.2 Path 参数形式

```text
/s5=USER:PASS@HOST:PORT
/socks5=USER:PASS@HOST:PORT
/http=USER:PASS@HOST:PORT
```

行为：非全局代理模式，即“先直连、TCP 建连失败后代理回退”。

```text
/gs5=USER:PASS@HOST:PORT
/ghttp=USER:PASS@HOST:PORT
```

行为：强制全局 SOCKS5 或 HTTP CONNECT。

```text
/socks5://USER:PASS@HOST:PORT
/socks://USER:PASS@HOST:PORT
/http://USER:PASS@HOST:PORT
```

行为：为兼容既有语法，仍视为强制全局代理。

---

## 3. 实现结构

当前关键调用链如下：

```text
WebSocket 请求
→ VLESS 头解析
→ getProxyCtx(request)
→ smartConnect(fetcher, targetHost, targetPort, ctx)
→ 直连 TCP 或 HTTP/SOCKS5 隧道
→ 双向字节中继
```

职责分层应保持明确：

| 组件 | 责任 |
|---|---|
| `getProxyCtx()` | 解析 query/path 配置，生成 `globalProxy`、`proxyType`、`parsedProxy`。 |
| `smartConnect()` | 依据上下文选择固定代理、直连，或直连失败后的代理回退。 |
| `raceSprout()` | 创建一个或多个 Cloudflare 出站 TCP 连接，并在其中任一连接打开时返回。 |
| `httpConnect()` | 与 HTTP 代理建立 CONNECT 隧道。 |
| `socks5Connect()` | 与 SOCKS5 代理完成协商、认证和 CONNECT。 |
| `ws()` | 管理 VLESS/WebSocket 会话、首包和双向转发生命周期。 |

---

## 4. 开发过程与关键变更

### 4.1 第一阶段：增加 HTTP / SOCKS5 显式代理能力

初始设计将连接创建收敛到 `smartConnect()`。此时全局代理模式的逻辑是：

```js
const smartConnect = (fetcher, host, port, ctx) =>
  ctx.globalProxy && ctx.proxyType === 'http' ? httpConnect(fetcher, host, port, ctx) :
  ctx.globalProxy && ctx.proxyType === 'socks5' ? socks5Connect(fetcher, host, port, ctx) :
  raceSprout(fetcher, host, port);
```

这一步满足了“我想明确固定走 HTTP 或 SOCKS5”的需求，但尚未具备“直连失败后再走代理”的能力。

### 4.2 第二阶段：修正 SOCKS5 协议实现

在加入回退策略前，对 SOCKS5 逻辑进行了协议正确性修正，避免把协议层问题误判为路由问题。

主要修正包括：

- 用户名和密码在第一个 `:` 处分割，避免密码自身包含 `:` 时被错误拆分。
- 针对 IPv4、域名、IPv6 使用正确的 SOCKS5 `ATYP` 编码。
- 使用精确长度读取，不能假设一次 `reader.read()` 就恰好收到一个 SOCKS5 协议响应。
- 完整消费 SOCKS5 CONNECT 成功响应中的绑定地址和端口字段。
- 使用 UTF-8 字节长度，而不是 JavaScript 字符数，来构造认证字段。

这些修改解决的是 SOCKS5 传输协议可靠性问题，和“是否应该走代理”是两层不同的问题。

### 4.3 第三阶段：加入“直连优先、失败后代理”

`smartConnect()` 被修改为以下策略：

```js
const smartConnect = async (fetcher, host, port, ctx) => {
  if (ctx.globalProxy && ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
  if (ctx.globalProxy && ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);

  try {
    return await raceSprout(fetcher, host, port);
  } catch (directError) {
    if (ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
    if (ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);
    throw directError;
  }
};
```

该设计保留了 `globalproxy` 的最高优先级：一旦用户显式要求全局代理，绝不先走直连。

### 4.4 第四阶段：测试失败，定位到路径解析回归

测试中发现：

```text
/socks5=USER:PASS@HOST:PORT
```

仍无法按预期自动回退到 SOCKS5 或 HTTP。

最初容易怀疑是 `smartConnect()` 的回退逻辑没有捕获到错误，但最终根因在更前面的 `getProxyCtx()` 参数解析层。

新版代码仅识别：

```js
/(gs5|ghttp)=(.+)/i
```

这意味着只有：

```text
/gs5=...
/ghttp=...
```

会形成有效代理配置；而旧版中可用的：

```text
/s5=...
/socks5=...
/http=...
```

没有被识别，导致 `proxyType`、`proxyAddress` 和 `parsedProxy` 为空。

在这种情况下，即使 `smartConnect()` 的 `catch` 被触发，它也没有任何可用代理可以回退。

### 4.5 最终修复：恢复非全局路径别名

最终只修改了 `_worker.direct-fallback.js` 的 `getProxyCtx()` 路径解析逻辑：

```js
} else if ((m = pathname.match(/\/(g?s5|socks5|g?http)=(.+)/i))) {
  const type = m[1].toLowerCase();
  proxyType = type.includes('http') ? 'http' : 'socks5';
  proxyAddress = m[2];
  globalProxy = type.startsWith('g') || globalProxy;
}
```

语义因此恢复为：

```text
s5 / socks5 / http
→ 保留代理配置，但不强制全局；可作为直连失败后的回退出口。

gs5 / ghttp
→ 强制全局代理。
```

用户随后已实际测试确认该行为可用。

---

## 5. 根因复盘

### 根因一：连接策略和参数解析被分开考虑，但未一起验证

`smartConnect()` 中的回退逻辑本身并非主要问题。真正的问题是 `getProxyCtx()` 没有把非全局 Path 配置转换为有效上下文。

结论：

```text
连接层决定“何时回退”。
解析层决定“是否存在可回退的代理”。
两层缺一不可。
```

### 根因二：旧语法兼容性被意外缩窄

旧版本支持：

```text
/s5=...
/socks5=...
/http=...
/gs5=...
/ghttp=...
```

新版本只剩：

```text
/gs5=...
/ghttp=...
```

这不是 HTTP 或 SOCKS5 隧道失败，而是 API/URL 兼容性回归。

### 根因三：错误使用 GitHub Actions 作为补丁通道

开发过程中曾尝试通过一次性 GitHub Actions 修改目标文件。该方式没有实际更新到需要修复的源文件，却被过早报告为已完成。

这是流程错误。后续已改为直接更新目标文件，并立即回读 `test` 分支的对应行进行确认。

应固化为纪律：

```text
源文件修改应直接写入目标文件。
改完必须回读同一分支、同一路径、同一段代码。
没有回读验证，不得宣称已完成。
```

---

## 6. 哪些做法有效

- `smartConnect()` 作为唯一连接策略入口，结构上是正确的。
- `globalproxy` 始终优先于直连，是必须保留的手工确定性控制。
- SOCKS5 协议修复与路由策略修改分开推进，便于定位问题。
- 最终修复仅改路径解析，没有影响 VLESS、WebSocket、缓冲、HTTP CONNECT 或 SOCKS5 主流程。
- 最终直接回读 `_worker.direct-fallback.js`，确认非全局 Path 别名已真实写入 `test` 分支。

---

## 7. 哪些做法无效或应避免

- 仅修改 `smartConnect()`，却不检查 `getProxyCtx()` 是否保留了非全局代理上下文。
- 把 `/gs5=`、`/ghttp=` 的存在误认为等同于旧版 `/s5=`、`/socks5=`、`/http=` 均可用。
- 未验证目标文件是否实际改变，就报告“已修复”。
- 使用临时 GitHub Actions 作为普通源码补丁机制。
- 在未确认根因前增加额外 wrapper 入口文件，造成额外路径和部署复杂度。

---

## 8. 当前能力边界

当前“自动切换”的严格定义是：

```text
直连 TCP 在 socket.opened 之前失败
→ 可回退到配置好的 SOCKS5 或 HTTP CONNECT。

直连 TCP 已经打开，但后续 TLS / WSS / HTTP / 上游应用协议失败
→ 当前实现不会自动切换出口。
```

原因是 `raceSprout()` 成功只表示 Cloudflare 的出站 TCP socket 已打开；它不代表 TLS 握手、WebSocket Upgrade、SNI、远端策略或应用层请求已经成功。

因此，不能将当前功能描述为“所有 Cloudflare CDN、TLS 或应用层失败都可自动切换”。它是：

```text
直连 TCP 建连失败时的代理回退。
```

对于明确要固定走代理的目标，应继续使用：

```text
?http=...&globalproxy
?socks5=...&globalproxy
/gs5=...
/ghttp=...
```

---

## 9. 推荐测试矩阵

后续任何修改前，应至少覆盖以下组合：

| 场景 | URL 形式 | 预期 |
|---|---|---|
| 仅直连 | 无代理参数 | 只直连；直连失败即失败。 |
| Query SOCKS5 回退 | `?socks5=...` | 直连优先；直连 TCP 失败后 SOCKS5。 |
| Query HTTP 回退 | `?http=...` | 直连优先；直连 TCP 失败后 HTTP CONNECT。 |
| Query 强制 SOCKS5 | `?socks5=...&globalproxy` | 只走 SOCKS5。 |
| Query 强制 HTTP | `?http=...&globalproxy` | 只走 HTTP CONNECT。 |
| Path SOCKS5 回退 | `/s5=...` | 直连优先；失败后 SOCKS5。 |
| Path SOCKS5 回退 | `/socks5=...` | 直连优先；失败后 SOCKS5。 |
| Path HTTP 回退 | `/http=...` | 直连优先；失败后 HTTP CONNECT。 |
| Path 强制 SOCKS5 | `/gs5=...` | 只走 SOCKS5。 |
| Path 强制 HTTP | `/ghttp=...` | 只走 HTTP CONNECT。 |
| 旧强制路径 | `/socks5://...` | 只走 SOCKS5。 |
| 旧强制路径 | `/http://...` | 只走 HTTP CONNECT。 |

测试时必须区分：

```text
直连 TCP 建连失败
与
直连 TCP 成功、但后续 TLS / 应用层失败
```

当前代码仅承诺前者触发回退。

---

## 10. 后续开发建议

### 10.1 低风险优先项

1. 增加非敏感诊断模式。
   - 记录选中的路由：`direct`、`socks5-global`、`http-global`、`socks5-fallback`、`http-fallback`。
   - 记录失败阶段：直连打开、代理打开、SOCKS5 认证、SOCKS5 CONNECT、HTTP CONNECT。
   - 禁止记录 UUID、代理账号密码、完整 query、目标 payload。

2. 为 `getProxyCtx()` 增加自动化参数测试。
   - 覆盖所有 query/path 语法。
   - 明确断言 `proxyType` 和 `globalProxy`。
   - 覆盖 URL 编码、IPv6 代理地址、密码含保留字符等情况。

3. 为 SOCKS5 / HTTP CONNECT 增加协议测试。
   - 分片响应。
   - 合并响应。
   - IPv4、域名、IPv6 目标。
   - 有认证与无认证代理。

### 10.2 高复杂度实验方向：首包确认后回退

仅当“直连 TCP 已打开、但早期 TLS/WSS 失败”成为明确且可复现的核心需求时，再建立独立实验入口文件，不应直接塞入稳定 Worker。

该设计至少需要：

```text
- 保存有上限的客户端首批 payload。
- 在收到第一个上游字节前，不提交当前出口为成功。
- 若首个上游字节前发生 EOF、错误或超时，关闭当前直连 socket。
- 改走备用 HTTP/SOCKS5，并只重放一次首批 payload。
- 一旦已将任何上游数据交给客户端，禁止再切换出口。
- 明确限制：首包缓存大小、确认超时、重试次数、内存上限。
```

该方案会改变会话、内存和重传语义，必须单独测试，不得作为“简单 fallback”直接上线。

---

## 11. 本次开发沉淀原则

```text
参数解析决定是否存在备用出口。
连接策略决定何时使用备用出口。

`globalproxy` 必须一直是显式强制代理开关。

TCP socket 打开，不等于 TLS 或应用层成功。

实现能覆盖多大范围，就只能宣称多大范围。

修改仓库时，直接修改目标文件；改后回读同分支同文件；确认后再报告完成。
```
