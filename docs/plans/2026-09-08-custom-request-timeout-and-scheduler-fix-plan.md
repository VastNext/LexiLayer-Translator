# 动态 DOM 替换孤儿节点与后台进度拒绝修复及后续调度演进方案

## 一、问题背景与现象

在 `v0.10.5` 及此前版本中，用户与测试反馈两类主要现象：
1. **部分页面段落长久停留在“翻译中…”（loading 占位残留）**：用户报告 Vercel 文档顶部两段持续 loading，切换引擎后仍有问题；尚未现场确认具体触发路径。
2. **后台 Service Worker 报未捕获异常**：Popup 关闭后，内容脚本上报翻译进度时控制台出现 `Could not establish connection. Receiving end does not exist.` 未捕获 rejection。

---

## 二、调查证据分级与根因分析（Evidence Hierarchy）

### 1. 已验证的代码缺陷（本次 0.10.6 修复项）

- **DOM 动态替换导致 legacy loading wrapper 成为孤儿节点**：
  - **因果链**：现代 SPA / 框架水合时，常对已有 DOM 节点进行克隆替换（`replaceWith`）或结构重组。在 legacy 兼容渲染模式下，loading wrapper 是作为源节点的相邻兄弟节点挂载的。当源节点被替换或移除时，MutationObserver 拾取到了节点的断开，但旧段落关联的 loading wrapper 留在 DOM 中未被清理，变成与任何源节点都不再绑定的永久孤儿节点。
  - **迟到结果与状态污染**：旧源节点的异步请求返回（无论是成功还是失败）时，因元素已断开或版本失效，若未严格过滤，会导致失败污染 `failedIds`、已移除段落无法收敛、控制器 `reportCurrent` 在未完成项存在时错误判定状态。
- **Popup 关闭时进度广播产生 Promise Rejection**：
  - `background/index.ts` 收到 `page-progress` 消息保存 session 后，通过 `runtime.sendMessage` 向 Popup 广播。若用户在翻译过程中关闭了 Popup，因没有活跃监听器，该 Promise 会被 reject，导致后台偶发未捕获错误。

### 2. 未证实假设（需补充客观证据，不作臆测性改造）

- 本次克隆替换回归针对兼容模式相邻占位；内联模式深克隆同时复制插件子树的情况属于后续验证边界。

- **假设：视口观察器（IntersectionObserver）在特殊布局下永久不触发相交导致“死锁”**：
   - **评估**：该推断此前缺乏复现用例与证据支撑。节点替换缺陷虽已在本地复现，但同样尚未证明是 Vercel 现场的触发原因，需要记录源节点身份、相交回调和实际请求才能区分。
   - **本次范围**：不引入“超时强制排空 waiting 队列”。这会改变视口懒加载行为并增加请求与费用，且无法修复已失去引用的占位。

---

## 三、本次（0.10.6）已落地的最小精准修复

1. **`dynamic-observer.ts` 彻底清理孤儿 wrapper**：
   - 在 `flush()` 移除断开连接的源节点记录前，显式调用 `record?.wrapper?.remove()`，确保源节点被替换或移除时其相邻 loading/error wrapper 同步从 DOM 摘除。
2. **`dom-renderer.ts` & `inline-renderer.ts` 渲染结果严格校验**：
   - 渲染器在元素断开或版本/task 失效时返回 `false`，内容脚本不将拒绝的迟到结果计入完成或失败。
3. **`content/index.ts` 状态收敛与隔离防污染**：
   - `markFailed` 过滤已移除或已断开的段落，防止旧请求失败污染 `failedIds`。
   - `processParagraphs` 在处理批次响应时严格检查段落存活性，迟到结果安全忽略。
   - `reportCurrent` 精确识别 `completed + failed < paragraphs.size` 的进行中语义，避免在未完成时提前或错误上报 `complete`。
4. **`background/index.ts` 广播拒绝兜底**：
   - 为 `runtime.sendMessage` 广播补齐 `.catch(() => undefined)`，确保 Popup 关闭不影响进度持久化与翻译流程。

---

## 四、后续演进规划（非当前版本范围）

若后续版本需要进一步提升网络弹性与可配置性，应遵循以下设计原则：

1. **超时语义严格区分**：
   - 区分“网络请求超时（HTTP/Fetch Timeout）”与“视口等待（Viewport Idle）”，绝不将未进入视口的等待段落误当作网络超时。
2. **保持视口按需加载**：
   - 保留 `ParagraphVisibilityBatchQueue` 的视口驱动模型，不搞全量强排。
3. **独立实现用户已提出的超时设置需求**：
    - 后续在 Options 开放请求超时时间，候选值为 10、15、30、60、90 秒，默认 30 秒，并处理旧配置补齐、校验与导入导出。
    - 实现前明确整批总时限与单次 HTTP 时限、重试预算、响应体读取及超时取消行为，不能仅让前后端使用相同数值。

---

## 五、验证与回归基线

- **单元测试**：
  - `tests/content/dynamic-observer.test.ts`：覆盖 `replaceWith` 替换源节点时 wrapper 清理、旧请求迟到成功/失败隔离。
  - `tests/content/controller.test.ts`：覆盖渲染拒绝不计入完成、旧请求失败不污染 `failedIds`、状态语义精确上报。
  - `tests/background/message-handler.test.ts`：覆盖 Popup 关闭时进度广播拒绝的静默捕获。
- **E2E 测试**：
  - `tests/e2e/extension.spec.ts`：使用本地 Mock Server，端到端验证源节点在 loading 阶段被 `replaceWith` 替换后，旧 loading wrapper 立即消失且新节点成功翻译呈现。
