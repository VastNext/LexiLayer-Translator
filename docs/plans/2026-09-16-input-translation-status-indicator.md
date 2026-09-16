# 输入框快捷翻译状态提示实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 `Alt+Shift+X` 输入框选区翻译提供就近、非侵入的翻译状态反馈，避免用户因无反馈重复触发。

**Architecture:** 在独立输入翻译内容脚本中维护单个 Shadow DOM 状态浮层，根据当前编辑控件的位置显示并自动选择上方或下方。状态生命周期跟随现有翻译任务：触发后显示“翻译中…”，成功、失败或取消后显示短暂终态并自动移除；重复快捷键复用当前状态且不创建新请求。

**Tech Stack:** TypeScript、DOM/Shadow DOM、Vitest/JSDOM、Playwright、Vite Manifest V3 构建。

---

### Task 1：用测试定义状态生命周期

**Files:**
- Modify: `tests/content/input-translation.test.ts`
- Modify: `tests/e2e/input-translation.spec.ts`

1. 添加触发后显示“翻译中…”且不修改输入值的失败测试。
2. 添加成功、失败、内容或选区变化取消后的终态测试。
3. 添加重复快捷键不重复请求、只维持一个状态浮层的测试。
4. 运行定向测试，确认新增断言先失败。

### Task 2：实现隔离状态浮层

**Files:**
- Modify: `src/content/input-translation.ts`

1. 创建固定定位、closed Shadow DOM 的单实例提示宿主。
2. 根据输入控件边界和视口空间，将提示放置在右上方或右下方。
3. 显示加载动画与“翻译中…”，成功后显示“翻译完成”，异常显示“翻译失败，原文已保留”，任务失效显示“翻译已取消”。
4. 终态短暂保留后自动清理；卸载监听器时同步清理浮层和计时器。
5. 运行定向单元及 E2E 测试。

### Task 3：版本、文档与发布验证

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `docs/release-notes/0.13.1.md`
- Modify as required: `PRIVACY.md`、`docs/chrome-web-store/*`

1. 使用 `npm version patch --no-git-tag-version` 提升到 `0.13.1`。
2. 更新当前版本、交互说明和发布说明；不改变数据处理声明。
3. 运行 `npm test`、`npm run typecheck`、`npm run build`、`npm run release:validate`、`npm run e2e`。
4. 检查 `git diff --check`、构建体积和工作区状态，提交并推送功能分支。

### Task 4：合并 main 并刷新本地 dist

1. 获取远端最新 `main`，合并并解决冲突，重新执行发布门禁。
2. 推送合并结果到远端 `main`。
3. 在 `D:/WorkDev/MyShare/VastTranslatorChromePlugin` 确认工作区干净，切换本地 `main` 并拉取远端最新提交。
4. 在该目录运行 `npm run build`。
5. 验证 `dist/manifest.json` 为 `0.13.1`、包含 `input-translation.js`，且该文件实际存在。
