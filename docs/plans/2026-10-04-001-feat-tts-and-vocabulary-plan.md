---
title: 朗读单词与生词本管理设计与实现计划
type: feature-plan
status: draft
date: 2026-10-04
origin: docs/ROADMAP.md（朗读单词、生词本管理）
---

# 朗读单词与生词本管理设计与实现计划

## Overview

为语层翻译新增两个相互衔接的学习辅助能力：

1. **朗读单词（TTS）**：在划词悬浮面板加入朗读按钮，朗读选中的原文；生词本条目同样提供朗读。
2. **生词本管理**：划词面板一键加入生词，记录单词所在的整句与出处；Options 新增生词本区块提供列表、搜索、删除、复习与导出；支持通过 AnkiConnect 推送到本机 Anki，以及 CSV/TSV 文件导出。

本计划给出共享技术基座（体积预算、消息通道、存储模型）与分单元实施路径。TTS 与加词按钮共享同一个划词动作插槽与新增内容脚本，因此合并为一份计划。

## Problem Frame

- 用户划词后只拿到译文，没有发音反馈；「朗读单词」补上外语学习的第一闭环。
- 用户读到生词时需要手动复制到第三方工具记录，且丢失了「这个词出现在哪句话、哪个页面」的语境。「生词本管理」把记录、语境和复习（Anki）都留在本地。
- 产品边界：不运营接收翻译内容的自营服务器、不做跨站追踪。两个功能都必须保持**纯本地**：TTS 用浏览器本机语音，生词数据存 `chrome.storage.local`，Anki 推送只发往用户本机回环地址。

## Requirements Trace

| 来源 | 需求 | 本计划覆盖 |
|---|---|---|
| ROADMAP「朗读单词」 | 为划词结果和生词提供发音朗读 | U2、U3、U6 |
| ROADMAP「生词本管理」 | 划词时一键加入生词 | U4、U5 |
| ROADMAP「生词本管理」 | 加词时尽量记录单词所在整句 | D5、U2、U5 |
| ROADMAP「生词本管理」 | 复习时关联展示当时的句子和出处 | U6（复习模式） |
| ROADMAP「生词本管理」 | 支持将所记单词同步到 Anki | D6、U7 |
| AGENTS.md | content.js < 38KiB、background.js < 32KiB | D2、D8（预算修订随实施执行） |
| AGENTS.md | API/权限/数据流变化同步 README、PRIVACY、chrome-web-store 文档 | U8 |
| PRIVACY.md | 远程服务必须 HTTPS，HTTP 只允许本机回环 | D6（AnkiConnect 落入回环例外） |

## Scope Boundaries

**In scope（v1）**

- 划词面板：朗读按钮、加入生词按钮（含重复加词反馈）。
- 生词数据：单词、整句、译文（当时悬浮面板有结果则存）、出处 URL 与页面标题、语言信息、时间戳。
- Options 生词本区块：列表、搜索、单条删除、清空（双击确认）、复习模式、JSON 导出/导入、CSV/TSV 导出。
- AnkiConnect 推送：连接测试、Basic/Cloze 两种笔记模板、按 deck 去重、结果统计（新增/跳过）。
- TTS 朗读：选词发音、面板关闭/再次点击时停止。

**Deferred to Follow-Up Work**

- 朗读偏好（语速、首选拉丁语系发音人）的设置 UI。
- 生词手动录入入口、编辑单条释义与标签。
- 浏览单词时自动高亮已收录生词。
- Anki 双向同步（删除回流）、AnkiDroid 直连、apkg 文件生成。
- 基于专家提示词的自动加词推荐。
- 大规模生词（万条级）的分页与虚拟滚动。

## Context & Research

### Relevant Code and Patterns

- **划词悬浮框**：`src/content/selection-view.ts`，closed Shadow DOM；底部 `.result-actions`（L89）现有 `↻ 重试`、`⧉ 复制`两个按钮，是加入朗读与加词按钮的自然插槽。`SelectionViewActions`（L13-17：`translate/copy/close`）与 `createSelectionController` 的 `actions`（L266-270）是扩展动作的既有接口。
- **划词上下文**：`selection-controller.ts` `rememberSelection()`（L156-172）已记录选区所在块级元素及其规范化文本（≤600 字符），但**没有句子级切分**，需要新逻辑。
- **消息白名单**：`src/background/index.ts` L39-46 `allowedTypes`；新增类型需在 `handle()`（L257）用 `hasOnlyKeys`/`isSafeString` 校验字段；写操作复用 `settingsMutationTypes`（L231-235）的串行队列模式。port 通道 `vast-selection-stream` 独立校验，不走白名单。
- **存储**：主配置在 `chrome.storage.local` 的 `translatorSettings`（`src/shared/config.ts`，`schemaVersion: 2`，validate/normalize/migrate/import/export 齐备）；缓存用 IndexedDB。生词本不应混入 `translatorSettings`（见 D4）。
- **Options**：`src/options/OptionsApp.tsx` 单页 + 锚点导航；数据管理区块已有「文件导入 + 两步内联确认导出 + 双击确认」模式（L319-333、L409-419、L708-712）；文件下载用 `src/options/index.tsx` 的 Blob helper；版本号从 `package.json` 导入。
- **内容脚本装配**：`content-main.js` 已通过 `globalThis.__vastInlineRenderer` 运行时挂接 `content-inline.js`，是「运行时全局握手」的既有先例。
- **体积现状**（0.13.3 构建实测，预算见 `tests/build/bundle-budget.test.ts`）：
  - `content-main.js` 37,567 B / 38 KiB（余量约 1.3 KiB）；
  - 三 content 脚本累计 51,754 B / 52 KiB（余量约 1.4 KiB）；
  - `background.js` 32,704 B / 32 KiB（**余量仅 64 B**）。
  - 结论：朗读+加词的划词侧逻辑（约 2.5–4 KiB）无法塞进现有余量，后台 Anki 客户端（约 2–3 KiB）更不可能；预算必须按 D2/D8 处理。

### Institutional Learnings

- 新注入脚本必须有自己的预算行（`bundle-budget.test.ts` 注释明示），不能在既有脚本下静默膨胀。
- 破坏性操作沿用「双击确认」，含敏感内容的导出沿用「两步内联确认」（API Key 先例）。
- E2E 用真实扩展 + closed Shadow DOM 的划词用例已存在（`tests/e2e/extension.spec.ts` L393/L441/L606），可扩展复用。

### External References

- AnkiConnect（Anki 桌面端插件，默认端点 `http://127.0.0.1:8765`，JSON-RPC 动作：`version`、`deckNames`、`createDeck`、`modelNames`、`addNotes`，`addNotes` 支持 `options.allowDuplicate:false` 与 `duplicateScope`）。来源见文末。
- Web Speech API：`speechSynthesis`/`SpeechSynthesisUtterance` 是页面级 API，无需任何权限；`voices` 异步加载（`voiceschanged` 事件）；Service Worker 中不可用。来源见文末。

## Key Technical Decisions

### D1. TTS 用页面级 `speechSynthesis`，不用 `chrome.tts`

- `chrome.tts` 需要 `tts` 权限，扩大 manifest 与商店审核面；`speechSynthesis` 无需权限，内容脚本与 Options 页面（都是 window 上下文）直接可用。
- 后台 Service Worker 不参与 TTS（该环境无此 API），朗读都在有 window 的上下文执行。
- 代价：无法用 `chrome.tts` 的引擎路由；对本功能（单词发音）无影响。

### D2. 新增内容脚本 `selection-features.js` 承载划词新动作

- 朗读与加词的实现（约 2.5–4 KiB）远超 content-main（1.3 KiB）与累计（1.4 KiB）余量。
- 新建 `src/content/selection-features.ts` → 构建 IIFE `selection-features.js`，暴露 `globalThis.__vastSelectionFeatures`；追加到 manifest 现有单条 content_scripts 的 `js` 数组尾部（保证注入顺序）。
- `content-main.js` 只保留少量接线：装配 selection controller 时，通过运行时全局查找 `__vastSelectionFeatures` 取得朗读/加词动作，缺失时优雅降级（面板仍显示原有按钮）。此模式与现有 `__vastInlineRenderer` 装配一致。
- 预算测试新增 `selection-features.js` 独立上限（建议 6 KiB）；既有四项与 52 KiB 累计预算不动（累计口径维持为页面翻译三脚本，新脚本单独约束，AGENTS.md 同步说明）。

### D3. 后台作为生词本唯一写者

- 内容脚本不直接写存储；加词走新消息 `save-vocabulary-entry`，后台校验、去重、写盘并返回结果（`created` / `duplicate`）。
- 新增白名单消息（均按 `hasOnlyKeys` 校验）：`save-vocabulary-entry`（content）、`get-vocabulary-entries`（仅扩展页 sender）、`delete-vocabulary-entry`、`clear-vocabulary`、`test-anki-connection`、`sync-vocabulary-anki`（后五者仅 Options）。
- 写操作复用后台串行写队列模式，避免 Options 删除与划词加词并发交错。

### D4. 生词本独立存储键，不并入 `translatorSettings`

- 新键 `chrome.storage.local` → `vocabularyBook`：`{ schemaVersion: 1, entries: VocabularyEntry[] }`。
- 配置导入导出（`exportSafeSettings`/`importSettings`）语义不变；生词是**用户数据**而非配置，走 Options 生词本区块自己的导出/导入，且导出含出处 URL 时给两步确认（沿用 API Key 导出先例）。
- 单条上限：word ≤ 120 字符、sentence ≤ 600 字符、translation ≤ 600 字符；条目数量不设硬上限（chrome.storage.local 默认 10MB，万条级约 10MB 边界，超限时写入报错并提示清理，v1 不做自动清理）。

条目模型：

```ts
interface VocabularyEntry {
  id: string;            // crypto.randomUUID()
  word: string;          // 用户选中的原文（trim）
  sentence: string;      // 单词所在整句（见 D5）
  translation?: string;  // 加词时面板已有译文则存
  sourceUrl: string;     // 出处页面 URL
  pageTitle?: string;
  sourceLanguage?: string; // 面板选择或启发式检测的语言
  targetLanguage: string;  // 加词时的目标语言
  createdAt: number;
  updatedAt: number;
}
```

### D5. 整句提取用启发式切分，带兜底

- `src/shared/sentence.ts`：`extractSentence(blockText, selectedText)` —— 按 `[.!?。！？；;]`（含后引号/空格跟随）切句，规范化空白后找包含选中词的句子；找不到或选中词跨句时，兜底取块文本 trim 后的前 200 字符。
- 选区落在 contenteditable/input 中时不记录（生词本面向阅读场景，且避免把表单内容写盘）。

### D6. Anki 同步 = 本机 AnkiConnect 推送 + 文件导出兜底

- 朗读/加词不涉及网络；Anki 推送由后台 Service Worker 发起（`<all_urls>` host 权限下 SW fetch 不受 CORS 限制，兼容 AnkiConnect 默认的来源白名单）。
- 端点默认 `http://127.0.0.1:8765`，设置中可改，但校验强制**仅回环**（`127.0.0.1` / `localhost` / `[::1]`）HTTP，维持 PRIVACY.md 的既有规则；不在产品中新增任何云端依赖。
- 流程：`version` 连通 → `deckNames` 校验，不存在则 `createDeck` → `addNotes`（`allowDuplicate:false`）→ 返回 `{added, skipped}`。deck 默认 `LexiLayer 生词本`，笔记模板二选一：Basic（正面=word，背面=sentence + translation + URL）或 Cloze（句中 `{{c1::word}}`，背面附 translation + URL）。
- Anki 未运行/未装插件的用户用 CSV/TSV 文件导出（复用 Blob 下载 helper），供 Anki 自行导入。不生成 apkg（zip+sqlite 成本过高）。

### D7. 重复加词语义 = 同词同句

- 规范化（trim；拉丁字母 casefold）后 `word` 与 `sentence` 均相同视为重复，返回 `duplicate` 并刷新 `updatedAt`；同词不同句允许并存（符合「句子语境」的记录意图）。

### D8. 体积预算修订随实施显式执行

- `background.js` 32 KiB → 40 KiB（64 B 余量无法容纳 Anki 客户端与六个消息处理器；改短而不是加预算会牺牲既有功能，评估后拒绝）。
- 同步更新 `tests/build/bundle-budget.test.ts` 与 `AGENTS.md` 验证门禁小节；在提交说明中引用本节作为依据。

## Open Questions

**Resolved During Planning**

- 朗读的是原文还是译文？→ 朗读**选中的原文**（学发音的主体）；译文朗读不做（Deferred）。
- 语音语言如何选？→ 启发式：CJK/假名/谚文/西里尔按文字范围映射，拉丁文字取浏览器默认语音；后续再提供首选发音人设置。
- 生词本放哪？→ 独立键 `vocabularyBook`（D4）。
- Anki 用什么方式？→ AnkiConnect 推送 + CSV/TSV 导出（D6）。

**Deferred to Implementation**

- Basic 与 Cloze 模板的字段格式化细节（HTML 转义、换行呈现）。
- Options 列表的排序键（createdAt 默认）与搜索匹配范围（word + sentence）。
- E2E 对 TTS 的断言深度（headless 环境语音可用性有限，见 Risks）。

## High-Level Technical Design

```
[划词面板 content-main]
   actions.translate/copy/close（现状）
   + actions.speak / actions.addVocabulary     ← 运行时查找 __vastSelectionFeatures
[selection-features.js]
   ├─ speak(word, lang)：speechSynthesis，重复点击=停止，面板关闭即取消
   └─ addVocabulary()：extractSentence() → save-vocabulary-entry → 按钮状态反馈
          │  (runtime message, 白名单)
          ▼
[background/index.ts]
   ├─ save-vocabulary-entry：校验 → 去重 → 写 vocabularyBook → created|duplicate
   ├─ get-vocabulary-entries / delete / clear（Options 读写）
   ├─ test-anki-connection：version 探测（仅回环端点）
   └─ sync-vocabulary-anki：deck 校验 → addNotes(allowDuplicate:false) → {added, skipped}
          ▼
[chrome.storage.local.vocabularyBook]   [AnkiConnect http://127.0.0.1:8765]

[Options 生词本区块]
   列表/搜索/删除/清空 · 复习模式（词→句子+出处） · 朗读
   JSON 导出/导入（URL 出现时两步确认） · CSV/TSV · Anki 同步与设置
```

设置扩展：`translatorSettings` 增加可选分组（`schemaVersion: 3` 迁移补默认值）：`vocabulary: { ankiEndpoint, ankiDeck, ankiNoteType: 'basic'|'cloze' }`。

## Implementation Units

执行遵循 TDD：每单元先写失败测试再实现；版本、发布门禁集中在 U8。

### U1. 体积与脚本基座

- **Goal**：为划词新动作建立独立脚本与预算，不碰现有余量。
- **Files**：Create `src/content/selection-features.ts`；Modify `src/manifest.ts`、`vite.config.ts`（buildClassicContentScript 注册）、`tests/build/bundle-budget.test.ts`、`AGENTS.md`。
- **Approach**：manifest 现有 content_scripts 条目 `js` 数组尾追加 `selection-features.js`；新 IIFE 暴露 `globalThis.__vastSelectionFeatures = { speak, addVocabulary }`（空实现占位）；预算测试加 `selection-features.js: 6KiB` 行；AGENTS.md 补充说明。background.js 32→40KiB 的预算修订也放在本单元一次改齐（D8）。
- **Tests**：预算测试更新后通过；manifest 契约测试确认五脚本注入顺序。

### U2. 共享模块：speech 与 sentence

- **Goal**：朗读与整句提取的纯函数层，集中测试。
- **Files**：Create `src/shared/speech.ts`、`src/shared/sentence.ts`；Create `tests/shared/speech.test.ts`、`tests/shared/sentence.test.ts`。
- **Approach**：`speech.ts` —— `listVoices()`（缓存 + `voiceschanged` 刷新）、`speakText(text, langHint)`（ utterance.lang 映射：CJK→zh-CN、假名→ja、谚文→ko、西里尔→ru、其他 unset；重复调用先 `speechSynthesis.cancel()`；`onend/onerror` 回调返回状态）、`stopSpeaking()`。`sentence.ts` 按 D5 实现，含中英混排、引号跟随、无标点长块兜底。
- **Tests**：jsdom mock `speechSynthesis` 覆盖切换/取消/voices 异步加载；切分覆盖中英、跨句选中、空块兜底。

### U3. 划词朗读按钮

- **Goal**：悬浮面板底部新增朗读按钮，点击朗读选中原文。
- **Files**：Modify `src/content/selection-view.ts`（`SelectionViewActions` 增 `speak()`；`.result-actions` 增按钮与 aria 状态）、`src/content/main.ts`（控制器 actions 接入 `__vastSelectionFeatures`，缺失则按钮不注册）、`src/content/selection-features.ts`（speak 实现接线）。
- **Approach**：按钮用 aria-pressed 反馈「朗读中/停止」；面板 `remove()` 时强制 `stopSpeaking()`；content-main 增量控制在 1 KiB 内。i18n 走既有 fallbackMessages 与 `_locales` 同步补键。
- **Tests**：`tests/content/selection-controller.test.ts` 扩展按钮渲染/aria/取消路径；E2E `tests/e2e/extension.spec.ts` 增加冒烟用例（点击无异常、状态翻转）。

### U4. 生词数据模型与后台消息

- **Goal**：生词本的存储与唯一写者。
- **Files**：Create `src/shared/vocabulary.ts`（模型、校验、规范化、去重键）、Create `src/background/vocabulary-storage.ts`；Modify `src/background/index.ts`（allowedTypes、handle 分支、串行写队列接入）。
- **Approach**：`save-vocabulary-entry` 校验字段与长度上限（URL 复用 `shared/url.ts` 安全校验），去重见 D7；`get-vocabulary-entries` 限制 Options/Popup 页面 sender；写操作进串行队列。`clear-vocabulary`、`delete-vocabulary-entry` 同理。
- **Tests**：`tests/background/vocabulary.test.ts` 覆盖校验拒绝、去重 created/duplicate、并发写串行化、恶意超长字段拒绝。

### U5. 划词加入生词按钮

- **Goal**：一键把当前选区写成生词条目并给即时反馈。
- **Files**：Modify `src/content/selection-features.ts`（addVocabulary：`extractSentence` + 组装 + 消息发送）、`src/content/selection-view.ts`（按钮态：默认/已加入/重复）、`src/content/main.ts`（传入面板已有的 translation 与 targetLanguage）。
- **Approach**：加词成功后按钮短暂变 `✓`；duplicate 显示「已在生词本」toast（复用 copy-toast）。失败时 toast 报错，不阻塞面板。
- **Tests**：content 单测覆盖成功/重复/失败/选区缺失；E2E 在划词后经真实扩展消息写入，断言 Options 可见（与 U6 联调）。

### U6. Options 生词本区块

- **Goal**：浏览、检索、复习与文件导出导入。
- **Files**：Modify `src/options/OptionsApp.tsx`（新锚点区块 `vocabulary-book`，位置置于 selection-preferences 之后）、Create `src/options/VocabularySection.tsx`、Modify `src/options/index.tsx`（下载 helper 复用）。
- **Approach**：列表字段（word / sentence 摘录 / 出处链接 / 日期 / 朗读 / 删除）；搜索框匹配 word+sentence；删除用双击确认、清空同现有模式；复习模式为简单顺序卡片（词 → 展开 sentence+translation+出处+speak）；JSON 导出在包含 URL 时走两步确认（D4）；CSV/TSV 导出固定列序并转义。
- **Tests**：`tests/ui/options.test.tsx` 扩展区块渲染、搜索、删除确认、导出导入合并（按 id 去重）、复习翻卡。

### U7. Anki 同步与设置

- **Goal**：本机 Anki 推送。
- **Files**：Modify `src/shared/config.ts`（`vocabulary` 设置组、schemaVersion 3 迁移、回环校验）、Create `src/background/anki-client.ts`；Modify `src/background/index.ts`（`test-anki-connection`、`sync-vocabulary-anki`）、`src/options/VocabularySection.tsx`（deck/noteType 设置、测试连接、同步按钮与结果统计）。
- **Approach**：D6 流程；字段格式化细节在实现期定稿（Open Questions）；端点非回环时连接测试直接报错；同步按钮禁用条件=空端点或空条目。
- **Tests**：mock fetch 覆盖连通失败、deck 创建、allowDuplicate 跳过、结果统计；config 迁移用例覆盖 v2→v3 与非法端点拒绝。

### U8. 文档、版本与发布门禁

- **Goal**：数据流与文档同步、可发布。
- **Files**：Modify `README.md`、`PRIVACY.md`（生效版本 + 新增：本地生词存储含出处 URL、朗读纯本机无网络、Anki 推送仅限本机回环端点、若用户在 Anki 开启 AnkiWeb 同步则笔记会随 Anki 自身同步到其云端且扩展不参与）、`docs/chrome-web-store/README.md`（数据披露补条目：同步到本机 Anki 应用）、`docs/ROADMAP.md`（完成后移入已完成）、`package.json`/`package-lock.json`、`docs/release-notes/0.14.0.md`。
- **Approach**：`npm version minor --no-git-tag-version` 到 0.14.0（两项均为新功能，合并发布一个 minor）；若与 U7 拆开发布，则 0.14.0=TTS、0.15.0=生词本。
- **Gates**：`npm test`、`npm run typecheck`、`npm run build`、`npm run release:validate`、`npm run e2e`；提交前 `git status`/`git diff --check`。

依赖顺序：U1 → U2 →（U3、U4）→ U5 →（U6、U7）→ U8。

## System-Wide Impact

- **体积预算**：background.js 32→40 KiB、新增 selection-features.js 6 KiB；AGENTS.md 验证门禁小节同步修订。
- **权限**：manifest permissions 不新增（speechSynthesis 无需权限；AnkiConnect 走既有 `<all_urls>` host permission）。
- **隐私与商店文档**：PRIVACY.md 数据行为三处变化（本地生词存储、出处 URL 落盘、回环 Anki 推送）；chrome-web-store 文档的数据披露与划词说明补齐。
- **本地化**：新增运行时文案走 fallbackMessages + `_locales`（zh_CN/en）。
- **测试面**：新增 shared/background/content/ui 各层用例与 E2E 冒烟；bundle 契约测试更新。

## Risks & Dependencies

- **TTS 语音可用性**：headless/精简环境可能无语音包，E2E 只做冒烟（按钮存在、状态翻转、无异常），音频效果靠真机验收；`voiceschanged` 异步需单测覆盖。
- **content-main 余量紧**：接线代码必须克制（预算测试兜底），超出即触发拆分复盘而不是放宽预算。
- **AnkiConnect 依赖用户环境**：需桌面端 Anki 运行且装插件；文档写明连接测试入口与 CSV 兜底路径。
- **AnkiWeb 间接流出**：AnkiConnect 是本机 Anki 桌面应用内的插件（127.0.0.1 回环 HTTP 服务），扩展只与本机端点通信，数据不出设备；但若用户在自己的 Anki 中开启 AnkiWeb 云同步，推送的笔记会随 Anki 自身同步到 AnkiWeb 远端。该路径由用户的 Anki 配置决定，扩展不参与，但 PRIVACY 与商店数据披露需如实说明（见 U8）。
- **storage 写入超限**：条目极多时报错提示清理，v1 不自动清理（Deferred）。
- **background 预算上调先例**：以本计划 D8 为依据，实施提交说明中注明理由，防止后续无声膨胀。

## Documentation / Operational Notes

- 发布版本：minor（0.14.0）；README 当前版本与版本说明、PRIVACY.md 生效版本同步。
- Chrome Web Store 仍是既有阻断项流程，本功能不改变权限声明清单，但 Privacy Practices 数据描述需在 U8 一次补齐。

## Sources & References

- AnkiConnect：https://foosoft.net/projects/anki-connect/ （GitHub: FooSoft/anki-connect，`version`/`deckNames`/`createDeck`/`addNotes` 与 `allowDuplicate`/`duplicateScope` 参数）
- MDN SpeechSynthesis：https://developer.mozilla.org/docs/Web/API/SpeechSynthesis （含 `voices`/`voiceschanged`、无权限要求）
- MDN SpeechSynthesisUtterance：https://developer.mozilla.org/docs/Web/API/SpeechSynthesisUtterance
- 本仓库探索依据：`tests/build/bundle-budget.test.ts`、`src/content/selection-view.ts`、`src/content/selection-controller.ts`、`src/background/index.ts`、`src/shared/config.ts`、`src/options/OptionsApp.tsx`、`vite.config.ts`（行号以 0.13.3 工作区为准）
