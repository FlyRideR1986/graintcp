# `graintcp` 后续开发 Agent 指南

## 1. 项目使命与架构边界

本仓库维护的是一个轻量 Cloudflare Worker：通过 WebSocket 接收 VLESS 流量，并以 TCP 方式中继到目标地址；必要时可经显式配置的 HTTP CONNECT 或 SOCKS5 上游代理建立连接。

核心原则：

```text
客户端决定“访问什么、哪些流量走什么路径”。
Worker 负责“按当前请求配置建立连接并转发字节”。

默认情况下，Worker 不是域名分流器，不承担 geosite、地区规则、DNS 分类或自动策略路由。
```

在 `test` 分支中，可能存在多个 Worker 入口文件。修改前必须确认真实部署入口，不能因文件名相似而假设某个文件正在运行。

---

## 2. 必须遵守的工作流程

### 2.1 先确认目标

在修改任何内容前，必须明确：

```text
1. 仓库：FlyRideR1986/graintcp
2. 分支：用户指定的分支；当前通常为 test
3. 文件：用户实际部署的入口文件或明确要求修改的文件
```

不要根据记忆修改。必须从目标分支读取当前文件内容和 blob SHA。

### 2.2 直接修改目标文件

普通源码或文档修改应直接调用 GitHub 文件更新接口，写入用户指定分支和目标路径。

禁止把 GitHub Actions 当成普通补丁通道、代码生成器或间接编辑方案，除非用户明确要求创建工作流。

禁止以“新建一个 wrapper 文件”替代用户要求修复的原文件，除非用户明确要求新增替代入口。

### 2.3 只做最小必要改动

用户要求修复一个行为时，只改负责该行为的层级：

```text
- 参数语法/兼容性问题 → getProxyCtx()
- 路由选择问题 → smartConnect()
- SOCKS5 协议问题 → socks5Connect()
- HTTP CONNECT 问题 → httpConnect()
- VLESS/WebSocket 生命周期问题 → ws()
```

不要在同一补丁中顺带重构缓冲队列、VLESS 解析、并发参数、代码格式或无关注释。

### 2.4 改后必须回读验证

写入后必须从同一分支、同一路径回读关键行，确认：

```text
- blob SHA 已变化；
- 目标代码确实已出现；
- 分支没有被写错；
- 没有残留临时 workflow、测试文件、生成器或无用 wrapper。
```

没有回读验证，不得报告“已完成”或“已修复”。

### 2.5 报告必须准确

每次完成修改后，说明：

```text
- 修改的分支
- 修改的文件
- 提交 SHA
- 用户可见的行为变化
- 已知限制
```

除非有真实端到端网络测试证据，否则不得声称“流量已验证成功”。静态检查、代码审查、语法检查不等于网络实测。

---

## 3. 当前系统调用链

核心调用路径如下：

```text
WebSocket 请求
→ VLESS 头解析
→ getProxyCtx(request)
→ smartConnect(fetcher, targetHost, targetPort, ctx)
→ 直连 TCP 或 HTTP/SOCKS5 隧道
→ 双向字节中继
```

主要函数职责：

| 函数 | 职责 |
|---|---|
| `getProxyCtx()` | 解析 query/path 中的代理参数，生成 `globalProxy`、`proxyType`、`parsedProxy`。 |
| `smartConnect()` | 选择固定全局代理、直连、或直连失败后的代理回退。 |
| `raceSprout()` | 并行发起一个或多个 TCP 连接，并在任一 socket 打开后返回。 |
| `httpConnect()` | 与 HTTP 代理建立 CONNECT 隧道。 |
| `socks5Connect()` | 完成 SOCKS5 协商、认证与 CONNECT。 |
| `ws()` | 管理 VLESS/WebSocket 会话、初始 payload 和双向中继。 |

不要混淆这些责任边界。

---

## 4. 路由行为契约

### 4.1 优先级

```text
1. 用户显式指定 globalproxy
   → 立即走指定代理，不尝试直连。

2. 用户配置了代理但未指定 globalproxy
   → 先尝试直连 TCP。
   → 只有直连 TCP 建连失败，才使用指定代理。

3. 用户未配置代理
   → 仅直连。
```

### 4.2 非全局回退语法

```text
?socks5=USER:PASS@HOST:PORT
?http=USER:PASS@HOST:PORT

/s5=USER:PASS@HOST:PORT
/socks5=USER:PASS@HOST:PORT
/http=USER:PASS@HOST:PORT
```

解析后必须保留：

```js
{
  globalProxy: false,
  proxyType: 'socks5' | 'http',
  parsedProxy: { username, password, hostname, port }
}
```

### 4.3 强制全局代理语法

```text
?socks5=USER:PASS@HOST:PORT&globalproxy
?http=USER:PASS@HOST:PORT&globalproxy

/gs5=USER:PASS@HOST:PORT
/ghttp=USER:PASS@HOST:PORT

/socks5://USER:PASS@HOST:PORT
/socks://USER:PASS@HOST:PORT
/http://USER:PASS@HOST:PORT
```

解析后必须保留：

```js
{
  globalProxy: true,
  proxyType: 'socks5' | 'http',
  parsedProxy: { username, password, hostname, port }
}
```

### 4.4 `getProxyCtx()` 的关键不变量

未带 `globalproxy` 的有效代理配置，不得被丢弃。

正确逻辑：

```js
if (!(proxyType && proxyAddress)) {
  return { globalProxy: false, proxyType: null, parsedProxy: {} };
}
return { globalProxy, proxyType, parsedProxy: parseProxyAddress(proxyAddress) };
```

历史错误逻辑：

```js
if (!(globalProxy && proxyType && proxyAddress)) {
  return { globalProxy: false, proxyType: null, parsedProxy: {} };
}
```

错误版本会使所有非全局代理上下文消失，导致 `smartConnect()` 即使捕获到直连失败，也没有可用的 HTTP/SOCKS5 备用出口。

---

## 5. 连接行为与能力边界

### 5.1 当前回退仅覆盖 TCP 建连失败

当前的路由回退判断基于 direct socket 是否成功达到 `socket.opened`：

```text
直连 socket 在 opened 前失败
→ 可以转入 HTTP / SOCKS5 回退。

直连 socket 已打开，但 TLS / WSS / HTTP / 应用层随后失败
→ 当前不会自动换出口。
```

不得将当前能力描述为完整端到端 failover。

### 5.2 为什么不能在首包发出后盲目重试

对 TLS 而言，客户端首包通常是 ClientHello。它写入直连 socket 后，若上游随后关闭，客户端并不会自动对新 socket 再发一次同样的 ClientHello。

若要支持该情形，需要单独实现“首包缓存 + 上游首字节确认 + 一次性重放”的状态机；这不是简单的 `catch` 回退。

### 5.3 未来实验性方案

只有在该需求被明确确认后，才应以新的实验入口文件开发。至少应包括：

```text
- 对客户端首批 payload 设置严格大小上限的 replay buffer；
- 在收到第一个上游字节前，不提交当前路线为成功；
- 首字节前出现 EOF、错误或超时，则关闭当前 socket；
- 通过备用 HTTP/SOCKS5 建连，并仅重放一次缓存数据；
- 一旦任何上游字节已发送给客户端，禁止再切换路线；
- 明确限制缓存大小、确认超时、重试次数和内存占用。
```

该实验不得悄然加入稳定入口文件。

---

## 6. SOCKS5 实现要求

### 6.1 目标地址编码

应按照目标类型正确使用 SOCKS5 `ATYP`：

```text
IPv4    → 0x01 + 4 字节
域名    → 0x03 + 长度 + UTF-8 域名字节
IPv6    → 0x04 + 16 字节
```

优先保留 VLESS 原始地址类型；若必须将地址转换为字符串后重新判断，必须覆盖 IPv4、IPv6、域名三类情况。

### 6.2 流式读取

不能假设一次 `reader.read()` 等于一个完整 SOCKS5 协议消息。

必须使用精确长度读取来处理：

```text
- 方法选择响应
- 用户名/密码认证响应
- CONNECT 响应头
- 可变长度绑定地址与端口
```

### 6.3 认证信息

- 用户名和密码只在第一个 `:` 处分割。
- 使用 UTF-8 字节长度，不要使用 JavaScript 字符数。
- 单个用户名或密码最长 255 字节。
- query 参数中的 `+`、`&`、`#` 等保留字符需要 URL 编码。

---

## 7. HTTP CONNECT 实现要求

- 必须读取到 `\r\n\r\n` 后再判断 CONNECT 响应。
- 应接受全部 2xx CONNECT 成功响应，不能只硬编码某一行文本。
- CONNECT 响应头之后已经收到的字节可能属于隧道数据，不能丢弃。
- 正确释放 reader/writer lock。
- 错误与诊断中不得输出代理账号密码。

---

## 8. 配置与安全要求

### 8.1 UUID

测试入口文件中的 `CFG.id` 可能为空。除非用户明确要求将 UUID 写入仓库，否则不要提交生产 UUID。

### 8.2 禁止提交的内容

```text
- 生产 VLESS UUID
- SOCKS5/HTTP 代理用户名、密码
- 非公开且未经用户明确允许的代理地址
- 真实流量 payload
- 包含敏感 query 的完整访问 URL
```

### 8.3 诊断日志原则

未来若添加诊断，只允许输出低敏感结构化事件，例如：

```text
route=direct
route=socks5-fallback
route=http-global
stage=direct-open
stage=socks5-auth
stage=http-connect
```

不得记录完整 URL、query、用户名密码、UUID 或 payload 字节。

---

## 9. 测试要求

### 9.1 静态检查

提交前至少确认：

```text
- JavaScript 语法正确；
- path 正则覆盖计划支持的别名；
- 非全局配置能生成有效 proxy context；
- 全局配置一定会设置 globalProxy=true；
- 未改动无关模块；
- 无临时 workflow 或辅助文件残留。
```

### 9.2 功能测试矩阵

| 模式 | 必测内容 |
|---|---|
| 仅直连 | 未配置代理时，直连目标可用。 |
| Query SOCKS5 回退 | `?socks5=...` 下，直连可用目标仍直连；直连建连失败时可走 SOCKS5。 |
| Query HTTP 回退 | `?http=...` 下，直连建连失败时可走 HTTP CONNECT。 |
| Query 强制 SOCKS5 | `?socks5=...&globalproxy` 不应尝试直连。 |
| Query 强制 HTTP | `?http=...&globalproxy` 不应尝试直连。 |
| Path SOCKS5 回退 | `/s5=...` 和 `/socks5=...`。 |
| Path HTTP 回退 | `/http=...`。 |
| Path 强制 SOCKS5 | `/gs5=...`。 |
| Path 强制 HTTP | `/ghttp=...`。 |
| 旧强制路径 | `/socks5://...`、`/socks://...`、`/http://...`。 |

实测时必须区分：

```text
直连 TCP 建连失败
与
直连 TCP 成功后才发生 TLS / 应用层失败
```

目前仅前者在功能承诺范围内。

---

## 10. 修改纪律

### 应做

- 保留 `globalproxy` 作为强制代理的明确手工开关。
- 将连接路线选择集中在 `smartConnect()`。
- 将语法兼容性集中在 `getProxyCtx()`。
- 实验功能使用独立入口文件，并明确标注实验性质。
- 直接修改用户指定文件，随后回读验证。
- 对重要路由行为更新 `DIRECT_FALLBACK_DEVELOPMENT_REPORT.md`。

### 不应做

- 默认增加域名分类、geosite、DNS 分流或 Worker 内部自动路由。
- 用 GitHub Actions 代替直接源码更新。
- 未经要求创建 wrapper 入口替换原入口。
- 静默废弃已有 URL 语法。
- 将协议正确性修改、路由策略修改和无关重构混在一个未经验证的补丁中。
- 没有真实流量证据时声称功能已在网络上验证。

---

## 11. 文档同步要求

凡是涉及路由行为、参数语法、回退边界或协议实现的重要变更，必须同步更新：

```text
DIRECT_FALLBACK_DEVELOPMENT_REPORT.md
```

文档至少应说明：

```text
- 用户可见行为；
- 支持的准确语法；
- 本次问题根因；
- 实际改动；
- 明确不支持的能力；
- 测试证据及其边界。
```

本 `AGENT.md` 与过程报告必须始终和 `test` 分支当前代码保持一致。
