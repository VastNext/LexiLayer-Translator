# 语层翻译（LexiLayer Translator）Chrome Web Store 上架准备

本文档包用于准备语层翻译（LexiLayer Translator）首次提交 Chrome Web Store。内容基于项目 `0.7.2`、Manifest V3、当前数据流和 2026-08-29 可查的 Chrome Web Store 官方要求整理。

> 重要：本文档是发布工作底稿，不构成法律意见。Trader/Non-Trader 身份、第三方接口许可和隐私合规应由发布者根据实际经营方式与适用法律确认。

## 文档导航

- [商店页面文案与权限理由](./store-listing.md)
- [隐私披露与审核测试说明](./privacy-and-review.md)
- [发布与更新检查清单](./release-checklist.md)

## 当前准备度

### 已具备

- Manifest V3
- 本地打包的扩展逻辑，无远程 JavaScript
- 16、32、48、128 像素扩展图标
- 简体中文与英文运行时本地化
- Popup、Options、Service Worker 与 Content Script
- Google、Bing 和多个自定义 AI 翻译引擎
- 本地 API Key、偏好、翻译缓存和会话进度存储
- 项目隐私说明 `PRIVACY.md`
- 单元、集成、构建和 Chromium E2E 测试

### 提交前必须完成

- [ ] 注册 Chrome Web Store 开发者账号并支付一次性注册费
- [ ] 验证发布者联系邮箱
- [ ] 准确声明 Trader 或 Non-Trader 身份
- [ ] 准备公开 HTTPS 产品主页、隐私政策 URL 和支持 URL
- [ ] 在公开隐私政策中加入 Chrome Web Store Limited Use 明确声明
- [ ] 最终确认 Google/Bing 端点用于公开分发时符合其服务条款
- [ ] 准备至少一张 1280×800 商店截图
- [ ] 准备 440×280 小型宣传图
- [ ] 准备一个无需登录的公开 HTTPS 审核测试页
- [ ] 完成 Privacy Practices 中的数据类型与用途披露
- [ ] 生成根目录直接包含 `manifest.json` 的干净 ZIP
- [ ] 先以 Trusted Testers 或 Unlisted 范围提交审核

## 重点审核风险

### 1. `<all_urls>`

扩展需要在任意普通网页中提供页面翻译、动态内容翻译和划词翻译，因此 Content Script 匹配 `<all_urls>`。商店页面必须突出说明：

- 网页文本处理是用户可见的核心功能；
- 页面正文只在用户主动发起页面翻译后扫描；
- 划词翻译只处理用户主动选择的文本；
- 不保存浏览历史、不建立用户画像、不进行跨站追踪；
- 不向语层翻译（LexiLayer Translator）自营服务器上传数据，因为当前没有此类服务器。

### 2. `scripting`

该权限当前确有用途：当某个标签页没有可用的 Content Script 时，Popup 会通过 `chrome.scripting.executeScript` 注入 `content.js`，随后再发送翻译命令。因此不能在不改变产品行为的情况下直接删除。

### 3. 用户指定的自定义 AI 地址

扩展允许用户配置 OpenAI 兼容 Base URL。隐私披露必须说明：

- 文本、语言、模型、自定义要求和可选有限上下文会发送到用户选择的服务；
- API Key 只发送给对应实例的 Origin；
- 远程服务必须使用 HTTPS，HTTP 只允许本机回环地址；
- 第三方服务的数据保留和费用由其自身条款决定。

### 4. 内置 Google/Bing 端点

当前内置端点能通过测试不等同于获得长期公开分发许可。正式发布前应确认：

- 端点的公开使用条款；
- 是否允许第三方扩展直接调用；
- 是否存在调用量、品牌或归属声明要求；
- 是否需要改为具备明确许可的正式 API。

商店文案不得暗示语层翻译（LexiLayer Translator）得到 Google 或 Microsoft 的赞助、认证或背书。

## 推荐发布顺序

1. 完成权限、数据流和第三方服务条款审计。
2. 更新并公开隐私政策，加入 Limited Use 声明。
3. 建立产品主页、隐私政策页和支持页。
4. 使用当前 `0.7.2` 上架准备版本，并在后续改动时按 SemVer 主动提升版本。
5. 准备中英文商店文案和图片素材。
6. 运行完整发布门禁并生成 ZIP。
7. 注册开发者账号，完成邮箱与 Trader/Non-Trader 声明。
8. 创建新项目，填写 Store Listing、Privacy、Distribution 和 Test instructions。
9. 先提交 Trusted Testers 或 Unlisted 审核。
10. 审核通过后从商店实际安装，验证权限提示、初始配置、翻译和自动更新。
11. 确认无阻断问题后改为 Public。

## 官方资料

- [注册开发者账号](https://developer.chrome.com/docs/webstore/register)
- [设置开发者账号](https://developer.chrome.com/docs/webstore/set-up-account)
- [发布扩展](https://developer.chrome.com/docs/webstore/publish)
- [商店页面信息](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [图片素材规格](https://developer.chrome.com/docs/webstore/images)
- [开发者计划政策](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [权限政策](https://developer.chrome.com/docs/webstore/program-policies/permissions)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [审核流程](https://developer.chrome.com/docs/webstore/review-process)
- [Trader/Non-Trader 说明](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
