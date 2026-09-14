---
title: "fix: 保持 Popup 与页面翻译响应"
type: fix
status: active
date: 2026-09-14
origin: docs/brainstorms/2026-09-14-popup-responsiveness-requirements.md
---

# fix: 保持 Popup 与页面翻译响应

## Overview

修复网页初载或大页面翻译期间 Action Popup 延迟出现、翻译命令长时间占用 Popup 以及页面同步扫描阻塞后续控制的问题。方案分为四层：翻译命令立即确认、Popup 进度初始化去重、DOM 候选扫描与 loading 安装分片、真实 Action Popup/大 DOM 性能门禁。

---

## Problem Frame

真实 Action Popup 测量未复现永久打不开，但超大 DOM 仍在加载时最慢约 2.7 秒才确认 UI 可用。主动翻译后，当前内容脚本会在单个同步流程中扫描页面并安装全部 loading；Popup 的 `tabs.sendMessage()` 又等待完整 `translate()`，把“命令接受”和“任务完成”错误耦合。修复必须先减少连续主线程占用，再确保 Popup 不等待长任务（see origin: `docs/brainstorms/2026-09-14-popup-responsiveness-requirements.md`）。

---

## Requirements Trace

- R1-R4a. Popup 先可见、初始化去重、状态不倒退，新文档不继承旧进度；重点缩短 Action Popup target 创建延迟。
- R5-R9. 翻译命令只返回接受确认，实际任务异步执行，所有错误走进度终态并受 generation/taskId 隔离。
- R10-R13. 扫描与 loading 按时间预算分片、宏任务让步、可取消，同时保持现有扫描和渲染语义。
- R14-R16. 增加真实 Action Popup、大 DOM 和慢翻译响应性测量，不记录正文或密钥。

**Origin flows:** F1（初载打开 Popup）、F2（发起大页面翻译）、F3（翻译中重开 Popup）

**Origin acceptance examples:** AE1-AE6

---

## Scope Boundaries

- 不把 DOM 翻译迁移到 service worker，不增加后台全局消息锁。
- 不使用 fallback 配置保存，不建立第二份完整配置快照。
- 不改变可翻译内容范围、父子去重、渲染器归属或可见优先语义。
- 不在本次全面治理 IndexedDB pending、后台孤儿请求和动态大子树删除性能。
- 不承诺消除第三方网页自身长任务造成的全部 Action Popup 调度延迟；目标是消除扩展自身可控的连续长任务。

---

## Key Technical Decisions

- **先上报再准备：** 建立新任务代际后立即上报 `translating 0/0`，随后异步规则加载、扫描和翻译。
- **命令 ACK 与任务结果分离：** content message listener 对页面翻译返回 accepted；完成、失败和恢复只通过 progress 通道表达。
- **最外层错误收口：** ACK 后发生的配置、规则、扫描、渲染、observer 或调度错误必须清理当前代际并上报 error。
- **有序进度身份：** 每条进度携带 documentId、taskId 和单调 seq；后台和 Popup 使用同一比较规则拒绝旧文档、旧任务和倒退序号。
- **时间预算而非固定数量：** 扫描和 loading 每片以约 4-8ms 为预算，用宏任务让步；每次恢复后检查 generation。
- **先完整去重再渲染：** 扫描可以分片收集，但必须完成父子去重后才分片安装 loading，避免改变候选语义。
- **单一进度初始化：** Popup 一次解析目标 tab，先挂监听再读取一次快照；实时事件先到后忽略旧快照。
- **文档身份双保险：** content controller 注册后以 sender.documentId 上报 document-ready/idle；后台维护 tabId:frameId 当前 documentId，并拒绝非当前文档迟到进度；tabs.onUpdated 进入 loading 时先清理该 tab 旧快照。
- **扫描变更缓冲：** 初始异步扫描开始前启动只缓冲 MutationRecord 的 observer；初始候选提交后排空缓冲变化，再切换到正式动态观察。
- **TextLeaf 所有权：** 异步扫描返回本次创建的 wrapper 集合并标记 task owner；取消只清理仍归本任务且未被新任务接管的 wrapper。
- **恢复也分片：** restore 先同步作废 generation、停止 observer/调度和发出后台取消，再按同一时间预算分片恢复 renderer、删除 loading 和解包 TextLeaf。
- **终态可靠上报：** translating 中间进度可 fire-and-forget；idle/complete/partial/error 必须等待后台确认并做有限重试。

---

## Implementation Units

- [x] U1. **翻译命令立即确认并完整收口异步错误**

**Goal:** Popup 只等待页面接受命令，不等待扫描或翻译完成。

**Requirements:** R5-R9；F2；AE2, AE6

**Dependencies:** None

**Files:**
- Modify: `src/content/index.ts`
- Modify: `src/content/main.ts`
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/popup/api.ts`
- Test: `tests/content/controller.test.ts`
- Test: `tests/ui/popup.test.tsx`

**Approach:**
- 将 translate/toggle-start 路径启动为受控异步任务并立即返回 accepted；restore 仍等待本地清理完成。
- 新任务在规则加载和扫描前立即报告 translating 0/0。
- 抽出不报告 idle 的本地清理和代际感知 fatal-error 入口；最外层 catch 只对当前代际停止 observer/队列、取消后台任务、恢复已安装节点、清理本任务包装并可靠上报 error。被新任务或恢复取代时静默退出。
- `getConfig()` 必须校验后台 `{ ok, data }`，无效响应不再静默使用默认设置；动态 observer 的异步错误也进入同一 fatal-error 入口。
- Popup 收到 accepted 后解除 busy，页面活动状态由进度事件决定，不乐观推断完成。

**Execution note:** 先写“translate Promise 永不完成但命令立即返回”和“ACK 后准备失败进入 error”的失败测试。

**Test scenarios:**
- Covers AE2. 翻译 worker 挂起时命令立即返回 accepted，Popup busy 解除。
- Covers AE6. 配置、规则、扫描、loading、observer 任一阶段抛错时上报 error 且无未处理 rejection。
- terminal progress 首次发送失败、有限重试成功后，后台最终状态不残留 translating。
- 新翻译抢占旧准备任务时旧任务不再上报 error 或插入节点。
- restore 在异步翻译期间立即清理并上报 idle。

**Verification:** Popup 生命周期与翻译任务 Promise 解耦，所有任务终态可观察。

---

- [ ] U2. **统一 Popup 目标页与进度初始化**

**Goal:** 减少 Action Popup 冷启动 IPC，并防止旧快照或旧文档状态覆盖当前状态。

**Requirements:** R1-R4；F1, F3；AE1, AE4, AE5

**Dependencies:** U1

**Files:**
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/popup/api.ts`
- Modify: `src/background/index.ts`
- Modify: `src/content/main.ts`
- Test: `tests/ui/popup-api.test.ts`
- Test: `tests/ui/popup.test.tsx`
- Test: `tests/background/message-handler.test.ts`

**Approach:**
- Popup API 创建一次页面上下文（tabId/document identity），供发送、Badge 和进度订阅复用。
- 删除独立 `getProgress()`，subscribe 流程先监听后读取一次快照；实时事件已到时拒绝旧快照。
- 进度统一使用 documentId + taskId + seq；后台只接受当前 document 的更新任务或同任务更大 seq，Popup 用相同比较器合并快照与实时事件。
- 新内容文档注册时由 sender.documentId 建立当前身份并写 idle；tabs.onUpdated loading 时先清空 tab 快照，旧 documentId 的迟到消息不得更新 Badge、快照或广播。
- 配置慢时保留可见壳层和设置入口；本单元只补轻量加载提示/重试，不引入配置快照。

**Test scenarios:**
- Popup 初始化只查询一次活动标签和一次进度快照。
- 实时 translating 先到、idle/旧快照后到时 UI 不倒退。
- 同 tab 新 document 注册后旧 complete 状态不可查询。
- 旧文档 progress 写入挂起、新文档 idle 先落盘、旧写随后继续时，最终仍保持新文档 idle。
- 同任务 seq 倒退、旧 taskId 迟到和旧快照晚到均被拒绝。
- 配置挂起时壳层和加载提示可见，失败后可重试且不保存 fallback。

**Verification:** 重开 Popup 以单一、有序、文档隔离的状态初始化。

---

- [ ] U3. **分片扫描与 loading 安装**

**Goal:** 消除扩展主动翻译造成的长同步任务，使 Action Popup、恢复和新命令获得调度机会。

**Requirements:** R10-R13；F2-F3；AE3-AE4

**Dependencies:** U1

**Files:**
- Modify: `src/content/dom-scanner.ts`
- Modify: `src/content/index.ts`
- Modify: `src/content/main.ts`
- Modify: `src/content/paragraph-store.ts`
- Test: `tests/content/dom-scanner.test.ts`
- Test: `tests/content/controller.test.ts`

**Approach:**
- 将扫描拆为可暂停的阶段：根与语义候选、文本叶收集/规范化、父子去重；每阶段内部按时间预算宏任务让步。
- 扫描完成去重后，再按同一预算分片执行 store refresh 与 renderLoading。
- yield 控制由依赖注入，测试使用可控时钟/让步函数；生产使用稳定宏任务机制。
- 异步扫描返回候选与 createdTextLeaves；wrapper 标记 task owner。每次让步前后检查 generation，取消时只解包仍归旧任务且未被新任务接管的 wrapper。
- 第一次让步前启动只缓冲 mutation 的观察器；初始 loading 提交后执行一次缓冲 reconciliation，再启动正式动态处理。候选提交/loading 前重新检查 connected、扫描根和当前排除/父子关系。
- restore 清理使用相同时间预算分片，先同步阻止旧任务继续工作，再逐片恢复 DOM。
- 保持同步扫描函数供小范围/动态 observer 使用，或让调用方显式选择异步入口，避免无关动态路径一次重写。

**Execution note:** 先建立 1000 段操作语义、让步次数和扫描中 restore 的回归测试，再改扫描器。

**Test scenarios:**
- Covers AE3. 1000 段扫描与 loading 发生多次宏任务让步，结果集合与原同步扫描一致。
- 扫描中 restore 后不再新增 loading，临时 text leaf 被清理。
- 扫描中第二个 translate 抢占，只有新代际启动 observer 和调度。
- 第一次 yield 期间插入、删除和移动节点，缓冲 reconciliation 后最终集合不丢失、不重复。
- A 创建 TextLeaf 后让步、B 接管、A 迟到退出时，B 的 wrapper 保持 connected 并可渲染。
- 大量 loading 后 restore 本身发生多次宏任务让步且最终完整清理。
- 普通文章、SPA、交互控件、图标排除和父子去重现有用例保持通过。
- Inline/legacy 两种 renderer 都按片处理，不改变归属。

**Verification:** 扩展自己的单个扫描/loading 执行片段受预算约束，页面控制可在片间运行。

---

- [ ] U4. **增加真实 Action Popup 与响应性门禁**

**Goal:** 用浏览器级证据防止 Popup target 创建、命令确认和大 DOM 响应性回归。

**Requirements:** R14-R16；全部 Success Criteria

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/extension.spec.ts`
- Modify: `tests/e2e/mock-server.ts`
- Modify: `tests/build/bundle-budget.test.ts`

**Approach:**
- 增加真实 `chrome.action.openPopup()`/CDP target 捕获 helper；普通 popup.html tab 测试继续承担功能测试，真实 action 测试只承担生命周期和响应性。
- 增加流式大 DOM fixture、1000+ 段翻译 fixture和慢 provider。
- fixture 先置前台；调用 openPopup 前注册 CDP Target targetCreated，按扩展 ID 与 `/popup.html` 精确匹配；每轮关闭 target 并确认下次为新 target。Chrome 127+ 缺少 API 时明确失败。
- 先 warm-up 一次，普通/压力场景各测至少三次；输出每次 target、DCL、壳层、主按钮、accepted 和首进度耗时，以中位数及压力/普通比值判定退化，并保留宽松单次硬超时捕获永久卡死。
- 确定性门禁同时断言 1000 段产生多次宏任务让步、restore 最迟在后续有限切片内停止旧 DOM 写入，避免只依赖墙钟。
- 性能日志只包含耗时、节点/段落数和状态。

**Test scenarios:**
- Covers AE1. 页面仍在流式构建大 DOM 时真实 Action Popup 能创建并显示壳层。
- Covers AE2. 慢 provider 下翻译命令快速 accepted，Popup 不等待 provider。
- Covers AE3. 大段落扫描期间可发送 restore，旧 loading 收敛清理。
- Covers AE4. 大量 loading 时真实 Action Popup 打开并显示当前进度。
- Covers AE5. 同 tab 导航后 Popup 不显示旧页面进度。

**Verification:** E2E 能区分 target 创建、React 可见、配置可用和页面翻译执行，不再只验证最终结果。

---

## System-Wide Impact

- **Interaction graph:** Action Popup → Popup API → content ACK →异步页面任务 → page-progress → background session → Popup。
- **Error propagation:** 命令通道只报告接受失败；任务通道报告运行错误，当前代际之外的错误静默丢弃。
- **State lifecycle risks:** 分片期间 restore/新翻译、Popup 快照与实时事件、同 tab 导航、observer 启动时机。
- **API surface parity:** Popup fake API、content dependencies、background message tests 和 E2E helper 必须同步。
- **Unchanged invariants:** API Key、引擎协议、缓存键、批量 8/6000、并发 3、DOM 安全回填和站点规则不变。

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| 立即 ACK 后错误变成静默失败 | 页面任务最外层 catch + 当前代际 error 进度测试 |
| 分片改变候选或父子去重 | 同步/异步扫描结果等价测试，去重完成后才渲染 |
| 旧任务在 yield 后继续写 DOM | 每片前后 generation 检查和取消清理测试 |
| 初始扫描 yield 期间页面变化丢失 | 扫描前缓冲 mutation，提交后 reconciliation，再进入正式 observer |
| 旧任务清理 TextLeaf 破坏新任务 | wrapper task owner 与接管规则，旧任务只清理仍归自己的节点 |
| restore 集中清理形成新长任务 | 先同步作废任务，再分片恢复和解包 |
| 进度乱序或旧文档迟到覆盖 | documentId + taskId + seq 比较，导航 loading 清理，后台拒绝旧 sender.documentId |
| 终态进度发送瞬时失败 | 终态等待后台确认并有限重试，中间进度保持轻量 |
| E2E 性能阈值抖动 | 分阶段相对耗时、宽松上界和语义门禁并用 |
| Popup 无法直接取得 sender.documentId | 先向当前 content 文档获取轻量 document context，再读取匹配快照 |

---

## Documentation / Release Notes

- 该修复属于响应性与稳定性修复，实施完成后提升 patch 版本。
- README 与发布说明描述 Popup 响应、扫描分片和旧任务取消，不声称能消除第三方网页自身造成的全部 Chrome UI 延迟。
- `PRIVACY.md` 仅同步生效版本，数据行为不变。

---

## Sources & References

- **Origin:** [docs/brainstorms/2026-09-14-popup-responsiveness-requirements.md](../brainstorms/2026-09-14-popup-responsiveness-requirements.md)
- `src/popup/PopupApp.tsx`
- `src/popup/api.ts`
- `src/content/index.ts`
- `src/content/dom-scanner.ts`
- `src/content/main.ts`
- `src/background/index.ts`
