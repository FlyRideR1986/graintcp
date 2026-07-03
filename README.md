# GrainTCP — `test` 分支

`test` 基于 `main` 的 **VLESS over WebSocket + TCP relay** 主路径，增加一个边界明确的出口能力：**显式全局 HTTP CONNECT / SOCKS5 代理模式**。

推荐部署入口是 [`_worker.js`](./_worker.js)。该文件保留原有 VLESS、WebSocket、上传/下载 grain 合包和 BYOB 下行路径；代理能力只在 Worker URL 明确指定时启用。

## 设计边界

```text
客户端决定这一条流量使用 Direct 节点还是 Global Proxy 节点
    ↓
Worker 只执行当前 URL 指定的连接方式
    ↓
Direct URL：只直连目标
Global Proxy URL：只经指定 HTTP CONNECT / SOCKS5 入口
```

本分支不做以下事情：

- 不在 Worker 内按域名、IP、CIDR 或 Cloudflare 网段自动分流；
- 不做 Worker 侧 DNS 预解析、DoH 分类或 UDP DNS 转发；
- 不提供 ProxyIP、直连失败后自动代理回退、多个代理入口负载均衡或健康检查；
- 不把“匿名代理不可用”伪装成证书校验可忽略的问题。

分流、DNS 策略与节点选择应由客户端完成，例如 Karing、Mihomo、sing-box 或 Xray。

## 部署

1. 打开 [`_worker.js`](./_worker.js)。
2. 填写顶部配置中的 VLESS UUID：

```js
const CFG = {
  id: 'your-uuid-here',
  // ...
};
```

3. 将文件作为 Cloudflare Worker 的模块脚本部署。
4. 客户端使用与 `CFG.id` 相同的 UUID 创建 VLESS over WebSocket 节点。

当前代码中的 `id` 默认值为空字符串；不填写实际 UUID 不应视为可用配置。

## 连接模式

### 1. Direct：默认直连

没有完整有效的全局代理配置时，行为与 `main` 一致：

```text
VLESS Client
  ↓
Cloudflare Worker
  ↓ request.fetcher.connect(target)
Target
```

示例：

```text
https://your-worker.example.com/
```

Direct 模式只尝试连接目标；失败后不会自动改走 HTTP、SOCKS5、ProxyIP 或其他回退路径。

### 2. Global SOCKS5：所有 TCP 目标经 SOCKS5

Query 形式：

```text
https://your-worker.example.com/?socks5=user:password@socks.example.com:1080&globalproxy
```

路径形式，天然启用全局代理：

```text
https://your-worker.example.com/socks5://user:password@socks.example.com:1080
https://your-worker.example.com/gs5=user:password@socks.example.com:1080
```

链路：

```text
VLESS Client
  ↓
Cloudflare Worker
  ↓ TCP connect SOCKS5 entry
  ↓ SOCKS5 CONNECT targetHost:targetPort
Target
```

仅带 `socks5=...`、但没有 `globalproxy` 时，仍按 Direct 处理：

```text
?socks5=user:password@socks.example.com:1080
```

这是刻意设计，避免代理地址参数被意外带入时改变出口语义。

### 3. Global HTTP CONNECT：所有 TCP 目标经 HTTP 代理

Query 形式：

```text
https://your-worker.example.com/?http=user:password@proxy.example.com:8080&globalproxy
```

路径形式：

```text
https://your-worker.example.com/http://user:password@proxy.example.com:8080
https://your-worker.example.com/ghttp=user:password@proxy.example.com:8080
```

链路：

```text
VLESS Client
  ↓
Cloudflare Worker
  ↓ TCP connect HTTP proxy entry
  ↓ HTTP CONNECT targetHost:targetPort
Target
```

HTTP 代理必须支持 `CONNECT` 隧道。只支持普通 HTTP 请求转发、不允许 `CONNECT` 的 HTTP 代理无法承载 HTTPS/TLS 等通用 TCP relay 流量。

## 代理地址格式

支持：

```text
user:password@host:port
host:port
user:password@[IPv6]:port
```

示例：

```text
socks.example.com:1080
alice:secret@socks.example.com:1080
alice:secret@[2001:db8::10]:1080
```

注意：

- SOCKS5 请显式填写端口，通常为 `1080`。省略端口时当前代码使用 `80`，通常不是预期值。
- 用户名或密码含 `@`、`:`、`/`、`?`、`#`、`&`、`=` 等 URL 保留字符时，必须先进行 URL percent-encoding。
- HTTP Basic 认证仅在用户名和密码都存在时发送 `Proxy-Authorization`。
- SOCKS5 会根据是否提供完整用户名/密码，分别请求 `NO AUTH` 或 `NO AUTH + USER/PASS` 方法。
- Worker 必须能直接 TCP 连接代理入口。不要把 SOCKS/HTTP 入口部署在 Cloudflare 橙云代理后的地址上，否则 Worker 到代理入口的 TCP 建连仍可能受平台限制。

## 认证代理与匿名代理

代码支持无认证 HTTP CONNECT 与无认证 SOCKS5，但“请求不带账号密码”不等于上游服务一定提供可用的匿名出口。

```text
带认证：
Worker → 已认证代理用户 → 用户对应的出口 / ACL / DNS / 配额

不带认证：
Worker → 匿名或默认代理路径 → 服务端定义的出口 / ACL / 限制
```

若带账号密码可用，而无认证出现以下现象：

```text
SOCKS5：TLS x509 unknown authority
HTTP CONNECT：EOF 或 CONNECT 前断开
```

优先判断为上游代理的匿名路径、默认出口、DNS、ACL、透明 TLS 检查或来源限制异常，而不是 VLESS、WebSocket、Worker 竞速或 SOCKS5 地址编码问题。

不要通过关闭客户端证书校验来绕过 `x509: certificate signed by unknown authority`。这只会掩盖异常证书或错误出口；Worker 不参与内层 TLS 证书签发与校验。

## 连接竞速

当前配置将“目标直连竞速”和“代理入口建连”分开：

```js
const CFG = {
  // ...
  concur: 4,
  proxyConcur: 1
};
```

| 配置 | 作用 | 默认值 |
| --- | --- | --- |
| `concur` | Direct 模式下，Worker 到目标 TCP endpoint 的并发拨号数 | `4` |
| `proxyConcur` | Global SOCKS/HTTP 模式下，Worker 到代理入口的并发拨号数 | `1` |

Direct 模式：

```text
Worker → Target
```

Global SOCKS/HTTP 模式：

```text
Worker → Proxy Entry → Target
```

代理入口通常是单一 `host:port`，默认使用 `proxyConcur: 1`，避免无意义的重复登录、重复 CONNECT、额外 socket 消耗及匿名入口风控。

只有在确认代理域名背后确实有多个独立机房或 IP，且并发拨号经实测能改善成功率时，才考虑将 `proxyConcur` 提高到 `2`。不建议默认设为 `4`。

## HTTP CONNECT 实现要点

`_worker.js` 的 HTTP CONNECT 路径具备以下行为：

- 代理入口单路连接；
- 发送标准 `CONNECT authority HTTP/1.1`、`Host`、`Connection`、`Proxy-Connection` 与可选 Basic 认证头；
- 接受所有 `2xx` CONNECT 成功状态，而不是只接受 `200`；
- 以字节方式查找 `\r\n\r\n`，限制 CONNECT 响应头最大 `8192` 字节；
- 若 HTTP 代理响应头后已经粘连目标隧道数据，会先回灌这部分数据，再继续读取原始 socket；
- 回灌流保持 byte stream 形态，兼容主路径的 BYOB 下行读取。

因此，HTTP CONNECT 响应与后续 TLS 数据恰好同包返回时，不会吞掉首段目标数据。

## SOCKS5 实现要点

`_worker.js` 的 SOCKS5 路径：

- 支持无认证和用户名/密码认证；
- IPv4 使用 SOCKS5 `ATYP=0x01`；
- 域名使用 `ATYP=0x03`；
- VLESS 当前解析输出的 IPv6 使用 `ATYP=0x04`；
- SOCKS5 方法协商、认证回复与 CONNECT 回复使用定长读取；
- 完整消费 CONNECT 回复中的 `BND.ADDR + BND.PORT`，避免剩余协议字节污染后续目标隧道数据。

## 客户端分流建议

建议建立至少两个逻辑节点：

```text
Worker-Direct
  URL：不带 globalproxy
  Worker 行为：只直连目标

Worker-Global-SOCKS 或 Worker-Global-HTTP
  URL：带完整代理地址和 globalproxy，或使用 /gs5=...、/ghttp=...
  Worker 行为：所有目标只经指定代理入口
```

然后由客户端规则选择节点：

```text
命中需要特定出口的目标 IP / 域名 / 规则集
  → Worker-Global-SOCKS 或 Worker-Global-HTTP

其他流量
  → Worker-Direct
```

这样可以避免 Worker 自行进行 DNS、CIDR 或“先直连后回退”的不确定决策。

## 核心转发路径

```text
VLESS over WebSocket
  → 解析 UUID / 目标地址 / 端口
  → 根据当前 Worker URL 选择 Direct 或 Global Proxy
  → 直连目标，或建立到 HTTP/SOCKS5 入口的 TCP 隧道
  → 上传侧机会性 grain 合包后写入
  → 下载侧大包直发 / 小包 grain 合包后回传
```

## 当前配置

| 变量 | 意义 | 默认值 |
| --- | --- | --- |
| `id` | VLESS UUID，部署前必须填写 | `''` |
| `chunk` | BYOB 读取块大小 | `64 * 1024` |
| `dnPack` | 下载侧 grain 聚合上限 | `32 * 1024` |
| `dnTail` | 下载侧尾部阈值 | `512` |
| `dnQr` | 下载侧连续增长观察轮次 | `4` |
| `upPack` | 上传侧合包目标 | `20 * 1024` |
| `maxED` | early data 上限 | `8 * 1024` |
| `concur` | Direct 目标连接并发拨号数 | `4` |
| `proxyConcur` | HTTP/SOCKS 代理入口并发拨号数 | `1` |

## 文件

| 文件 | 说明 |
| --- | --- |
| [`_worker.js`](./_worker.js) | 推荐部署入口：VLESS TCP relay、显式全局 HTTP/SOCKS5、单路代理入口、HTTP CONNECT 残留字节回灌、grain 合包与 BYOB 转发 |
| [`GrainTCP.js`](./GrainTCP.js) | 较早的 test 分支实现，保留用于对比；不作为当前推荐部署入口 |
| [`_worker_edgetunnel_proxy.js`](./_worker_edgetunnel_proxy.js) | EdgeTunnel 风格 HTTP/SOCKS A/B 对照文件；不作为当前推荐部署入口 |

## 相关链接

- 开源协议：[GPL-3.0](./LICENSE)
- 原始项目：<https://github.com/ToiCF/GrainTCP>
- fast-webstreams：<https://github.com/vercel-labs/fast-webstreams>
- iter-streams：<https://github.com/WinterTC55/iter-streams>
- 频道 / 交流群组：<https://t.me/Enkelte_notif>

## Stargazers over time

[![Stargazers over time](https://starchart.cc/ToiCF/GrainTCP.svg?variant=adaptive)](https://starchart.cc/ToiCF/GrainTCP)