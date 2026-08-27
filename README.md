# Vast Translator

Vast Translator 是一款 Manifest V3 Chrome 扩展，通过用户自行配置的 OpenAI 兼容 API 提供网页双语翻译和划词翻译。插件采用暖白纸张与酸绿色荧光标注的原创视觉，默认只在用户主动翻译后扫描页面。

当前版本：`0.1.0`。

## 功能

- 网页主要内容或整个页面翻译
- 双语对照、仅译文两种显示模式
- 译文可放在原文之前或之后
- 划词 V 按钮与右键菜单翻译
- SSE 流式划词结果，失败时自动使用非流式回退
- 可见内容优先调度、动态节点翻译和原文变化重译
- OpenAI 兼容 API、模型与自定义翻译要求
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

## API 配置示例

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

## 权限理由

- `storage`：在浏览器本地保存 API 配置和用户偏好。API Key 不返回给 content script 或网页。
- `contextMenus`：提供“翻译页面”“恢复原文”和“翻译选中内容”菜单。
- `<all_urls>`：在用户访问的网页中运行 content script，并向用户配置的 OpenAI 兼容 API 发起请求。插件不会提供通用网络代理接口。

## 隐私

翻译时，用户主动选择的网页文本、目标语言、自定义翻译要求以及可选有限上下文会发送到用户配置的 API 服务。API Key 保存在 `chrome.storage.local`；页面进度保存在 `chrome.storage.session`；翻译缓存保存在扩展的 IndexedDB 中。配置导出不包含 API Key。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 安全限制

- 不要翻译密码、访问令牌、身份证件或其他敏感信息。
- 第三方 API 服务可能记录请求，使用前应阅读该服务的隐私政策。
- 扩展校验消息来源与 payload，但无法保证第三方模型输出正确。
- 网页结构变化可能导致少量内容漏译或布局不兼容，可使用“恢复原文”。
- API Key 使用权限和费用由用户自行管理。

## MVP 范围

0.1.0 聚焦网页与划词翻译、配置、安全消息边界、缓存和基础站点规则。当前不包含账号同步、云端配置、PDF 翻译、字幕翻译、术语库管理、自动整站翻译和 Chrome Web Store 发布流程。

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
```

测试覆盖 Manifest、构建资源、配置安全、消息白名单、API 客户端、SSE、缓存、调度器、动态页面、DOM 恢复、划词控制器、Popup 和 Options。
