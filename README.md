# 语层翻译 LexiLayer Translator

<p align="center">
  <strong>让 AI 按语境、领域与风格理解网页。</strong><br>
  A browser translator that turns configurable AI prompts into domain-aware translation.
</p>

当前版本：`0.7.1`。

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
- ⌨️ **快捷操作**：使用 `Shift+Alt+A` 切换当前页面翻译状态。

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

## 🔐 隐私与安全

- 🛡️ 不创建用户账号，不投放广告，不进行跨站追踪。
- 👆 只有用户主动发起页面翻译后，扩展才会扫描正文。
- ✂️ 划词翻译只处理用户主动选择的文字。
- 🔑 API Key 仅保存在 `chrome.storage.local`，不会发送给网页或 content script。
- 📦 配置导出不包含 API Key，翻译缓存也不保存 API Key。
- 🚫 不运营接收翻译内容的自营服务器，也不提供网页可调用的通用网络代理。
- 🔒 远程自定义 API 必须使用 HTTPS；HTTP 仅允许本机回环地址。

翻译文本会发送到当前选择的 Google、Bing 或用户配置的 AI 服务。第三方服务可能按照自己的隐私政策、数据保留和费用规则处理请求。请勿翻译密码、访问令牌、支付信息、医疗记录、身份证件或其他敏感内容。

详细说明请阅读 [PRIVACY.md](./PRIVACY.md)。

## 🚀 开始使用

### 安装依赖

要求 Node.js 20 或更高版本。

```bash
npm install
```

### 运行检查

```bash
npm test
npm run typecheck
npm run build
```

更新并校验内置专家快照：

```bash
python -m pip install -r scripts/requirements-experts.txt
git clone https://github.com/VastNext/LexiLayerPrompts.git ../LexiLayerPrompts
npm run experts:sync -- --source "../LexiLayerPrompts"
npm run experts:check -- --source "../LexiLayerPrompts"
```

也可以通过 `VAST_EXPERT_PROMPTS_DIR` 指定专家仓库路径。

### 在 Chrome 中加载

1. 运行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择项目生成的 `dist/` 目录。

### 配置 AI 翻译

在扩展设置页添加一个 OpenAI 兼容的 AI 实例：

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

## 🏗️ 技术架构

- `src/background/`：Manifest V3 service worker，负责消息白名单、API Key、请求、重试、批处理、SSE、取消和缓存。
- `src/content/`：原生 TypeScript content script，负责 DOM 扫描、段落状态、可见优先调度、动态页面、DOM 渲染和划词交互。
- `src/rules/`：通用规则与原创站点规则，按域名按需加载。
- `src/popup/`：当前页面翻译控制、语言选择、显示模式和进度。
- `src/options/`：AI 实例、翻译偏好、连接测试、缓存和配置数据管理。
- `src/shared/`：配置、语言、URL、消息协议和本地化工具。

项目使用 TypeScript、Vite、React、Chrome Extension APIs、Vitest、jsdom 和 Playwright。Popup 与 Options 使用 React；content script 保持原生 TypeScript，以降低普通网页中的运行成本。

## 🧪 测试

```bash
# 全量单元与集成测试
npm test

# TypeScript 类型检查
npm run typecheck

# 生产构建
npm run build

# Chromium 扩展端到端测试
npm run e2e

# 独立外网验证，代理参数仅用于测试
VAST_E2E_PROXY=http://127.0.0.1:7890 npm run e2e:network
```

测试覆盖配置安全、语言映射、URL、消息白名单、批处理、API 客户端、SSE、缓存、DOM 扫描与恢复、动态页面、站点规则、Popup、Options 和真实 Chromium 扩展流程。

## 🗺️ 当前状态与路线

当前版本：`0.7.1` · MVP

- ✅ Google / Bing 网页与划词翻译
- ✅ 多个 OpenAI 兼容 AI 实例
- ✅ 自定义翻译要求与流式划词翻译
- ✅ 现代 SPA 可见文本和动态节点翻译
- ✅ 本地缓存、配置安全和中英文界面
- ✅ Chrome Web Store 上架资料与发布检查清单
- ✅ 29 个预设领域 AI 专家与版本化离线快照
- ✅ 用户自定义专家的新建、编辑、启停和删除
- ✅ 按 AI 底座保存当前专家选择

当前不包含账号同步、云端配置、PDF 翻译、字幕翻译、术语库管理和自动整站翻译。

## 0.7.1 更新

- 产品品牌更名为语层翻译（LexiLayer Translator），简称语层 / LexiLayer；扩展、文档与商店资料统一使用新名称。
- 更新隐私说明、Chrome Web Store 上架资料、设计预览与发布流程中的品牌名称和 Logo。

## 0.7.0 更新

- 内置专家迁移到独立的 `VastNext/vast-expert-prompts` 仓库，并记录上游 commit SHA 和 CC BY 4.0 归属说明。
- 提供 29 个按常用场景排序的内置专家，旧专家 ID 和启用状态会自动迁移。
- 新增用户自定义专家管理，保存后使用紧凑卡片展示，编辑时按需展开。
- 自定义专家支持启停、取消新建、编辑和删除确认；编辑与删除使用紧凑图标按钮。
- 配置导入导出增加 API Key 明确选择流程，并完善专家提示词缓存隔离和真实扩展测试。

## 📖 项目文档

- [产品与架构设计](./docs/plans/2026-08-27-lexilayer-translator-design.md)
- [实现计划](./docs/plans/2026-08-27-lexilayer-translator-implementation.md)
- [隐私说明](./PRIVACY.md)
- [Chrome Web Store 上架文档](./docs/chrome-web-store/README.md)

## 🌐 官方地址

- Website: https://vastnext.com/lexi-layer/
- Repository: https://github.com/VastNext/LexiLayer-Translator

## 📄 许可证

本项目基于 [VastNext Revenue-Share License (VN-RSL) 1.0](./LICENSE) 发布：

- ✅ 个人学习、教育和非商业用途：可免费使用、修改和再分发。
- 💼 商业用途（包括作为付费产品或服务分发、商业集成、营利性组织内部使用）：必须先与版权方签订书面分成协议。
- 🤝 商业合作与分成洽谈：请通过 [https://vastnext.com/lexi-layer/](https://vastnext.com/lexi-layer/) 或 [GitHub Issues](https://github.com/VastNext/LexiLayer-Translator/issues) 联系。

Google™、Bing™、Chrome™ 等名称与商标归其各自所有者所有；本项目与这些服务之间不存在隶属或背书关系。专家提示词内容遵循 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可，见 [public/EXPERTS-NOTICE.txt](./public/EXPERTS-NOTICE.txt)。

<p align="center">
  <sub>Built for a more readable web by VastNext.</sub>
</p>
