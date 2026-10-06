---
title: YouTube 双语字幕实施计划（视频字幕 Phase 1）
type: feature-plan
status: draft
date: 2026-10-07
origin: docs/brainstorms/2026-10-07-video-subtitles-requirements.md + 2026-10-07-video-subtitle-translation-research.md
---

# YouTube 双语字幕实施计划

## Overview

为 youtube.com 视频页提供双语字幕：捕获播放器自己的字幕请求（携带 YouTube 的 pot 令牌），重放获取原文轨与 `tlang` 翻译轨；用户也可选择「跟随当前翻译引擎」用现有后台引擎批量翻译；播放器内自绘双语两行 overlay，随播放进度实时切换；SPA 导航自动重建。

零新增权限；不新增后台消息（AI 路径复用 `translate-batch`）；新增两个内容脚本（MAIN world 注入脚本 + ISOLATED 控制脚本）与两个配置项。

## Problem Frame

见需求文档。技术核心难点是 pot 门禁（静默 200 空 body）下的字幕获取，以及 SPA 播放器环境下的会话管理。

## Requirements Trace

| 来源 | 需求 | 覆盖 |
|---|---|---|
| R1/R2 | 站点级注入 + 总开关 | U1、U4 |
| R4–R6 | 捕获-重放、轨道身份识别 | U2、U3 |
| R7/R8 | 双引擎与缓存 | U5 |
| R9/R10 | 渲染与同步 | U4 |
| R11 | SPA 重建与竞态 | U3、U4 |
| R12 | 降级 | U5、U4 |
| R13/R14 | 数据流与披露 | U6 |

## Scope Boundaries

**In scope**：youtube.com/watch 页面；人工字幕与 ASR 轨（ASR 按事件显示，不重组句子——句子重组记入后续）；tlang 与当前引擎两种翻译；overlay 双行 + 拖动位置持久化。

**Deferred**：Bilibili（第二阶段）；ASR 句子重组与无字幕视频转写；点词/生词联动（第三阶段）；直播；导出 srt；Netflix。

## Context & Research

- 调研留档：`docs/brainstorms/2026-10-07-video-subtitle-translation-research.md`（pot 门禁、JSON3 结构、渲染/同步/限流先例均有仓库级证据）。
- 关键先例：Gythiro/yt-dual-subs（捕获-重放 + PerformanceObserver 兜底 + normKey）、TwinCue（setOption 触发 + shadow overlay）、bilingualtube（渐进翻译 + IndexedDB）。
- 本仓库现状：`translate-batch` 消息 + 引擎/批处理/缓存可直接复用；`selection-features.js` 先例证明「独立 IIFE 内容脚本 + 独立预算行」模式；MV3 `world: "MAIN"` 内容脚本 Chrome 111+ 可用。
- 体积现状：content-main 38.9KB、background 36.4KB 均贴近预算——字幕功能必须独立成包，不挤既有脚本。

## Key Technical Decisions

### D1. 两个独立内容脚本 + 独立预算

- `youtube-inject.js`：`world: "MAIN"`、`document_start`、match `https://www.youtube.com/*`。hook `window.fetch` 与 `XMLHttpRequest.prototype.open/send`（全 try/catch，绝不向页面抛异常），捕获 URL 含 `/api/timedtext` 的请求（响应含 `wWinId`/事件结构或 URL 参数判别），经 `window.postMessage` 转发；另用 PerformanceObserver（`resource` 条目含 timedtext URL）兜底。pot 只存在于播放器运行时——这是唯一可靠获取路径。
- `youtube-subtitles.js`：ISOLATED、`document_start`、同 match。监听 postMessage（校验来源标记与页面 origin），桥接到控制器。
- 两者均为独立 IIFE 构建 + 独立预算行（inject ≤ 4KiB、youtube-subtitles ≤ 16KiB，初始值，超了再按流程调）；**不并入 content-main**（无余量）。

### D2. 捕获-重放与会话模型

- inject 捕获到 timedtext URL 后记「最新一次」；ISOLATED 侧维护 `VideoSession`：videoId + 轨道 normKey（剥离 pot/fmt/tlang/expire 参数后的规范化键）。
- 取字幕：用捕获 URL 重放 + `fmt=json3`（同 URL 派生原文与 `&tlang=<target>` 翻译两次请求；tlang 不支持的语言对返回原轨，需检测翻译轨内容与原文相同视为无翻译）。重放请求在 ISOLATED world fetch（同源、带 Cookie）。响应 200 但 body 空或解析失败 → 显式记为「轨道不可用」，进入降级，不无限重试。
- `yt-navigate-finish` 事件 + `location` 变化轮询双保险判定新视频；所有异步回调校验 sessionId，旧视频结果丢弃。pot 轮换（URL 变化但 normKey 不变）只更新捕获，不重建字幕。
- 自动开启 CC：点击 `.ytp-subtitles-button`（`aria-pressed=false` 时），记录「扩展开启」；功能关闭/视频切换时按需还原。按钮 `aria-disabled` 冷启动重试（最多 5 次 × 800ms）。这既是字幕数据来源的触发器，也让原生渲染请求出现供捕获。

### D3. 解析与同步

- JSON3 → cue 数组 `{start, end, text}`：过滤 `aAppend===1` 与空 segs、拼接 `segs[].utf8`、剥离 ASR `>>`、HTML 实体解码；翻译轨与原文轨按事件顺序对齐（条数不等 → tlang 视为失败，走当前引擎路径）。
- 同步：`setInterval` 120ms 轮询 `video.currentTime`（优先 `#movie_player` 的 video），二分查找当前 cue，render-key（start+text）去重写 DOM；`document.pictureInPictureElement`/`.ad-showing` 时清空显示；video 缺失/暂停不处理（overlay 保留当前内容，与原生一致）。
- 渲染器：overlay `div` 挂 `.html5-video-player`，`position:absolute` 底部百分比定位（`--yt-delhi-bottom-controls-height` + `.ytp-autohide` 适配控制栏），closed Shadow DOM 隔离样式（复用项目惯例），两行 `原文 / 译文`，字号颜色镜像原生 `.ytp-caption-segment` 计算样式（简版）。拖动手柄持久化百分比坐标到 `chrome.storage.local`（键 `videoSubtitlePosition`）。CSS 隐藏原生字幕（`ytds`-式 body class）。

### D4. 翻译管线

- 引擎选项 `videoSubtitleEngine: 'youtube-tlang' | 'current-engine'`，默认 `'youtube-tlang'`；总开关 `videoSubtitleEnabled: boolean` 默认 `true`。目标语言 = 页面翻译目标语言（`readingPreferences.targetLanguage`，经 `get-public-config` 获取）。
- `youtube-tlang`：重放 `&tlang=` 翻译轨，零后台参与。检测「翻译轨与原文逐条相同」视为不支持该语言对 → 降级 current-engine（若失败则仅原文）。
- `current-engine`：向后台发 `translate-batch`（sourceLanguage 由轨道语言提供，segments 为句子数组，engineId 省略=当前引擎），复用既有批处理/缓存/限流；进度按已翻句数渐进渲染（翻完一句显示一句，与 bilingualtube 的渐进策略一致）。
- 缓存：current-engine 路径复用后台现有 IndexedDB 翻译缓存（无需新缓存）；tlang 路径靠 YouTube 自身。轨道 cue 数据（原文）内存缓存按 `videoId+normKey`。

### D5. 设置与开关

- 设置页「阅读偏好」区块尾部新增「视频字幕」子组：总开关 + 引擎选择（沿用即改即存与防抖模式）。关闭开关时向页面广播停用，恢复原生字幕。
- 内容脚本每次视频会话开始时经 `get-public-config` 读取偏好；偏好变化（storage.onChanged 或下次会话）生效，不做会话内热切换（与渲染器模式同策略）。

### D6. 体积与隐私

- 预算：新增两行（inject 4KiB / youtube-subtitles 16KiB），AGENTS.md 同步；content-main/background/content.js 零改动。
- 隐私：字幕文本仅发往所选引擎对应服务（current-engine 与页面翻译同流）；tlang 请求发往 YouTube 自身；不落盘字幕文件；PRIVACY.md、商店文档补数据流披露；无新增权限。

## Open Questions

**Resolved During Planning**

- 重放请求在哪个 world 发？→ ISOLATED（同源 fetch，带 Cookie；MAIN world 保持纯捕获，减少页面污染面）。
- tlang 目标语言用什么？→ 页面翻译目标语言（resolveCommand 同源逻辑），而非浏览器语言。
- ASR 无标点是否重组句子？→ v1 不重组（按 YouTube 事件显示，整事件送翻）；重组记入后续优化。
- 字幕缓存？→ current-engine 复用后台缓存；原文 cue 内存缓存；不新增 IndexedDB schema。

**Deferred to Implementation**

- overlay 字号/颜色镜像原生样式的精细度；拖动手柄交互细节。
- Shorts 页面（竖屏播放器）是否支持（v1 不支持，watch 页面 only）。
- tlang 语言对覆盖检测的边界（空翻译行 vs 同文）。

## High-Level Technical Design

```
[youtube.com 页面]
   播放器 → /api/timedtext?...&pot=…（自带令牌）
        │  MAIN world inject.js：hook fetch/XHR + PerformanceObserver 兜底
        │  window.postMessage({source:'ytds-inject', url})
        ▼
[youtube-subtitles.js (ISOLATED)]
   ├─ VideoSession(videoId, normKey, generation)
   ├─ 重放 fmt=json3 → 原文 cues；&tlang= → 翻译 cues（youtube-tlang 引擎）
   ├─ current-engine：chrome.runtime.sendMessage translate-batch（渐进渲染）
   ├─ 同步循环：120ms currentTime → 二分查找 → shadow overlay 双行
   └─ yt-navigate-finish / 轮询 videoId → 重建会话；ad-showing 停画
        ▼
[background] translate-batch（既有批处理/缓存/限流，零改动）

[设置] videoSubtitleEnabled / videoSubtitleEngine（阅读偏好区块）
```

## Implementation Units

执行遵循 TDD；版本、发布门禁集中在 U6。

### U1. 配置与清单

- **Goal**：偏好项与脚本注入声明。
- **Files**：Modify `src/shared/config.ts`（`videoSubtitleEnabled`、`videoSubtitleEngine` + validate/normalize/migrate）、`src/manifest.ts`（两个内容脚本条目 + MAIN world）、`tests/shared/config.test.ts`、`tests/build/manifest.test.ts`。
- **Tests**：默认值、旧配置补齐、非法值拒绝、manifest 条目与 world 断言。

### U2. inject 捕获脚本

- **Goal**：MAIN world 捕获 timedtext 请求。
- **Files**：Create `src/content/youtube/inject.ts`；Create `tests/content/youtube/inject.test.ts`。
- **Approach**：hook fetch/XHR（保护原型、try/catch 全包）、PerformanceObserver 兜底、`normKey(url)`（剥 pot/potc/fmt/tlang/expire）、postMessage `{source:'ytds-inject', url}`；脚本幂等（重复注入守卫）。
- **Tests**：jsdom 下 mock fetch/XHR 流量 → 捕获与非捕获分类、normKey 稳定性、hook 不破坏页面请求。

### U3. JSON3 解析与轨道对齐

- **Goal**：timedtext 响应 → cue 数组。
- **Files**：Create `src/content/youtube/json3.ts`；Create `tests/content/youtube/json3.test.ts`。
- **Tests**：标准 JSON3、aAppend 丢弃、ASR 多 seg 拼接、`>>` 剥离、HTML 实体、空 body/坏 JSON 显式失败、翻译轨与原文轨条数不等判失败、同文检测（tlang 未翻译）。

### U4. 会话控制器与渲染器

- **Goal**：会话生命周期、同步循环、overlay 渲染。
- **Files**：Create `src/content/youtube/session.ts`、`src/content/youtube/renderer.ts`、`src/content/youtube/index.ts`；Create `tests/content/youtube/session.test.ts`、`renderer.test.ts`；Modify `vite.config.ts`（两个 IIFE 构建）、`tests/build/bundle-budget.test.ts`（两行新预算）。
- **Approach**：session 持有 generation/normKey/cue 缓存与自动开 CC 重试；同步循环二分查找 + render-key 去重 + ad-showing 停画；renderer 用 closed Shadow DOM，底部定位与控制栏适配、拖动持久化、原生隐藏 class。
- **Tests**：假 video 元素驱动时间推进 → cue 切换正确；拖动进度条（currentTime 跳变）二分回溯；generation 失效丢弃旧回调；会话重建；ad-showing 停画；budget 测试更新后通过。

### U5. 翻译管线接入

- **Goal**：tlang 与 current-engine 双路径 + 降级链。
- **Files**：Create `src/content/youtube/translate.ts`；Create `tests/content/youtube/translate.test.ts`；Modify `src/content/youtube/session.ts`。
- **Approach**：tlang 重放（翻译轨与原文同文检测）→ current-engine（translate-batch，引擎省略=当前引擎，渐进回调逐句渲染）→ 全失败仅原文 + 状态行提示（一行、可关闭）。tlang 429/空 body 记入会话级降级，不重试风暴。
- **Tests**：mock fetch/SW 消息覆盖成功、tlang 同文降级、current-engine 渐进回调、双失败仅原文、pot 空 body 显式降级。

### U6. 设置 UI、文档与发布

- **Files**：Modify `src/options/OptionsApp.tsx`（阅读偏好区块「视频字幕」子组：开关 + 引擎选择）、`src/shared/i18n.ts`、`public/_locales/*`、`README.md`、`PRIVACY.md`、`docs/chrome-web-store/README.md`、`docs/ROADMAP.md`、`package.json`、`docs/release-notes/0.16.0.md`、`tests/ui/options.test.tsx`。
- **Approach**：`npm version minor --no-git-tag-version` → 0.16.0；PRIVACY/商店披露视频字幕数据流（捕获播放器字幕请求 + 发送所选引擎；tlang 发往 YouTube 自身；无新增权限）；ROADMAP 移入已完成（Phase 1 部分）。
- **Gates**：`npm test`、`npm run typecheck`、`npm run build`、`npm run release:validate`、`npm run e2e`。

### U7. E2E 冒烟

- **Files**：Modify `tests/e2e/mock-server.ts`（`/fixture-youtube`：合成播放器页——video 元素 + 模拟播放器容器 class + 发出 timedtext 请求的脚本 + 假 `yt-navigate-finish` 事件源）；Create `tests/e2e/youtube-subtitles.spec.ts`。
- **Approach**：mock 服务器提供 `/api/timedtext`（json3 原文/翻译两轨）；E2E 断言捕获→重放→overlay 双行渲染→currentTime 推进切换 cue。合成页与真实 YouTube 的差异记录在用例注释（真实 pot 链路无法在 CI 复现，由真机验收）。
- **Tests**：1 条端到端冒烟。

依赖顺序：U1 → U2 → U3 → U4 → U5 →（U6、U7）。

## System-Wide Impact

- **体积**：新增 `youtube-inject.js < 4KiB`、`youtube-subtitles.js < 16KiB` 预算行；既有脚本零增长。
- **manifest**：新增两条内容脚本（youtube.com，无新权限、无 web_accessible_resources 变更）。
- **隐私与商店**：PRIVACY 数据流补视频字幕一节；商店划词说明补「视频字幕仅在用户播放视频时处理字幕数据」。
- **测试面**：新增 shared/content 各层单测 + E2E 冒烟；预算测试两行新增。
- **本地化**：新文案 fallbackMessages + `_locales`（zh_CN/en）。

## Risks & Dependencies

- **pot 链路 CI 不可复现**：真实 YouTube 的 BotGuard/轮换只能在真机验收；E2E 用合成页验证捕获-重放-渲染闭环，pot 相关失败降级路径由单测覆盖。
- **YouTube 改版**：选择器/端点变更会使功能失效（同行产品共同风险）；降级路径保证「失效 = 回到原生字幕」而不是破坏播放器。
- **tlang 质量**：默认机翻质量一般，靠「跟随当前引擎」选项提供 AI 升级路径；tlang 限流为分钟级窗口，失败即降级不重试。
- **MAIN world hook 兼容**：其他扩展也可能 hook fetch/XHR；PerformanceObserver 兜底 + 全 try/catch 保证共存与不破坏页面。
- **预算**：youtube-subtitles 16KiB 为初始估计，超出按既有流程显式上调并记录依据。

## Documentation / Operational Notes

- 版本 minor（0.16.0）；README 当前版本与版本说明、PRIVACY 生效版本同步。
- Bilibili（Phase 2）不在本期；ROADMAP 保留条目并注明依赖登录与接口风险。
- 接口细节（B 站）不在公开仓库文档化；YouTube timedtext 捕获策略属公开同行实践，可正常记录。

## Sources & References

- 调研留档：`docs/brainstorms/2026-10-07-video-subtitle-translation-research.md`（含全部来源 URL 与仓库文件路径）
- 关键仓库：Gythiro/yt-dual-subs、bakapiano/Youtube-TwinCue、rxliuli/bilingualtube、CoinkWang/Y2BDoubleSubs、IndieKKY/bilibili-subtitle、the1812/Bilibili-Evolved
- pot 门禁：jdepoix/youtube-transcript-api issue #592、prepublish.ai timedtext 实测、zemse/yt enforcement matrix
