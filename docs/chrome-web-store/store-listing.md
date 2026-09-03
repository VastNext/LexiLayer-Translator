# 商店页面文案与权限理由

以下内容可作为 Chrome Web Store Developer Dashboard 的填写底稿。提交前应根据最终版本功能、隐私政策 URL、支持 URL 和第三方服务决定复核。

## 基本信息

### 中文名称

```text
语层翻译
```

### 英文名称

```text
LexiLayer Translator
```

不要在名称中堆叠 `Google Translate`、`Bing`、`ChatGPT`、`DeepL` 等第三方品牌关键词。

### 中文简短说明

```text
翻译网页与选中文字，支持双语对照、Google、Bing 和多个自定义 AI。
```

### 英文简短说明

```text
Translate webpages and selected text with bilingual display, Google, Bing, or your own AI services.
```

## 中文长描述

```text
语层翻译是一款专注于网页阅读的双语翻译扩展。它可以翻译网页主要内容、整个页面或用户主动选择的文本，并将译文直接显示在当前网页中。

主要功能
• 翻译网页主要内容或整个页面
• 双语对照和仅译文显示模式
• 译文可显示在原文之前或之后
• 划词翻译与右键菜单翻译
• Google 默认翻译、Bing 备用翻译
• 最多配置 20 个 OpenAI 兼容自定义 AI 实例
• 动态网页内容翻译和可见内容优先处理
• 本地翻译缓存与简体中文、英文界面

隐私与数据处理
语层翻译不创建用户账号，不投放广告，不进行跨站追踪，也不运营接收翻译内容的自营服务器。页面正文只在用户主动发起页面翻译后处理；划词翻译只处理用户主动选择的文本。

待翻译文本会发送到用户当前选择的 Google、Bing 或自定义 AI 服务。自定义 AI 的 API Key 保存在浏览器本地，只用于对应服务的请求授权。第三方服务可能按照自己的隐私政策、数据保留规则和费用规则处理请求。

语层翻译是独立产品，与 Google 或 Microsoft 不存在隶属、赞助、认证或背书关系。
```

## 英文长描述

```text
LexiLayer Translator is a bilingual translation extension designed for reading the web. It translates the main content of a webpage, the whole page, or text explicitly selected by the user, and displays translations directly on the current page.

Key features
• Translate main webpage content or the whole page
• Bilingual and translation-only display modes
• Place translations before or after the source text
• Selection translation and context-menu actions
• Google as the default engine and Bing as a backup engine
• Up to 20 custom OpenAI-compatible AI services
• Dynamic webpage translation and visible-content-first processing
• Local translation cache and Chinese/English user interfaces

Privacy and data handling
LexiLayer Translator does not create user accounts, serve advertisements, perform cross-site tracking, or operate a developer-owned server that receives translation content. Page text is processed only after the user initiates webpage translation. Selection translation processes only text explicitly selected by the user.

Text to be translated is sent to the currently selected Google, Bing, or custom AI service. Custom AI API keys are stored locally in the browser and are used only to authorize requests to the corresponding service. Third-party services may process requests according to their own privacy, retention, and billing policies.

LexiLayer Translator is an independent product and is not affiliated with, sponsored by, certified by, or endorsed by Google or Microsoft.
```

## 分类和语言

- 建议分类：`Productivity`（生产力工具）
- 默认商店语言：简体中文或英语，按主要目标用户选择
- 本地化页面：至少提供 `zh-CN` 与 `en`
- 成熟内容：否

## Single Purpose

### 中文

```text
翻译用户主动选择的文字或主动要求翻译的网页内容，并在当前网页中显示译文。
```

### 英文

```text
Translate user-selected text or user-requested webpage content and display the translation directly on the current webpage.
```

## 权限理由

### `storage`

中文：

```text
用于在浏览器本地保存翻译偏好、自定义翻译引擎配置、API Key、翻译缓存和当前浏览器会话中的页面翻译进度。API Key 不返回网页；配置导出默认不含密钥，只有用户明确确认后才会包含。
```

英文：

```text
Used to store translation preferences, custom translation service settings, API keys, translation cache, and per-session page translation progress locally in the browser. API keys are never returned to webpages or included in exported configuration files.
```

### `contextMenus`

中文：

```text
用于提供“翻译页面”“恢复原文”和“翻译选中内容”右键菜单，这是扩展的直接用户操作入口。
```

英文：

```text
Used to provide user-initiated context-menu actions for translating a page, restoring the source text, and translating selected text.
```

### `scripting`

中文：

```text
当用户在尚未加载 Content Script 的普通网页上点击翻译时，用于按需注入扩展自带的 content.js。扩展不会下载或执行远程代码。
```

英文：

```text
Used to inject the packaged content.js on demand when the user requests translation on a normal webpage where the content script is not yet available. The extension does not download or execute remote code.
```

### `<all_urls>` Host Permission

中文：

```text
语层翻译是通用网页翻译工具，需要读取用户主动要求翻译的当前网页可见文本，并在原网页中显示译文。该权限还允许 Service Worker 向内置翻译端点或用户明确配置的 OpenAI 兼容服务发送翻译请求。扩展不保存浏览历史、不建立用户画像、不进行跨站追踪，也不会在用户未发起翻译时上传页面正文。
```

英文：

```text
LexiLayer Translator is a general-purpose webpage translator. It needs access to visible text on the current webpage when the user requests translation and must display the translation on that same page. This permission also allows the service worker to send translation requests to built-in translation endpoints or an OpenAI-compatible service explicitly configured by the user. The extension does not retain browsing history, build user profiles, perform cross-site tracking, or upload page content before the user initiates translation.
```

## 首页与支持信息占位

提交前替换：

```text
Homepage URL: https://<正式域名>/lexilayer-translator
Privacy Policy URL: https://<正式域名>/lexilayer-translator/privacy
Support URL: https://<正式域名>/lexilayer-translator/support
Support email: <长期维护的支持邮箱>
```

如果暂时没有正式域名，可用公开 GitHub 仓库与 GitHub Pages 过渡，但正式产品页面和可验证域名更有利于建立发布者可信度。
