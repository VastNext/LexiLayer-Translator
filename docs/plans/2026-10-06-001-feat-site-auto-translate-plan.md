---
title: 站内跳转自动延续翻译实施计划
type: feature-plan
status: draft
date: 2026-10-06
origin: 用户需求 + docs/ROADMAP.md「自动整站翻译」
---

# 站内跳转自动延续翻译实施计划

**Goal:** 用户在某个标签页发起页面翻译后，同一标签页内跳转到同域名页面时自动延续翻译，直到用户点击还原或关闭该标签页。

**Architecture:** 旗标完全由后台管理，零改动 content-main.js（仅剩 35B 余量）。页面控制器（content.js，余量充足）在翻译会话的进度上报中附带本次会话的命令参数（engineId/targetLanguage/scope/mode/expertId）；后台 `page-progress` 处理器在收到 `translating` 进度时把「标签页 + 域名 + 命令参数」写入 `chrome.storage.session` 的 `siteAutoTranslate` 旗标，收到 `idle`（还原）时清除；`tabs.onUpdated(status=complete)` 时若旗标存在、域名相同、`autoSiteTranslation` 偏好开启且 URL 未变过，则向该标签页重发与 Popup 完全相同的 `translate-page` 命令。SPA 路由变更不重载文档，动态观察器天然延续，无需触发。

**Tech Stack:** TypeScript、chrome.storage.session、chrome.tabs 事件、Vitest/JSDOM、Playwright、既有构建与预算门禁。

---

### Task 1：设置项 `autoSiteTranslation`（默认开启）

**Files:** Modify `src/shared/config.ts`、`src/options/OptionsApp.tsx`、`public/_locales/{zh_CN,en}/messages.json`、`src/shared/i18n.ts`、`tests/shared/config.test.ts`、`tests/ui/options.test.tsx`

1. ReadingPreferences 增加 `autoSiteTranslation: boolean`，默认 `true`；validate/normalize/import 迁移补齐。
2. 阅读偏好区块新增开关（防抖自动保存沿用现有模式）+ 中英文文案。
3. 定向测试：默认值、旧配置补齐、非法值拒绝、UI 开关保存。

### Task 2：后台旗标生命周期

**Files:** Modify `src/background/index.ts`、`tests/background/page-task-isolation.test.ts`（或新增 site session 测试）

1. `chrome.storage.session` 新键 `siteAutoTranslate`：`{ [tabId]: { host, params, lastUrl } }`；`tabs.onRemoved` 清理对应条目（`BackgroundChrome.tabs` 增 `onRemoved`/`onUpdated`）。
2. `page-progress` 处理器扩展：进度带 `siteCommand` 且状态非 idle → 以 sender 域名与净化后的命令参数（engineId/targetLanguage/scope/mode/expertId，only-keys + 安全值校验）写入旗标；`idle` → 清除。
3. `tabs.onUpdated(status==='complete')`：旗标存在 + `new URL(tab.url)` 为 http/https 且 hostname 与旗标相同 + 偏好开启 + `tab.url !== lastUrl` → `tabs.sendMessage(tabId, { type: 'translate-page', ...params })`，发送后更新 `lastUrl`；域名不符只跳过不清旗标（回到原域名仍延续）。发送失败静默忽略。

### Task 3：控制器附带命令参数

**Files:** Modify `src/content/index.ts`、`tests/content/controller.test.ts`

1. `ProgressState` 增加可选 `siteCommand`；`report()` 在会话命令存在且状态非 idle 时附带（仅翻译页命令；选词/输入框翻译不产生页面进度）。
2. 定向测试：translating 进度携带参数、还原 idle 不携带、选词路径不受影响、content-main 无改动（预算测试守护）。

### Task 4：E2E、文档与版本

**Files:** Modify `tests/e2e/extension.spec.ts` 或 mock-server 两侧页面夹具、`README.md`、`PRIVACY.md`、`docs/chrome-web-store/privacy-and-review.md`、`docs/ROADMAP.md`、`package.json`、`docs/release-notes/0.15.0.md`

1. E2E：mock 服务器提供同域名两页 + 链接；翻译第一页 → 点链接 → 第二页自动出现译文 → Popup 还原 → 再跳转不再翻译。
2. 文档：PRIVACY（chrome.storage.session 旗标仅存命令参数、同标签页同域名、不构成浏览历史）、商店披露（主动发起后的延续说明）、README、ROADMAP 移入已完成。
3. `npm version minor --no-git-tag-version` 到 0.15.0；全量门禁（test/typecheck/build/release:validate/e2e）后按发布流程合并打标签。

### 关键边界

- 新标签页打开链接（target=_blank/中键）不带旗标——旗标按标签页隔离。
- 旗标存 `chrome.storage.session`：浏览器关闭即清空，不写入 local/sync，不构成浏览历史。
- 偏好关闭时后台在触发点拦截，旗标留存但不生效。
- `content-main.js` 零改动；content.js 与 background 增量均在既有预算内。
