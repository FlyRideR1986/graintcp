# GrainTCP

`GrainTCP.js` 是一个基于 Cloudflare Workers 的 VLESS over WebSocket TCP 转发实现，重点不在附加协议功能，而在于围绕真实代理路径收敛小包传输优化。

## 核心能力

当前代码主线包含：

- VLESS 普通 TCP 请求解析
- WebSocket early data 接入
- `request.fetcher.connect()` TCP 出站
- 并发拨号竞争首个成功连接
- 上传侧小包队列合并
- 下载侧 grain 聚合回传
- BYOB 读取转发

## 代码主路径

```text
VLESS over WebSocket
  → 解析 UUID / 目标地址 / 端口
  → `request.fetcher.connect()` 并发建立 TCP
  → 上传侧显式队列化机会性合包后写入
  → 下载侧 grain 聚合回传
```

## 出站接口

当前代码最突出的点之一，就是**最先把 `request.fetcher.connect()` 这条灰接口直接引入到实际 VLESS TCP 主线里使用**，而不是继续停留在公开 `cloudflare:sockets.connect()` 的常规路径上。

| 方式 | 类型 | 当前结论 |
| --- | --- | --- |
| `cloudflare:sockets.connect()` | 公开 API | 正式、稳定、直接出公网 TCP |
| `request.fetcher.connect()` | undocumented 灰接口 | 当前代码实际使用；同样可直接出公网 TCP，但接口形态与可用性更依赖平台实现 |

需要区分的一点：

- 当前代码用的是 **request 级 `fetcher.connect()`**
- 不是公开 service binding 那条 `Fetcher.connect()` 路径

从 workerd 源码层面看，这两条入口最终都会落到同一套底层 TCP 建连实现上；差异主要不在“另一套 socket 引擎”，而在 **JS 层入口、fetcher 归属和通道来源**。

对当前这份代码来说，`request.fetcher.connect()` 的意义主要有两点：

1. 它不是公开导入 `cloudflare:sockets` 模块的常规写法，而是 **直接在 request 级 JS 上下文里取出的灰接口**  
2. 在代码特征上，这条路径相比常规公开 socket 入口更小

但要分清：

- 这更接近 **入口形态差异**
- 不是已经被源码或实测完全证明成“底层能力高一档的新 socket”

当前可以确认的是：

- `request.fetcher.connect()` **确实能直接出公网 TCP**
- 它在底层仍与公开 `connect()` 共享同类建连路径
- 它作为 JS 层新引入的灰接口，代码特征比常规公开 socket 模块更小

## 设计重点

### 1. UUID 热路径

与以往所有代码不同，这一版没有把 UUID 校验继续留在请求期做循环逐字节比对，而是把 UUID 预解码前移到模块初始化阶段：先转成 16 字节，再拆成固定标量常量。

这样请求真正进入 `vless()` 主线后，UUID 这一步只剩下两件事：

- 长度不足直接返回
- 16 个字节做固定位置直接比较，失败立刻返回

这条路径的目的很明确：**把一次性工作留在初始化，把请求热路径压成最短的固定宽度判断**。对 `workerd` / V8 这类运行时来说，这比在每次请求里保留循环、偏移计算和额外分支更容易收紧成稳定热路径。

本地 `Node v20.19.4` 基准：

| 路径 | 以往处理方式 | 当前实现 | 谁更快 |
| --- | ---: | ---: | --- |
| UUID 命中匹配 | `53.26 ns/op` | `9.44 ns/op` | 当前实现约 `5.6x` |
| UUID 尾部错误快速拒绝 | `51.63 ns/op` | `11.00 ns/op` | 当前实现约 `4.7x` |
| 完整 `vless()` 有效包解析 | `220.67 ns/op` | `187.09 ns/op` | 当前实现约 `1.18x` |
| 完整 `vless()` 错误包快速拒绝 | `52.56 ns/op` | `23.14 ns/op` | 当前实现约 `2.3x` |

这里的 UUID 路径已经压到了 **纳秒级匹配 + 亚微秒级完整解析**，四项热路径对比里当前实现全部更快。

### 2. 上传侧显式队列化机会性合包

上传侧已经收敛下来。

这条路径不是单纯“收到一包写一包”，而是在 `writer.write()` 前先放进一个轻量有界队列：**如果当前写入还没结束，就顺手把后续小块继续收进来；一旦轮到当前连接继续写，就把连续小块尽量合并后再送进去。**

这里不是单一缓冲，而是 **显式队列化 + 机会性合包 + microtask drain**：

- 显式队列：先收进有界队列，而不是直接抢写
- 机会性合包：只在当前写入未完成、或同一轮事件里已经连续到包时，顺手把后续小块一起并进去
- microtask drain：当前轮写完后，立刻在下一轮 microtask 继续清队列，而不是把每个小包都拆成独立写流程

这部分思路主要参考了两个库，但不是原样照搬：

- **`iter-streams` / `new-streams`**：主要参考它的 **显式 push / backpressure / batched chunks** 这部分思路，也就是 `Stream.push()`、`highWaterMark`、`writev()` 这一套“先进入有界队列，再把多块合成更少写入”的设计
- **`fast-webstreams`**：主要参考它对 **per-chunk Promise / microtask / JS queue 成本** 的判断，以及 **write batching + 更轻调度** 这部分方向。也就是先尽量减少写入次数，再减少每块各跑一轮调度的额外开销

当前这段上传侧逻辑可以直接概括成：

- 从 `iter-streams` 借来 **显式队列化 / batched write** 的骨架
- 从 `fast-webstreams` 借来 **减少每块调度成本 / microtask 收敛 drain** 的取向

这样做的目的很直接：

- 减少高频小 `writer.write()` 调用
- 减少 tiny packet storm 带来的固定调度成本
- 把原始很多条细碎 message，压成更少的实际写入次数

从模型上看，这条路径的核心就是把上行 `N_msg` 压到更小的 `N_up`。在小包足够碎、到达足够密的场景里，目标效果就是把**几千条原始小消息收敛成几十次实际写入**；最终比例取决于消息大小、间隔和 `upPack`，不是固定常数。

当前实现对应：

- `mkQ()`：有界收纳 + 合包
- `upPack = 16KB`：单次机会性合包目标
- `upQMax = 256KB`：显式队列上限
- `queueMicrotask(...)`：把下一轮 drain 压到当前轮事件之后，给同轮连续小块一个极短暂的并包窗口

这条路优化的是 **JS 层写入次数和调度形态**。

它的价值是 **削减高频小包带来的固定成本**。

### 3. 下载侧 grain 聚合

下载侧分成两部分：

- **已定型的是大包直发主线**
- **还在继续收敛的是 `<32KB` 小包 smoothing**

当前代码的下行主线很明确：

- **大包**：`tx.reap()` → `ws.send(v)` → 立刻换新 BYOB buffer
- **小包**：`v.slice()` 脱离原读缓冲 → 进入 grain 聚合

大包直发已经定型，原因很直接：

- `ws.send(Uint8Array)` 底层不是立刻深拷贝，而是把当前 view 对应的 backing store 挂进 `outgoingMessages` 异步队列
- 所以大包如果先 `slice()` 再发，只会平白多一次 JS copy
- direct send 之后，这块读缓冲又不能继续复用，所以必须立刻换新 buffer

大包路径现在就是一句话：

> **direct send，随后立刻换新 buffer**

这也是它比旧式“先大缓冲、再定时 flush”的下载写法更省开销的原因：

- 旧写法会额外维护一整套大缓冲、offset、timer、resume、flush 状态
- 大块数据常常先复制，再 send
- 进入大文件阶段后，还会继续塞进 JS 缓冲再等定时器发出

而当前这版的大包路径只保留两个必要动作：

- **直接 send**
- **换新 buffer**

少了一次大块复制，也少了一层 JS 缓冲和 timer 状态机。

当前继续优化的是小包这一半，而且这里的 `32KB` 不是“必须攒满才发”的目标，而是 **聚合上限**：

- `>= 32KB` 直接发
- `< 32KB` 先进入 staging buffer
- 缓冲接近上限、同轮连续小包折叠完成，或极短 quiet-window 结束后就发

所以它不是简单缓存，而是 **microtask 折叠 + 极短 quiet-window** 的轻量聚合。

这部分针对的是 **高频小 frame 场景**：把很多 `<32KB` 小块压成更少的 `ws.send()` 次数，减少 frame 数、调度次数和 runtime 队列压力。

它不是完整流控，也不是背压系统。`WebSocket.send()` 仍然没有可用的 drain / backpressure 信号；客户端慢的时候，runtime 内部队列仍然会继续增长。这个聚合器能做的，是尽量减小高频小 frame 对 `send()` 队列的放大。

当前把 `dnPack` 收在 `32KB`，是因为更小的 `2KB / 4KB / 8KB` 虽然也会做一点合并，但还停留在原始小包尺度里，只有 `32KB` 才能把小包 frame 数压到另一个数量级。

`chunk = 64KB` 也只是当前通用默认档，不是源码硬上限。它的含义更接近“普通混合流量下更稳的工程档位”；在明确的大文件 bulk 场景里，更大的读块仍然可能成立。

下载侧也没有继续走重型 JS 队列路线。`ws.send()` 底层本来就有自己的异步发送队列，JS 层再额外堆一整套大缓冲、timer 和状态机，通常只会多一次合并拷贝和更多调度开销。当前主线保留的是轻量小包聚合，不再重做一层下载发送系统。

简化模型：

```text
T_direct = 32KB
N_down ≈ B_down / E_down
Cost_down ≈ N_down * (C_loop + F_big * C_rebuf) + P_small * B_down * k_slice
Q_ws_out' ≈ R_sock_read - R_ws_drain
```

含义：

- `T_direct`：大小包分界；`>= 32KB` 直发，`< 32KB` 进入轻量聚合
- `E_down`：下行平均交付块大小；越大，`N_down` 越小，`read + send + loop` 固定成本越低
- `P_small`：走小包分支的字节占比；越高，`slice()` 复制成本越高
- `F_big`：走大包直发分支的迭代占比；越高，补新 BYOB buffer 的次数越多
- `Q_ws_out`：`ws.send()` 之后 runtime 内部的隐藏发送队列；当 `R_sock_read > R_ws_drain` 时继续增长

当前主参数：

- `dnPack = 32KB`
- `dnTail = 512B`
- `dnMs = 0`

### 4. 并发拨号

当 `concur = 4` 时，会同时发起多路 TCP 建连，谁先成功就使用谁，其余连接关闭。主要用于改善部分入口下的首连成功率和首包速度。

当前 `4` 对应的是 **Workers / Pages 部署下的默认配置**。如果把这份代码改成 **Snippets** 形态使用，并发拨号应手动收回到 `1`，不要继续保留 `4`。

## 当前配置

| 变量 | 意义 | 默认值 |
| --- | --- | --- |
| `id` | VLESS UUID | `2523c510-9ff0-415b-9582-93949bfae7e3` |
| `chunk` | BYOB 读取块大小 | `64 * 1024` |
| `dnPack` | 下载侧 grain 聚合上限 | `32 * 1024` |
| `dnTail` | 下载侧尾部阈值 | `512` |
| `dnMs` | 下载侧延迟窗口 | `0` |
| `upPack` | 上传侧合包目标 | `16 * 1024` |
| `upQMax` | 上传队列上限 | `256 * 1024` |
| `maxED` | early data 上限 | `8 * 1024` |
| `concur` | 并发拨号数；Workers / Pages 默认 `4`，Snippets 手动改 `1` | `4` |

这些值对应的是当前主线路径下的收敛结果，不是随意占位参数。

## 文件

| 文件 | 说明 |
| --- | --- |
| [GrainTCP.js](./GrainTCP.js) | Worker 主实现：VLESS 解析、TCP 出站、上传 queue、下载 grain、BYOB 转发 |

## 相关链接

- 开源协议：[GPL-3.0](./LICENSE)
- fast-webstreams：<https://github.com/vercel-labs/fast-webstreams>
- iter-streams：<https://github.com/WinterTC55/iter-streams>
- 频道 / 交流群组：<https://t.me/Enkelte_notif>

## Stargazers over time

[![Stargazers over time](https://starchart.cc/ToiCF/GrainTCP.svg?variant=adaptive)](https://starchart.cc/ToiCF/GrainTCP)
