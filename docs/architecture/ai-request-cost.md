# 自定义 AI 请求成本控制（ai-request-cost）

适用范围：`src/background/ai-coordinator.ts`（`AiRequestCoordinator`），以及 `src/background/index.ts` 中 `createRuntimeDependencies` 对自定义 AI 引擎的接入。Google / Bing 内置引擎不经过该协调器，保持原有"请求内分批 + 缓存"路径不变。

## 请求管线

自定义 AI 的页面翻译请求按以下顺序处理（每段独立流转）：

1. **缓存查询**：以完整缓存键查询 `TranslationCache`，命中直接返回，不产生任何 provider 负载。
2. **inflight 去重**：未命中的段按完整缓存键查在途请求表；同文本的并发请求订阅既有在途请求，不重复发送。
3. **100ms 合批窗口**：仍无在途请求的段进入按请求身份分组的队列，等待最多 100ms 收集并发到达的段落；队列达到上限时立即发送，不等窗口。
4. **批次发送**：每批最多 8 段、累计 6000 字符（与消息层 `parseSegments` 上限一致），一次 `provider.translate` 调用发出。批次对 provider 使用批内唯一槽位 id（`批次号:序号`），返回后映射回各调用者原始段 id——不同调用者/页面可能使用相同段落 id，映射不得依赖原 id。

## 完整缓存键与隔离

缓存键由 `createCacheKey`（SHA-256）生成，包含：

- 归一化正文文本；
- 源语言、目标语言；
- `engineId`、`engineFingerprint`（baseUrl 路径 + model）、`adapterVersion`；
- 提示词版本（`promptVersion`）；
- 生效指令（`effectiveInstruction`，即专家提示 + 用户指令的拼接）。

因此不同 provider、不同 cacheIdentity、不同语言、不同指令的请求生成不同键，在缓存与 inflight 去重两层天然隔离，不会互相复用结果。合批队列按同一身份集合分组，跨身份不会合并批次。队列对象（含 provider 引用与指令）在排空后立即从内存释放，不随身份变化永久积累。

## 结果与失败语义

- 调用者一次请求内任一在途段失败，不丢弃其余成功段：缓存命中段与其余成功段按请求顺序作为非空子集返回；仅当没有任何成功段时，才按首个错误整体拒绝。
- 成功段在写入缓存后才释放在途键：缓存写入挂起期间，同键新请求继续去重复用，不会重复调用 provider；缓存写入失败按 miss 语义处理，不阻塞调用者。
- 取消始终拒绝（`任务已取消`），不会以子集形式返回部分结果。

## 取消语义

- 每个调用者（一次 `translate-batch` / 划词回退请求）持有自己的 `AbortSignal`，以"订阅"为单位挂在对应的在途请求上。
- 单个调用者取消只退订自身；同批次其他订阅者不受影响，底层请求不中止。派发前失去全部订阅者的在途项立即从队列与在途表中清理，同键重试会作为全新请求发送，不会复用已弃请求。
- 仅当批次内**所有**订阅者都已取消时，才中止该批次的 `AbortController`（provider 收到中止信号），并将在途键从表中清除；后续请求会重新入队。
- 调用者入口 signal 已中止时直接拒绝（`任务已取消`），不入队、不发送。
- 调用者完成或失败结束时移除自身的 abort 监听并释放订阅；provider 同步抛出也走同一路径安全清理，不中断同队列剩余批次的派发。

## 成本计数（本地内存）

`AiRequestCoordinator.snapshot()` 返回计数快照，`reset()` 归零。通过 `BackgroundDependencies.aiMetrics` 暴露，仅存在于后台 Service Worker 内存中，**不落盘、不进消息、不进日志**。

| 指标 | 含义 |
| --- | --- |
| `cacheHits` | 段级缓存命中次数 |
| `cacheMisses` | 段级缓存未命中次数（含随后被 inflight 去重的段） |
| `deduplicatedSegments` | 通过 inflight 复用既有请求、未新增 provider 负载的段数 |
| `providerCalls` | 协调器发出的 `provider.translate` 批次调用次数 |
| `providerSegments` | 实际发送给 provider 的段数 |
| `providerCharacters` | 实际发送的字符数（本地自报计数） |
| `abortedBatches` | 因全部订阅者取消而中止、且 provider 尚未返回的批次数 |

### 隐私与准确性边界

- 计数器全部是纯数字，**不记录正文、API Key、baseUrl 或任何 URL**。
- `providerCalls` 是协调器层面的批次调用次数，**不是 HTTP 请求次数**：OpenAI 客户端内部的重试、`response_format` 不兼容时的回退重发都会产生额外 HTTP 请求，且这些请求未经协调器统计；它也**不是** provider 返回的 usage/token 用量实测。本轮未新增实际 HTTP 层统计。
- `providerCharacters` 是扩展本地对发送字符的自报计数；不按 token 换算费用。OpenAI 兼容接口的 `usage` 字段当前未被读取或存储。
- Service Worker 休眠后计数归零；重启后从 0 开始，不代表累计历史用量。

### 清缓存与在途请求

- 清缓存（`clear-cache`）只清空缓存存储，**不取消当前正在进行的翻译**；在途 provider 调用会照常完成并正常返回给调用者。
- 因此：清缓存发起前已发出、尚未写完的翻译结果，仍可能在清缓存完成后写回缓存（在途回写）。**不声称清缓存后绝无在途回写**；需要绝对干净状态时，应在清缓存后等待在途翻译结束再清理一次。

## 验证

`tests/background/ai-coordinator.test.ts` 覆盖（fake provider 基准）：

- 冷请求：缓存未命中 → 一次 provider 调用，原 ID 还原；
- 热请求：缓存命中 → 不再调用 provider；
- 重复基准：并发同文本仅一次 provider 调用，各方还原各自 ID；
- 100ms 窗口合并不同文本为一次批次；8 段 / 6000 字符上限拆批；
- 语言、指令、cacheIdentity 三类隔离；
- 取消订阅隔离、发出前全取消不发送、已发出全取消中止；
- 快照 reset 与"快照不含正文/密钥/URL"契约。
