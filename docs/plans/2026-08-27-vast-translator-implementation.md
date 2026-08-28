# Vast Translator Chrome 插件实现计划

> **执行要求：** 使用 `superpowers:executing-plans` 按任务逐项实现。

**目标：** 构建 Google 默认、Bing 备用并支持多个自定义 AI 的高性能 Chrome 双语网页与划词翻译插件，当前发布版本为 0.3.0。

**架构：** Manifest V3 service worker 集中处理密钥、API、重试和缓存；原生 TypeScript content script 管理 DOM 翻译；React 仅用于 Popup 和设置页。站点规则采用原创、按域名懒加载的数据驱动结构。

**技术栈：** TypeScript、Vite、React、Chrome Extension APIs、Vitest、jsdom、Playwright。

**0.3.0 增量：** 设置模型保持 v2，并增加五套外观主题、可拖动且自动避让视口边缘的划词面板、可配置的选区内联翻译快捷键、划词悬浮按钮开关，以及导航/面包屑短文本覆盖。Options 通过安全 CRUD 管理最多 20 个自定义 AI，并只接收逐实例 `hasApiKey`。导入导出无任何密钥，同 ID 同 Origin 才合并本地 secret。Google/Bing 使用非流式能力，自定义 AI 划词支持流式；候选连接测试只探测指定端点，不开放代理能力。

---

### 任务 1：初始化工程和构建契约

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`vite.config.ts`
- 创建：`vitest.config.ts`
- 创建：`src/manifest.ts`
- 创建：`tests/build/manifest.test.ts`

**步骤：**
1. 先写 manifest 构建测试，断言 MV3、`<all_urls>`、设置页、Popup 和 `Shift+Alt+A`。
2. 运行测试并确认因模块缺失而失败。
3. 添加最小构建配置和 manifest 生成逻辑。
4. 运行定向测试并确认通过。

### 任务 2：配置模型、语言映射和安全导出

**文件：**
- 创建：`src/shared/config.ts`
- 创建：`src/shared/languages.ts`
- 创建：`src/shared/url.ts`
- 创建：`tests/shared/config.test.ts`
- 创建：`tests/shared/languages.test.ts`
- 创建：`tests/shared/url.test.ts`

**步骤：**
1. 先测试 Chrome UI 语言映射、Base URL 拼接、配置校验和排除密钥导出。
2. 确认测试以缺少实现失败。
3. 实现最小纯函数和配置类型。
4. 运行定向测试，确认边界与脱敏行为通过。

### 任务 3：AI 协议、批处理和重试

**文件：**
- 创建：`src/shared/messages.ts`
- 创建：`src/background/openai-client.ts`
- 创建：`src/background/batching.ts`
- 创建：`src/background/retry.ts`
- 创建：`tests/background/openai-client.test.ts`
- 创建：`tests/background/batching.test.ts`
- 创建：`tests/background/retry.test.ts`

**步骤：**
1. 先测试 8 段/6000 字符切批、ID JSON 响应校验、`response_format` 兼容回退、401/429/5xx 分类和 `Retry-After`。
2. 确认每组测试因实现缺失或行为缺失失败。
3. 实现固定翻译消息协议和最小 OpenAI Chat Completions 客户端。
4. 运行定向测试并保持无密钥日志。

### 任务 4：SSE 划词流

**文件：**
- 创建：`src/background/sse.ts`
- 创建：`tests/background/sse.test.ts`

**步骤：**
1. 先测试断包、多个 data 事件、`[DONE]`、错误 JSON 和 delta 累积。
2. 确认测试失败。
3. 实现增量 SSE parser 和非流式回退信号。
4. 运行定向测试并确认通过。

### 任务 5：缓存

**文件：**
- 创建：`src/background/cache.ts`
- 创建：`tests/background/cache.test.ts`

**步骤：**
1. 先测试稳定缓存键、提示词版本隔离、TTL、LRU 上限和失败不缓存。
2. 确认测试失败。
3. 实现 IndexedDB 适配接口和可测试的缓存策略核心。
4. 运行定向测试并确认通过。

### 任务 6：原创站点规则引擎

**文件：**
- 创建：`src/rules/types.ts`
- 创建：`src/rules/catalog.ts`
- 创建：`src/rules/general.ts`
- 创建：`src/rules/sites/*.ts`
- 创建：`src/content/rule-matcher.ts`
- 创建：`tests/content/rule-matcher.test.ts`

**步骤：**
1. 先测试 URL 匹配、排除、仅命中时加载详情和通用规则回退。
2. 确认测试失败。
3. 实现轻量目录和首批原创高频站点规则。
4. 运行测试，检查规则详情不进入未命中页面路径。

### 任务 7：DOM 提取、回填和恢复

**文件：**
- 创建：`src/content/dom-scanner.ts`
- 创建：`src/content/paragraph-store.ts`
- 创建：`src/content/dom-renderer.ts`
- 创建：`src/content/content.css`
- 创建：`tests/content/dom-scanner.test.ts`
- 创建：`tests/content/dom-renderer.test.ts`

**步骤：**
1. 先测试正文提取、排除交互/代码/隐藏元素、纯文本安全回填、双语/仅译文/恢复和旧版本结果丢弃。
2. 确认测试失败。
3. 实现段落实体与 wrapper 状态机。
4. 运行定向测试并确认源 DOM 可恢复。

### 任务 8：可见区域调度和动态页面

**文件：**
- 创建：`src/content/scheduler.ts`
- 创建：`src/content/dynamic-observer.ts`
- 创建：`tests/content/scheduler.test.ts`
- 创建：`tests/content/dynamic-observer.test.ts`

**步骤：**
1. 先测试可见优先、队列上限、Mutation 批量去重、插件节点忽略和原文变更失效。
2. 确认测试失败。
3. 实现 IntersectionObserver/MutationObserver 适配器。
4. 运行定向测试并确认不执行全页重复扫描。

### 任务 9：Service worker 编排

**文件：**
- 创建：`src/background/index.ts`
- 创建：`tests/background/message-handler.test.ts`

**步骤：**
1. 先测试消息白名单、sender 校验、配置缺失、API Key 不下发、任务取消和脱敏错误。
2. 确认测试失败。
3. 接入配置、客户端、缓存、菜单和命令监听。
4. 运行定向测试并确认不存在通用 fetch 消息。

### 任务 10：Content script 网页翻译闭环

**文件：**
- 创建：`src/content/index.ts`
- 创建：`tests/content/controller.test.ts`

**步骤：**
1. 先测试 translate/toggle/restore/retry 消息和进度状态。
2. 确认测试失败。
3. 连接规则、扫描、调度、后台消息和 DOM renderer。
4. 运行定向测试并确认 Popup 关闭不影响任务。

### 任务 11：划词翻译 UI

**文件：**
- 创建：`src/content/selection-controller.ts`
- 创建：`src/content/selection-view.ts`
- 创建：`tests/content/selection-controller.test.ts`

**步骤：**
1. 先测试普通选区、5000 字限制、输入框排除、上下文开关、外部点击/Escape 关闭和中止。
2. 确认测试失败。
3. 实现 V 形按钮与 Shadow DOM 浮层。
4. 运行定向测试，确认样式隔离和流式结果累积。

### 任务 12：Popup 与设置页

**文件：**
- 创建：`src/popup/*`
- 创建：`src/options/*`
- 创建：`tests/ui/popup.test.tsx`
- 创建：`tests/ui/options.test.tsx`

**步骤：**
1. 先测试 Popup 状态动作和设置保存、连接测试、无密钥导出、缓存清理。
2. 确认测试失败。
3. 用轻量 React 组件实现批准的信息架构和原创视觉。
4. 运行 UI 测试并检查 API Key 掩码。

### 任务 13：图标、本地化和文档

**文件：**
- 创建：`public/icons/*`
- 创建：`public/_locales/zh_CN/messages.json`
- 创建：`public/_locales/en/messages.json`
- 创建：`README.md`
- 创建：`PRIVACY.md`

**步骤：**
1. 添加原创 V 字双语图标和中英文文案。
2. 记录加载方法、权限原因、数据流和密钥风险。
3. 确认不添加许可证文件。
4. 运行构建并检查 manifest 本地化资源。

### 任务 14：浏览器集成与性能验证

**文件：**
- 创建：`tests/fixtures/*`
- 创建：`playwright.config.ts`
- 创建：`tests/e2e/*`

**步骤：**
1. 构建扩展并加载到 Chromium 持久上下文。
2. 用模拟 OpenAI 服务验证普通、流式、401、429、500、超时和非法 JSON。
3. 验证文章、列表、表格、SPA 新增节点、划词、Popup、设置、右键和 `Shift+Alt+A`。
4. 检查 bundle 大小、未启用时无 DOM 扫描，以及存储/日志/导出无 API Key。

### 任务 15：审查、提交和私有仓库推送

**文件：**
- 审查：所有已跟踪文件

**步骤：**
1. 运行类型检查、单元测试、构建、E2E 和敏感信息扫描。
2. 运行代码正确性、安全性、性能和简洁性审查，修复确认的问题。
3. 检查 `git status`、`git diff` 和待提交文件，确认 `research/private-reference/` 未跟踪。
4. 创建本地提交。
5. 使用 `gh repo create VastNext/VastTranslatorChromePlugin --private --source . --remote origin --push` 创建并推送私有仓库。
6. 检查远端默认分支和最终工作区状态。
