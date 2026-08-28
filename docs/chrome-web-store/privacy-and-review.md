# 隐私披露与审核测试说明

## Privacy Practices 填写原则

不要声明“完全不处理用户数据”。Vast Translator 不把数据上传到开发者自营服务器，但会在本地处理配置、API Key、网页文本和翻译缓存，并在用户主动翻译时向第三方翻译服务传输必要文本。

最终勾选项应以 Developer Dashboard 当时显示的字段为准。建议按以下事实填写。

## Dashboard 预填矩阵

下表是基于当前代码的预期选择。Chrome 可能调整字段名称和定义，创建商店项目后必须逐项对照当时的 Dashboard 文案复核，尤其是 Web history / browsing activity。

| Dashboard 项 | 预期选择 | 代码和数据依据 | 是否传给第三方 |
| --- | --- | --- | --- |
| Authentication information | 是 | 自定义 AI API Key | 仅传给用户选择的对应服务 Origin，用于授权 |
| Website content | 是 | 页面正文、选区文本、可选有限上下文 | 传给当前选择的 Google、Bing 或自定义 AI 服务 |
| Web history / browsing activity | 创建项目后最终确认；当前倾向按“处理当前网页上下文”如实披露 | 当前标签页 URL 用于消息路由、站点规则匹配和当前网页功能 | 不作为独立历史记录上传，不建立浏览历史 |
| User activity | 当前倾向否，需对照后台定义复核 | 只响应点击、快捷键、右键菜单和划词，不记录行为日志 | 否 |
| Remote code | 否 | 所有可执行逻辑都包含在 ZIP；远端只返回翻译数据 | 不适用 |

如果 Dashboard 对“处理”和“收集”作区分，应严格按其定义填写，不要因为数据没有进入开发者服务器就选择“无数据处理”。

## 数据类型建议

### Authentication information

- 是否处理：是
- 内容：用户为自定义 AI 填写的 API Key
- 存储位置：`chrome.storage.local`
- 传输对象：仅对应的用户配置服务 Origin
- 用途：请求授权
- 开发者是否接收：否
- 是否出售或用于广告：否

### Website content

- 是否处理：是
- 内容：用户主动要求翻译的网页文本、选区文本和可选有限邻近上下文
- 用途：提供页面翻译和划词翻译
- 传输对象：当前选择的 Google、Bing 或自定义 AI 服务
- 开发者是否接收：否，当前没有 Vast Translator 自营翻译服务器
- 是否出售或用于广告：否

### User activity / Web activity

扩展会在任意普通网页中提供用户可见的翻译功能，但不收集浏览历史。应在说明中明确：

- 当前 URL 仅用于判断网页上下文、匹配本地规则和向当前标签页发送翻译命令；
- 不建立访问历史；
- 不跨站关联行为；
- 不用于广告、分析或用户画像；
- 页面正文仅在用户主动翻译后处理。

URL 不会被汇总为访问历史，也不会用于分析或画像。但因为 `<all_urls>` 和当前标签页 URL 确实参与功能，最终是否勾选 Web history / browsing activity 必须以提交时 Dashboard 的定义为准，并保持后台说明、商店页面和隐私政策一致。

### Local configuration and cached results

- 翻译引擎配置、偏好和 API Key：`chrome.storage.local`
- 页面进度：`chrome.storage.session`
- 翻译结果缓存：扩展 IndexedDB，默认最多 30 天、5000 条
- 卸载扩展后由 Chrome 清除扩展本地数据

## 数据使用目的

只选择与以下目的直接对应的项目：

- 提供网页翻译；
- 提供划词翻译；
- 保存用户明确选择的偏好；
- 缓存翻译结果以减少重复请求；
- 维持当前浏览器会话的翻译状态；
- 保障请求安全和功能可靠性。

不要选择：

- 个性化广告；
- 非个性化广告；
- 信用评估；
- 数据转售；
- 与翻译无关的分析；
- 与核心功能无关的产品推荐。

## Limited Use 声明

提交前应把下面的中英文声明加入公开隐私政策。当前项目的 `PRIVACY.md` 还需要完成这项更新。

### 中文建议

```text
Vast Translator 对从 Chrome API 和 Google API 获得的信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。

相关数据仅用于提供和改进用户主动使用的网页翻译与划词翻译功能。Vast Translator 不会将这些数据用于个性化广告、信用评估、数据转售或其他无关用途，也不会允许人工读取用户翻译内容，除非用户明确授权、适用法律要求或安全调查确有必要。
```

### 英文建议

```text
Vast Translator's use of information received from Chrome APIs and Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

The information is used only to provide or improve user-initiated webpage and selection translation features. Vast Translator does not use this information for personalized advertising, credit assessment, resale, or unrelated purposes, and does not allow humans to read translated content unless explicitly authorized by the user, required by applicable law, or necessary for a security investigation.
```

## 第三方服务披露

公开隐私政策应链接或明确指向最终使用的第三方服务政策。至少包括：

- Google 相关服务隐私政策与适用条款；
- Microsoft/Bing 相关服务隐私政策与适用条款；
- 用户自行配置的第三方 AI 服务由用户选择，适用该服务自身条款。

发布者必须在提交前确认当前 Google/Bing 端点可合法用于公开分发。技术可用性测试不是服务许可证明。

## 审核测试说明

正式提交前应准备一个由发布者控制的公开 HTTPS 测试页，包含固定英文标题、段落、列表、动态内容和可供划词的句子。该页面必须无需登录、无需 Cookie 同意、无地区跳转，并可在审核网络环境中匿名访问。不要只依赖 `example.com` 作为最终审核页面。

### 英文版，可直接用于 Test instructions

```text
No account or test credentials are required to review the built-in translation flow.

1. Open the public Vast Translator review fixture: <PUBLIC_REVIEW_FIXTURE_URL>.
2. Click the Vast Translator toolbar icon.
3. Keep Google selected as the translation engine.
4. Choose Main content or Whole page.
5. Click Translate page. The translated text should appear directly on the webpage.
6. Use Restore in the popup to remove the inserted translations.
7. Select text on the page. Click the floating Vast Translator button to test selection translation.
8. Right-click selected text to test the Translate selection context-menu action.
9. Open the extension options page to inspect Bing and the optional custom OpenAI-compatible service configuration.

To verify the scripting permission:
10. Open <PUBLIC_REVIEW_FIXTURE_URL> before installing or reloading the extension.
11. Install or reload the extension, but do not refresh that already-open tab.
12. Use the toolbar popup to translate the old tab. The extension uses chrome.scripting.executeScript only to inject the packaged content.js into a normal webpage where the content script is not yet available.

Custom AI configuration is optional and is not required to review the core functionality. If a custom service is configured, its API key is stored only in chrome.storage.local and is sent only to the configured service for request authorization.

The extension does not require a user account and does not communicate with a developer-owned backend.

If the default third-party translation endpoint is temporarily unavailable or rate-limited, select Bing in the popup and retry. Before submission, the publisher must confirm that at least one no-credential review path is permitted, stable, and reachable from the review environment.
```

### 中文内部参考

```text
审核内置翻译流程不需要账号或测试凭据。

1. 打开发布者提供的公开审核测试页：<PUBLIC_REVIEW_FIXTURE_URL>。
2. 点击 Vast Translator 工具栏图标。
3. 保持 Google 为当前翻译引擎。
4. 选择“主要内容”或“整个页面”。
5. 点击“翻译当前页面”，译文应直接显示在网页中。
6. 在 Popup 中点击“恢复原文”，移除插入的译文。
7. 在页面中选择文字，点击悬浮的 Vast Translator 按钮测试划词翻译。
8. 右键点击选中文字，测试“翻译选中内容”菜单。
9. 打开扩展设置页，查看 Bing 和可选的 OpenAI 兼容自定义服务配置。

验证 `scripting` 权限：先打开审核测试页，再安装或重新加载扩展，但不要刷新已经打开的标签页；随后通过 Popup 翻译该旧标签页。扩展只会向普通网页注入上传包内自带的 `content.js`，不会下载远程代码。

自定义 AI 不是审核核心功能所必需。扩展不要求用户账号，也不连接开发者自营后端。

## 自定义 AI 无凭据审核路径

即使不向审核员提供真实 API Key，也应说明以下可观察行为：

- 空 Base URL 或无效 URL 不能作为可用实例；
- 非本机回环的 HTTP 地址会被拒绝，远程地址必须使用 HTTPS；
- 修改已保存实例的 Origin 后，旧 API Key 不会自动沿用；
- 配置导出文件不包含 API Key；
- 未配置自定义 AI 不影响 Google/Bing 核心路径。

如果首次商店文案把自定义 AI 作为主要卖点，应考虑在 Developer Dashboard 的测试凭据区域提供审核专用的低额度、可撤销凭据。凭据不得写入仓库、ZIP、截图或普通 Test instructions。

## 本机 HTTP 回环地址决策

当前产品允许 `http://localhost`、`http://127.0.0.1` 和 `http://[::1]`，用于连接本机 OpenAI 兼容服务。正式提交前需要对照当时 Chrome Web Store 对 Authentication information 安全传输的要求，做出并记录以下决定之一：

1. 商店版本保留回环 HTTP，但禁止向其发送非空 API Key；
2. 商店版本完全要求 HTTPS；
3. 取得足够合规依据后保留当前行为。

在该决定完成前，不应把“回环 HTTP 可用”当作已经通过合规确认的结论。
```

## 常见审核问题答复底稿

### 为什么需要访问所有网站？

```text
The extension's single purpose is translating webpages and selected text. Users expect this feature to work on the normal websites they visit. Access is used only to identify visible text after a user initiates page translation, detect explicitly selected text, and render the translation on the same page. Vast Translator does not collect browsing history or use page access for advertising, analytics, or profiling.
```

### 为什么需要向任意 HTTPS 地址发送请求？

```text
Users may optionally configure their own OpenAI-compatible translation service. Requests are sent only to a service explicitly created and selected by the user. Remote endpoints must use HTTPS; HTTP is restricted to loopback development services. The extension does not expose a generic fetch proxy to webpages.
```

### 是否包含远程代码？

```text
No. All executable extension logic is included in the submitted package. Remote services receive translation requests and return data only; their responses are never evaluated or executed as JavaScript.
```

### 开发者是否能读取翻译内容或 API Key？

```text
No. Vast Translator currently has no developer-owned backend. Translation content is sent directly from the extension service worker to the selected third-party service. Custom API keys remain in chrome.storage.local and are sent only to the corresponding configured origin for authorization.
```
