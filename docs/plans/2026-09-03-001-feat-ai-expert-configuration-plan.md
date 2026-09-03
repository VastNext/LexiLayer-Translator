---
title: AI 专家配置与安全导入导出
type: feat
status: active
date: 2026-09-03
---

# AI 专家配置与安全导入导出

## Overview

在现有多 AI 引擎基础上增加可启停的内置专家、自定义专家和按 AI 底座记忆的当前专家选择；同时修复配置导入后 API Key 缺失状态的表达，并提供明确的 API Key 导出选择。

## Problem Frame

当前插件已经有多 AI 底座，但没有独立的专家实体和专家选择状态。配置导入只恢复连接元数据时，Popup 将已存在的 AI 误显示为未设置，用户无法区分“元数据已导入”和“API Key 尚未导入”。专家提示词应只在用户选择 AI 底座且明确选择专家时参与请求；未选择专家时保持现有基础翻译方案。

## Requirements Trace

- R1. 设置页按“内置引擎 → 自定义 AI → AI 专家 → 阅读偏好”组织内容。
- R2. 自定义 AI 实例可折叠，且缺 API Key 状态可定位修复。
- R3. 内置专家来自 `VastNext/vast-expert-prompts` 的版本化构建快照，可启停。
- R4. 自定义专家支持插件生成 ID、名称、说明、系统提示词、启停、编辑和删除。
- R5. 一个 AI 底座可复用多个专家，一个专家可复用于多个 AI 底座；每个底座保存一个当前专家或空值。
- R6. Popup 仅在自定义 AI 下显示已启用专家；默认不选择专家，空值使用现有基础提示词。
- R7. 配置导出 API Key 前询问用户；用户确认后可导出，拒绝则不得写入 Key。
- R8. 配置导入允许含 API Key 的文件，可信文件中的密钥直接导入本地存储，不再重复询问。
- R9. API Key 不进入普通日志、content script、缓存键明文或错误消息；Google/Bing 不接收专家提示词。

## Scope Boundaries

- 本次不实现运行时远程更新；通过同步脚本从独立专家仓库生成稳定快照并打包。
- 本次不实现加密备份文件；API Key 导出仅在用户明确确认后写入 JSON 文件并显示安全警告。
- 本次不实现多个专家串联、专家组合收藏或站点自动选择专家。
- 本次不改变 Google/Bing 的提示词和自动降级策略。

## Key Technical Decisions

- 配置 schema 继续兼容旧 v2；缺失专家字段时补齐默认专家，缺失当前专家映射时补空对象。
- 自定义专家 ID 由插件基于时间/随机后缀生成，用户不可编辑，避免 ID 冲突和导入覆盖内置专家。
- 安全导出默认不含 API Key；Options 中用确认对话框决定是否生成带 Key 文件。
- 导入配置会直接恢复文件内 API Key；无密钥文件仍按同 ID、同 Origin 规则保留本地 Key。
- 当前专家映射以 `activeExpertByEngine[engineId]` 保存；无映射或映射指向禁用/不存在专家时按基础提示词执行。
- 专家提示词在后台合并到自定义 AI 请求的 system prompt 中，并纳入缓存身份/有效指令隔离；content script 只传 ID，不携带完整提示词目录。

## Implementation Units

- [ ] U1. **配置模型、专家目录与安全导入导出**

**Goal:** 建立稳定的专家实体、默认目录、自定义 ID 生成、schema 兼容和 API Key 确认式导入导出核心。

**Files:** `src/shared/experts.ts`, `src/shared/config.ts`, `src/options/api.ts`, `tests/shared/config.test.ts`, `tests/ui/options-api.test.ts`

**Test scenarios:** 默认专家目录存在；旧 v2 配置补齐专家；自定义专家 ID 自动生成且不覆盖内置 ID；无 Key 导入保留元数据；带 Key 导入恢复本地密钥；导出选择不包含 Key 时不出现 `apiKey`/真实密钥；导出选择包含 Key 时包含；取消导出不生成文件。

- [ ] U2. **后台专家协议与翻译数据流**

**Goal:** 将专家启停、CRUD、当前专家映射和专家提示词贯穿后台消息、网页翻译、划词翻译和缓存。

**Files:** `src/background/index.ts`, `src/shared/messages.ts`, `src/content/index.ts`, `src/content/selection-controller.ts`, `src/background/cache.ts`, `tests/background/message-handler.test.ts`, `tests/background/multi-engine-controller.test.ts`, `tests/content/controller.test.ts`, `tests/content/selection-controller.test.ts`, `tests/background/cache.test.ts`

**Test scenarios:** 非 AI 引擎忽略专家；有效专家 ID 进入自定义 AI system prompt；未选择专家保持旧 prompt；禁用/不存在专家不能注入 prompt；网页、内联和 SSE 划词都使用底座当前专家；删除专家清理映射；切换专家改变缓存键；专家提示词不进入公开配置中的敏感字段；非法专家消息被拒绝。

- [ ] U3. **Options 专家管理与 AI 折叠布局**

**Goal:** 按静态稿实现章节顺序、折叠 AI 实例、紧凑专家网格、缺 Key 修复入口和导出三态选择 UI。

**Files:** `src/options/OptionsApp.tsx`, `src/ui.css`, `tests/ui/options.test.tsx`

**Test scenarios:** 导航和正文顺序一致；AI 实例可折叠且 aria-expanded 正确；单个实例展开不影响其他实例；缺 Key 实例显示状态并可定位；专家桌面端 2–3 列、窄屏降列；内置专家启停立即保存；自定义专家新增/编辑/删除；导出显示包含/不含/取消三个明确选择；导入带 Key 文件直接恢复密钥。

- [ ] U4. **Popup 专家选择与缺 Key 状态**

**Goal:** 仅在自定义 AI 下显示专家选择，记忆每个底座的选择，空值保持基础提示词，并准确表达配置已导入但 API Key 缺失。

**Files:** `src/popup/PopupApp.tsx`, `src/popup/api.ts`, `src/ui.css`, `tests/ui/popup.test.tsx`

**Test scenarios:** Google/Bing 不显示专家；自定义 AI 显示已启用专家；默认专家值为空而非强制第一项；切换专家保存对应 engineId/expertId；重新打开恢复映射；AI 缺 Key 显示明确原因和去设置入口；翻译按钮继续使用现有 `翻译 (Alt + A)`；切换专家后已翻译页面重译并带正确 ID。

- [ ] U5. **图标、文档、构建和端到端门禁**

**Goal:** 校验当前图标资源、版本文档、隐私披露、bundle 预算和真实扩展流程。

**Files:** `public/icons/icon-*.png`, `src/manifest.ts`, `README.md`, `PRIVACY.md`, `tests/build/manifest.test.ts`, `tests/build/production-build.test.ts`, `tests/build/bundle-budget.test.ts`, `tests/e2e/extension.spec.ts`

**Test scenarios:** PNG 与当前 SVG 视觉资源一致；构建 Manifest 引用完整；API Key 导入/导出 E2E；缺 Key Popup 状态；专家选择后网页翻译；同专家多底座复用；专家切换缓存隔离；content/background 体积预算满足。

## System-Wide Impact

- **Interaction graph:** Options → background storage → Popup public config → content translation/selection messages → provider system prompt。
- **Error propagation:** 导入拒绝、Key 缺失、专家无效和 provider 失败均转换为不泄露密钥的用户可读状态。
- **State lifecycle risks:** 删除专家、禁用专家、Origin 变化、导入覆盖和并发设置写入必须保持映射一致。
- **API surface parity:** 网页、Popup、划词、内联和 E2E fixture 都要同步可选 `expertId`。
- **Unchanged invariants:** API Key 默认不导出；Google/Bing 不接收专家；未选择专家继续使用基础翻译 prompt；content 不携带完整专家提示词。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 带 Key 配置文件被误分享 | 默认不导出；导出前强确认；UI 显示明显安全警告；文档说明风险 |
| 旧配置缺失新字段 | normalize/migrate 补齐默认专家和空映射，并保留现有偏好 |
| 专家目录扩大 bundle | content 只传 ID；必要时将目录拆为 options/background 按需资源；持续执行体积预算 |
| 删除或禁用当前专家导致请求非法 | 后台请求前重新校验 enabled；无效映射退回基础 prompt |
| Popup 与 Options 状态不同步 | 所有变更经 background 串行写入；Popup 每次打开重新读取 public config |

## Verification

完成标准：定向单元/集成测试通过；typecheck、build、E2E 通过；导入导出安全测试通过；图标资源与 Manifest 一致；bundle 预算恢复；Reviewer 对 diff 和证据无阻断问题。
