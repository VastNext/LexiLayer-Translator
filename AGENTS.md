# Vast Translator — AI 开发指南

## 开始工作

先阅读本文件，再按任务读取相关资料：

- 产品范围、架构或重大功能：读取 `docs/plans/2026-08-27-vast-translator-design.md` 和 `docs/plans/2026-08-27-vast-translator-implementation.md`。
- Chrome Web Store、权限、隐私或发布：读取 `docs/chrome-web-store/README.md` 及其链接文档。
- 数据处理、第三方服务或 API Key：读取 `PRIVACY.md`。

## 产品边界

Vast Translator 是 Manifest V3 Chrome 网页与划词翻译扩展：Google 默认、Bing 备用，并支持多个用户配置的 OpenAI 兼容 AI 实例。

- 只在用户主动发起页面翻译后扫描正文；划词只处理用户主动选择的文本。
- 不运营接收翻译内容的自营服务器，不投放广告，不进行跨站追踪。
- API Key 只保存在 `chrome.storage.local`，不返回网页、不写入导出文件或错误消息。
- Google/Bing 不自动互相降级；用户选择哪个引擎就使用哪个引擎。
- DOM 扫描优先识别可见 Text Node 和语义段落。站点规则只做排除、范围和特殊例外，不按网站持续堆叠 class 白名单。
- `research/private-reference/` 是被 Git 忽略的闭源研究资料。不得复制、提交或据此复刻专有规则。

## 代码地图

- `src/background/`：消息白名单、引擎客户端、重试、批处理、缓存、取消和 API Key 边界。
- `src/content/`：DOM 扫描、动态页面、可见性调度、译文渲染和划词交互。
- `src/popup/`：当前标签页翻译控制、状态和按需脚本注入。
- `src/options/`：多引擎配置、密钥管理、偏好和数据管理。
- `src/rules/`：通用规则与八个原创站点规则。
- `src/shared/`：配置、语言、URL、消息和本地化工具。
- `tests/`：单元、集成、构建、E2E 和商店文档契约。

## 修改纪律

1. 先定位根因和现有测试，再做最小修改。
2. 修复 Bug 时先添加可稳定复现的回归测试。
3. 修改扫描器时至少验证普通文章、现代 SPA、交互控件、图标排除、父子去重和 1000 节点性能用例。
4. 修改 API、权限、数据流或存储时同步检查 `README.md`、`PRIVACY.md` 和 `docs/chrome-web-store/`。
5. 只提交本次任务文件；`dist/`、`node_modules/`、`test-results/`、日志、代理设置和秘密保持在版本库外。

## 版本规则

`package.json` 是版本唯一来源。Manifest 和 Options UI 必须从它读取版本，不得再次硬编码。

每次准备提交代码或用户可见发布资料时，执行 AI 必须主动判断并提升版本：

- `patch`：兼容性 Bug、稳定性或安全修复，以及不改变功能范围的小调整。
- `minor`：向后兼容的新功能、明显能力扩展、重要 UI/交互改进或上架里程碑。
- `major`：破坏配置、行为或兼容性的变更。
- 仅修改内部测试、拼写或历史文档且不影响发布内容时，可以不提升版本。

使用以下命令更新 `package.json` 和 `package-lock.json`，不要创建 npm Git tag：

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

提升后同步更新：

- `README.md` 的当前版本和对应版本说明；
- `PRIVACY.md` 的生效版本（数据行为或正式发布内容变化时）；
- 当前版本相关的发布文档和测试期望。

完成标准：`package.json`、`package-lock.json`、生成的 Manifest、Options 显示和当前版本文档一致。

## 验证门禁

常规代码或发布文档变更至少运行：

```bash
npm test
npm run typecheck
npm run build
```

涉及真实扩展行为时再运行：

```bash
npm run e2e
```

涉及 Google/Bing 网络或 SwitchyOmega 时，使用项目既有 E2E 环境变量运行对应网络测试；代理仅用于测试，不进入产品设置。

构建预算：

- `content.js < 38 KiB`
- `background.js < 32 KiB`

只有验证通过后才提交；提交前检查 `git status`、`git diff`、`git diff --check` 和近期提交，只暂存本次任务文件。验证通过后提交并推送当前分支。

## 当前发布提醒

Chrome Web Store 尚未正式提交。正式上架前必须解决 `docs/chrome-web-store/README.md` 中列出的阻断项，尤其是公开隐私政策、Limited Use、审核测试页、素材和 Google/Bing 端点公开分发许可。
