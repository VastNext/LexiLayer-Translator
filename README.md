# Vast Translator

Vast Translator 是一款 Manifest V3 Chrome 扩展，通过内置翻译引擎或用户自行配置的 OpenAI 兼容 API 提供网页双语翻译和划词翻译。插件采用暖白纸张与酸绿色荧光标注的原创视觉，默认只在用户主动翻译后扫描页面。

当前版本：`0.4.2`。

## 功能

- 网页主要内容或整个页面翻译
- 双语对照、仅译文两种显示模式
- 译文可放在原文之前或之后
- 划词 V 按钮与右键菜单翻译
- Google 默认免费翻译、Bing 备用翻译，可启停并选择默认引擎
- 最多添加 20 个自定义 AI 实例，独立管理名称、Base URL、模型、API Key、启停、连接测试与排序
- 自定义 AI 支持 SSE 流式划词结果，失败时自动使用非流式回退；Google 和 Bing 返回单次结果
- 可见内容优先调度、动态节点翻译和原文变化重译
- OpenAI 兼容 API、模型与自定义翻译要求；自定义要求不作用于 Google/Bing
- 30 天、最多 5000 条的 IndexedDB 本地翻译缓存
- 简体中文和英文完整运行时界面本地化
- `Shift+Alt+A` 快捷切换当前页面翻译

支持的目标语言与程序内支持集合一致：自动判断、简体中文、繁体中文、英语、日语、韩语、法语、意大利语、德语、西班牙语、葡萄牙语、俄语和阿拉伯语。`auto` 会先解析为 Chrome 界面语言，再避开与网页源语言相同的目标。

## 开发

要求 Node.js 20 或更高版本。

```bash
npm install
npm test
npm run typecheck
npm run build
npm run e2e
```

项目使用 TypeScript、Vite、React 和 Vitest。Popup 与 Options 使用 React；content script 保持原生 TypeScript，以降低普通网页中的运行成本。

## 构建与加载

运行：

```bash
npm run build
```

构建结果位于 `dist/`。在 Chrome 中打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，然后选择 `dist/` 目录。

修改代码后重新运行构建，并在扩展管理页点击刷新。

## 引擎与 API 配置

Google 是首次安装的默认引擎，Bing 是备用引擎，两者都不需要用户提供 API Key。遇到 Google `429` 限流时，请稍后重试或切换到 Bing。内置服务能力依赖其公开接口，可能因服务策略变化而不可用。

Options 可保存多个自定义 AI。每个实例的 API Key 独立存储；编辑时 API Key 留空会保留同一实例、同一 Origin 的现有密钥。Base URL 的 Origin 变化会清除旧密钥，必须重新输入。连接测试只测试选定实例的固定翻译端点，不向网页提供通用网络代理。

OpenAI 官方兼容配置：

```text
Base URL: https://api.openai.com/v1
Model: gpt-4o-mini
API Key: sk-...
```

本机 OpenAI 兼容服务示例：

```text
Base URL: http://127.0.0.1:11434/v1
Model: your-model
API Key: 服务要求的值
```

远程服务必须使用 HTTPS。HTTP 仅允许 `localhost`、`127.0.0.1` 或 `::1` 本机回环地址。

## 架构

- `src/background/`：Manifest V3 service worker，负责消息白名单、API Key、请求、重试、批处理、流式协议、取消和缓存。
- `src/content/`：网页扫描、段落状态、可见优先调度、动态页面观察、DOM 渲染和划词浮层。
- `src/rules/`：原创站点规则目录与按需加载规则。
- `src/popup/`：当前页面翻译控制与进度。
- `src/options/`：API 连接、阅读偏好和本地数据管理。
- `src/shared/`：配置、语言、URL 和消息协议。

content script 初始只注册轻量消息与划词监听；站点规则详情、DOM 扫描和 MutationObserver 仅在首次页面翻译后启用。

## 0.3.0 迁移

首次读取旧版单一 OpenAI 配置时，扩展会迁移为一个 `迁移的自定义 AI` 实例，同时保留阅读偏好；默认引擎改为 Google。v2 配置导入导出支持内置项和多个自定义实例，但绝不导出 API Key。导入时只有 ID 和 Origin 都相同的本地实例会沿用本机密钥；重复 ID、保留 ID 伪装和含密钥文件会被拒绝。

## 0.4.0 更新

- 页面扫描改为通用可见文本叶与语义段落组合算法，提升 Angular、React、Vue 和 Web Component 页面覆盖。
- 支持按钮内部独立文本叶，覆盖现代 SPA 树形导航，同时继续排除图标、Ripple、焦点和触控辅助节点。
- 加强扩展重新加载后的 Content Script 生命周期处理，避免过期进度上报产生未处理错误。
- 增加 Chrome Web Store 上架资料、隐私披露模板、审核步骤和发布检查清单。
- 统一由 `package.json` 提供 Manifest 与 Options UI 版本号。

## 0.4.1 更新

- 扩展图标改为参考 VastNext 08 方案的白色三点 V 形星座，保留原蓝粉晚霞渐变底色。
- 划词悬浮按钮同步使用三点星座标记，保持扩展图标与页面交互入口一致。

## 0.4.2 更新

- Popup 与设置页的主题图标同步采用白色三点 V 形星座，底色继续随当前主题变化。

## 能力差异

- Google：默认、免费、无需配置；页面和划词翻译均为非流式，可能返回 `429`。
- Bing：备用、无需配置；页面和划词翻译均为非流式。
- 自定义 AI：支持多个实例、模型与自定义翻译要求；划词优先流式，连接质量、费用和数据处理规则由所选服务决定。

## 权限理由

- `storage`：在浏览器本地保存 API 配置和用户偏好。API Key 不返回给 content script 或网页。
- `contextMenus`：提供“翻译页面”“恢复原文”和“翻译选中内容”菜单。
- `<all_urls>`：在用户访问的网页中运行 content script，并向 Google、Bing 或用户配置的 OpenAI 兼容 API 发起请求。插件不会提供通用网络代理接口；Options 的连接测试也只探测候选翻译实例。

## 隐私

翻译时，用户主动选择的网页文本、目标语言以及可选有限上下文会发送到当前引擎的数据端点；自定义翻译要求只发送给自定义 AI。API Key 保存在 `chrome.storage.local`；页面进度保存在 `chrome.storage.session`；翻译缓存保存在扩展的 IndexedDB 中。配置导出不包含 API Key。具体端点见 [PRIVACY.md](./PRIVACY.md)。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 安全限制

- 不要翻译密码、访问令牌、身份证件或其他敏感信息。
- 第三方 API 服务可能记录请求，使用前应阅读该服务的隐私政策。
- 扩展校验消息来源与 payload，但无法保证第三方模型输出正确。
- 网页结构变化可能导致少量内容漏译或布局不兼容，可使用“恢复原文”。
- API Key 使用权限和费用由用户自行管理。

## MVP 范围

0.4.2 聚焦多引擎网页与划词翻译、安全的多实例配置、现代 SPA 文本覆盖、统一品牌图标和 Chrome Web Store 上架准备。当前不包含账号同步、云端配置、PDF 翻译、字幕翻译、术语库管理和自动整站翻译。

仓库中的闭源规则研究资料目录不纳入产品构建，也不应提交到版本库；发行版中的站点规则均为本项目原创实现。

## 测试

```bash
# 全量测试
npm test

# 类型检查
npm run typecheck

# 生产构建
npm run build

# 真实 Chromium 扩展端到端测试
npm run e2e

# 独立外网验证；代理参数仅用于测试，不进入插件设置
VAST_E2E_PROXY=http://127.0.0.1:7890 npm run e2e:network
```

测试覆盖 Manifest、构建资源、配置安全、消息白名单、API 客户端、SSE、缓存、调度器、动态页面、DOM 恢复、划词控制器、Popup 和 Options。
