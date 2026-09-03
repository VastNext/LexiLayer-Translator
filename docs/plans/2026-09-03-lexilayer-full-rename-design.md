# LexiLayer 全面品牌重命名设计

## 背景

README 已将产品品牌改为“语层 LexiLayer Translator”，但源码、用户界面、本地化资源、商店资料、隐私文档、设计预览和部分工程标识仍使用 Vast Translator。此次采用方案 B，完成一次全面品牌迁移。

## 命名规则

- 中文产品全称：语层翻译
- 中文界面简称：语层
- 英文产品全称：LexiLayer Translator
- 英文界面简称：LexiLayer
- GitHub 仓库：`VastNext/LexiLayer-Translator`
- npm 包名：`lexilayer-translator-chrome-plugin`
- 构建内部标识：统一使用 `LexiLayer` 或 `LexiLayerContent`

## 范围

同步修改以下内容：

- `package.json`、`package-lock.json` 的包名和版本信息
- Manifest、本地化资源、Popup、Options、划词面板和无障碍标签
- Vite 构建入口、构建插件名称、IIFE 全局名等工程标识
- README、PRIVACY 和 Chrome Web Store 发布资料
- 设计预览 HTML/JS/CSS 中的品牌名称和旧 Logo 标识
- 测试中的可见文本、构建产物和品牌契约断言
- 相关文件名中明确包含 `vast-translator` 的当前资源或文档

以下内容不迁移：

- Git 历史中的旧名称和旧提交内容
- 不属于当前产品的外部仓库名称或历史计划背景
- 不影响用户或工程标识的通用变量、CSS 类名和测试 fixture 名称

## 兼容与版本

这是用户可见的品牌和工程标识变更，不改变存储结构、消息协议、翻译 API 或权限。按照项目版本规则提升 patch 版本，并同步 `package-lock.json`、README 当前版本和发布资料中的版本期望。

## 验证

- 全仓搜索当前文件中的旧品牌和旧包名，确认只剩明确允许的历史背景
- 运行 `npm test`
- 运行 `npm run typecheck`
- 运行 `npm run build`
- 检查生成 Manifest、本地化名称、Popup/Options 文案和构建内部标识
- 运行 `npm run e2e` 验证扩展可见品牌和基本加载流程
