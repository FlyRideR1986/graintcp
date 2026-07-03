# GrainTCP — test 分支

`test` 基于 `main` 创建，保留原版的 **VLESS over WebSocket + TCP relay** 主路径与小包传输优化；本分支只额外加入一个明确、可控的出口能力：**显式全局 HTTP CONNECT / SOCKS5 代理模式**。

本分支不尝试在 Worker 端判断目标是否属于 Cloudflare CDN，也不做 DNS 预解析、ProxyIP 回退或“直连失败后自动改走代理”。目标的分流与节点选择应由客户端完成；Worker 只执行当前 URL 明确指定的连接方式。

## 本分支与 `main` 的差异

| 项目 | `main` | `test` |
| --- | --- | --- |
| VLESS + WebSocket TCP relay | 保留 | 保留，不改主状态机与转发逻辑 |
| `request.fetcher.connect()` 直连 | 保留 | 保留 |
| 并发连接竞速 `concur` | 保留 | 保留，默认值仍为 `4` |
| HTTP CONNECT 出口 | 无 | 新增，仅在显式全局模式启用 |
| SOCKS5 出口 | 无 | 新增，仅在显式全局模式启用 |
| 自动失败回退到 HTTP/SOCKS | 无 | 不做 |
| ProxyIP fallback | 无 | 不做 |
| Worker 侧按目标 IP/CIDR 分流 | 无 | 不做 |
| Worker 侧 DNS 分类或 UDP DNS -> DoH | 无 | 不做 |

核心原则：

```text
客户端决定“这一条流量该使用哪个 Worker 节点”
    ↓
Worker 只执行节点 URL 指定的模式
    ↓
Direct URL 只直连；Global Proxy URL 只走指定 HTTP/SOCKS 代理
```

## 连接模式

### 1. Direct：默认直连

Worker URL 没有完整有效的全局代理配置时，行为与 `main` 一致：

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

此模式只有一次连接策略：直接连接目标。连接失败时会关闭当前会话，**不会**自动再尝试 HTTP、SOCKS5、ProxyIP、DoH 分类或其他回退路径。

### 2. Global SOCKS5：所有 TCP 目标经 SOCKS5

在 URL 中同时提供 SOCKS5 地址与 `globalproxy`：

```text
https://your-worker.example.com/?socks5=user:password@socks.example.com:1080&globalproxy
```

链路为：

```text
VLESS Client
  ↓
Cloudflare Worker
  ↓ TCP connect SOCKS5 server
  ↓ SOCKS5 CONNECT targetHost:targetPort
Target
```

只提供 `socks5` 而不提供 `globalproxy` 不会启用代理：

```text
?socks5=user:password@socks.example.com:1080
```

上述形式仍按 Direct 处理。这是刻意设计：避免某个仅携带代理地址的 URL 意外改变出口语义。

### 3. Global HTTP CONNECT：所有 TCP 目标经 HTTP 代理

```text
https://your-worker.example.com/?http=user:password@proxy.example.com:8080&globalproxy
```

链路为：

```text
VLESS Client
  ↓
Cloudflare Worker
  ↓ TCP connect HTTP proxy
  ↓ HTTP CONNECT targetHost:targetPort
Target
```

HTTP 代理需要支持 `CONNECT`。普通只支持 HTTP 请求转发、但不允许 `CONNECT` 隧道的代理不能用于 TLS/HTTPS 等 TCP relay 场景。

## 推荐的路径写法

部分客户端导入 VLESS WebSocket 节点时，对 query string 的保留或编辑并不方便。为此，本分支同时支持路径形式；路径形式天然启用全局代理。

### SOCKS5

```text
/socks5://user:password@socks.example.com:1080
```

或更简短：

```text
/gs5=user:password@socks.example.com:1080
```

### HTTP CONNECT

```text
/http://user:password@proxy.example.com:8080
```

或更简短：

```text
/ghttp=user:password@proxy.example.com:8080
```

完整 URL 示例：

```text
https://your-worker.example.com/gs5=user:password@socks.example.com:1080
https://your-worker.example.com/ghttp=user:password@proxy.example.com:8080
```

`/socks5://...`、`/http://...`、`/gs5=...`、`/ghttp=...` 与 query 形式的区别只在传参方式；最终都是全局代理，不存在“先直连、失败再走代理”。

## 代理地址格式

使用以下格式：

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

注意事项：

- SOCKS5 请显式写端口，通常是 `1080`；省略端口时代码会使用 `80`，通常不是你想要的结果。
- 用户名或密码包含 `@`、`:`、`/`、`?`、`#`、`&`、`=` 等 URL 保留字符时，应先进行 URL percent-encoding；否则 URL 解析可能把它们误识别为分隔符。
- HTTP Basic 认证仅在用户名和密码都存在时发送 `Proxy-Authorization`。
- SOCKS5 支持无认证与用户名/密码认证。
- Worker 必须能够直接连接代理入口本身。不要把 SOCKS/HTTP 入口部署在 Cloudflare 代理后的地址上，否则 Worker 到代理入口的连接仍可能被平台限制。

## 客户端分流职责

这个分支刻意不在 Worker 内做“智能分流”。建议把规则留在具备多节点 / outbound 路由能力的客户端中，例如 Karing、Mihomo、sing-box 或完整 Xray 配置。

可建立两个逻辑节点：

```text
Worker-Direct
  URL：不带 globalproxy
  Worker 行为：只直连目标

Worker-Global-SOCKS
  URL：带 socks5=...&globalproxy，或 /gs5=...
  Worker 行为：所有目标只经 SOCKS5
```

然后由客户端规则选择节点，例如：

```text
命中需要代理出口的目标 IP / 域名 / 规则集
  → Worker-Global-SOCKS

其他代理流量
  → Worker-Direct
```

这样做的好处是：

- Worker 不必为每一条连接额外 DNS 解析或 CIDR 判断；
- 不会发生“Worker 先直连一次、失败后再 SOCKS5”的无效尝试；
- 分流规则、DNS 策略和节点选择集中在客户端，便于观察与维护；
- Worker 代码只保留基础 TCP relay 与明确出口语义。

对于只支持“直连 / 当前代理 / 阻断”、但不能按规则选择不同代理节点的客户端，应在客户端选择一个固定模式：要么使用 Direct URL，要么使用 Global SOCKS/HTTP URL。不要期待本分支在后台自动补足分流。

## 并发连接 `concur`

本分支保留 `main` 的：

```js
concur: 4
```

它表示同一个 TCP endpoint 最多同时发起四次建连，最先成功的 socket 被保留，其余后续成功的连接关闭。

在 Direct 模式下，竞速对象是：

```text
Worker → Target
```

在 Global SOCKS/HTTP 模式下，竞速对象变为：

```text
Worker → SOCKS / HTTP proxy entry
```

之后只有胜出的那一条连接继续执行 SOCKS5 握手或 HTTP CONNECT。因此 `concur: 4` 不会向目标站发送四次 SOCKS CONNECT / HTTP CONNECT；它只会放大 Worker 到代理入口这一跳的 TCP 建连。

取舍：

- Workers / Pages 形态：保留 `4`，延续原版的并发拨号策略；
- Snippets 或希望减少连接放大：手动将 `concur` 改为 `1`；
- 同一个代理入口的 `concur > 1` 不是多出口容灾，只是同一入口的建连竞速。

## 当前边界

本分支是 TCP relay，不是完整通用代理平台：

- 只处理 VLESS TCP 主路径；不实现 VLESS UDP / UDP DNS 转 DoH；
- 不解析目标 DNS，不维护 Cloudflare CIDR，不判断目标是否可由 Worker 直连；
- 不提供 ProxyIP；
- 不提供直连失败后的自动 HTTP/SOCKS 回退；
- 不提供多个 HTTP/SOCKS 入口的负载均衡或健康检查；
- SOCKS5 目标请求按域名字段发送目标地址；对字面 IPv6 目标的兼容性取决于 SOCKS5 服务端是否接受该形式。需要严格 IPv6 SOCKS ATYP 支持时，应单独扩展握手编码。

这不是缺失，而是该分支的边界：把不确定的出口选择交给客户端，使服务端行为保持最小、明确、可预测。

## 核心转发路径

```text
VLESS over WebSocket
  → 解析 UUID / 目标地址 / 端口
  → 根据当前 Worker URL 选择 Direct 或 Global Proxy
  → 建立目标 TCP，或建立到 HTTP/SOCKS5 入口的 TCP 隧道
  → 上传侧机会性 grain 合包后写入
  → 下载侧大包直发 / 小包 grain 合包后回传
```

## 当前配置

| 变量 | 意义 | 默认值 |
| --- | --- | --- |
| `id` | VLESS UUID | `2523c510-9ff0-415b-9582-93949bfae7e3` |
| `chunk` | BYOB 读取块大小 | `64 * 1024` |
| `dnPack` | 下载侧 grain 聚合上限 | `32 * 1024` |
| `dnTail` | 下载侧尾部阈值 | `512` |
| `dnQr` | 下载侧连续增长观察轮次 | `4` |
| `upPack` | 上传侧合包目标 | `20 * 1024` |
| `maxED` | early data 上限 | `8 * 1024` |
| `concur` | 并发拨号数；Workers / Pages 默认 `4`，Snippets 可改为 `1` | `4` |

## 文件

| 文件 | 说明 |
| --- | --- |
| [GrainTCP.js](./GrainTCP.js) | `test` 分支 Worker 主实现：VLESS TCP relay、显式全局 HTTP/SOCKS5、grain 合包、BYOB 转发 |

## 相关链接

- 开源协议：[GPL-3.0](./LICENSE)
- 原始项目：<https://github.com/ToiCF/GrainTCP>
- fast-webstreams：<https://github.com/vercel-labs/fast-webstreams>
- iter-streams：<https://github.com/WinterTC55/iter-streams>
- 频道 / 交流群组：<https://t.me/Enkelte_notif>

## Stargazers over time

[![Stargazers over time](https://starchart.cc/ToiCF/GrainTCP.svg?variant=adaptive)](https://starchart.cc/ToiCF/GrainTCP)