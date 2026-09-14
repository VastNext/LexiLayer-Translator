# 语层翻译 LexiLayer Translator

<p align="center">
  <strong>让 AI 按语境、领域与风格理解网页。</strong><br>
  A browser translator that turns configurable AI prompts into domain-aware translation.
</p>

当前版本：`0.13.1`。

## 0.13.1 更新

- 修复表单内部说明性文本被硬编码排除的问题：允许翻译 `<form>` 容器内部的段落、说明、提示及列表文字（如 SaaSHub 等产品提交页面），同时持续排除输入框、按钮等交互控件。
- 优化 Popup 与大页面响应性：降低网页初载和大页面翻译期间的连续主线程占用，并将“页面接受翻译命令”与“翻译任务完成”解耦，减少点击扩展图标或控制页面时长时间无反馈的情况。

## 0.13.0 更新

- 新增输入框选区翻译：选中普通文本输入框、textarea 或 contenteditable 中的文字，按 `Alt+Shift+X`，使用当前引擎仅替换选中部分。
- 在设置的阅读偏好中独立选择“输入框目标语言”，默认英语，不跟随网页目标语言自动切换。旧配置和导入配置自动补齐默认值。
- 无需先翻译页面；只发送选中文字（最多 5000 字符），不附带输入框其余文字或邻近上下文。自定义 AI 沿用当前专家与翻译要求。
- 密码、只读、禁用控件不处理；中文输入法组合期间不触发，在途重复按键不重复请求。失败保留原文；等待期间内容、选区或焦点改变时放弃回填。
- 支持已获站点权限的普通网页和同源/跨源 HTTP(S) frame 内的独立选区；不支持跨 frame 选区、about:blank/srcdoc/data/blob frame、浏览器内部页和商店受限页。安装或更新后，已打开网页需刷新以加载新脚本。
- 支持可获取选区的 input 类型：text、search、url、tel。email/number 等无标准选区 API 的控件、Shadow DOM 编辑器、嵌套编辑器及包含不可编辑区域的选区不处理。复杂富文本框架可能拒绝合成输入事件；不保证其内部状态和撤销历史兼容，不承诺任意编辑器支持。

<p align="center">
  <a href="https://github.com/VastNext/LexiLayer-Translator"><img src="https://img.shields.io/badge/status-MVP-orange.svg" alt="MVP status"></a>
  <a href="https://github.com/VastNext/LexiLayer-Translator"><img src="https://img.shields.io/badge/Manifest-V3-4285F4.svg" alt="Manifest V3"></a>
  <a href="https://github.com/VastNext/LexiLayer-Translator"><img src="https://img.shields.io/badge/TypeScript-React-3178C6.svg" alt="TypeScript and React"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-VN--RSL--1.0-blue.svg" alt="License VN-RSL 1.0"></a>
  <a href="https://vastnext.com/lexi-layer/"><img src="https://img.shields.io/badge/website-vastnext.com-111827.svg" alt="VastNext website"></a>
</p>

## 语层是什么？

**语层（LexiLayer）** 是一款面向网页阅读的 Chrome 翻译扩展。它支持使用 Google、Bing 翻译网页和选中文字；配置 OpenAI 兼容的 AI 服务后，还可以通过预设的领域专家提示词或用户自定义提示词，实现更符合语境、术语和写作风格的 AI 翻译。

LexiLayer does more than replace words. It adds a translation layer to the web: choose Google or Bing for built-in translation, or connect your own OpenAI-compatible AI service and shape its translation behavior with domain-expert or custom prompts.

> 💡 **核心理念：** 翻译引擎负责“说另一种语言”，AI 专家提示词负责“理解这段内容应该怎样被翻译”。

## ✨ 主要能力

- 🌐 **网页翻译**：翻译网页主要内容或整个页面，并直接在当前页面显示结果。
- 📝 **双语阅读**：支持双语对照、仅译文，以及译文显示在原文之前或之后。
- 🔎 **划词翻译**：选择网页文字后，通过 V 形入口打开隔离的翻译面板。
- ⚡ **现代网页适配**：优先处理可见文本，支持 React、Vue、Angular、Web Component 和动态新增节点。
- 🧠 **AI 专家翻译**：配置 AI 后，可使用领域专家提示词或用户自定义提示词控制术语、语气、受众和格式。
- 🔌 **多引擎支持**：Google 默认翻译、Bing 备用翻译，并可添加最多 20 个 OpenAI 兼容 AI 实例。
- 🌊 **流式划词结果**：自定义 AI 划词翻译优先使用 SSE 流式响应，不支持时回退到非流式响应。
- 💾 **本地缓存**：使用 IndexedDB 保存成功译文，默认保留 30 天，最多 5000 条。
- 🌍 **多语言界面**：提供简体中文和英文运行时界面。
- ⌨️ **快捷键与触发方式**：页面翻译快捷键的建议默认值为 `Alt+A`，实际绑定以扩展设置页或浏览器快捷键管理页显示为准；选区内联翻译可配置修饰键与触发次数，新安装默认双击 `Ctrl`。

## 🧑‍🏫 AI 专家翻译

AI 翻译服务配置完成后，用户可以为不同阅读场景选择不同的翻译方式。例如：

- 💻 **技术文档专家**：保留 API、代码符号和工程术语，使用清晰准确的中文。
- 📚 **学术论文专家**：保持论证结构、限定语气和专业术语的一致性。
- ⚖️ **法律文本专家**：尽量保留条款结构、义务关系和法律表达的严谨性。
- 📰 **新闻编辑专家**：翻译成自然、简洁、适合中文读者阅读的新闻语言。
- 🎮 **本地化专家**：根据角色、界面长度和目标受众调整表达风格。
- ✍️ **自定义提示词**：由用户指定术语偏好、语气、受众、格式和特殊约束。

当前版本内置 29 个领域专家，并支持创建、编辑、启停和删除用户自定义专家。内置专家由 `VastNext/LexiLayerPrompts` 生成版本化离线快照，扩展运行时不会访问 GitHub。

## 🔧 翻译引擎

| 引擎 | 用途 | 特点 |
| --- | --- | --- |
| Google | 默认引擎 | 免费、无需 API Key、非流式响应 |
| Bing | 备用引擎 | 无需 API Key、非流式响应 |
| Custom AI | 专家级 AI 翻译 | OpenAI 兼容 API、模型和提示词可配置 |

Google 和 Bing 不会自动互相降级。用户可以在 Popup 或设置页中选择实际使用的引擎。自定义 AI 服务的质量、费用、可用性和数据处理规则取决于用户选择的服务商。
